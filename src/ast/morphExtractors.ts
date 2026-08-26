// ts-morph fact extraction stages: the parts of extraction that build a real TypeScript AST.
// Complexity metrics, the local call graph, signature-driven function classification (text
// transformers, structural comparators, function type chains), API generation from types/JSDoc,
// and type-level foreign-key detection.
//
// Every stage here degrades rather than fails: ts-morph may choke on complex TypeScript
// (import.meta, Bun APIs, pathological nesting), and a module it cannot parse still gets the
// regex-derived facts. The four classification stages record that fallback in the `degraded`
// collector they are handed, so downstream can tell "your claim is vague" from "our parser
// gave up" -- pure silence here made those indistinguishable.

import { Project, SyntaxKind } from "ts-morph";
import type { FunctionComplexity, TextTransformerFn, DegradedExtraction } from "./types.ts";
import { resolveReExportedSources } from "./moduleResolution.ts";

const reasonOf = (err: unknown): string => err instanceof Error ? err.message : String(err);

// ── Cyclomatic complexity ─────────────────────────────────────────────
// Counts branches: if/for/while/catch/case + &&/||/?? operators.

const BRANCH_KINDS = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.CaseClause,
]);

function cyclomaticComplexity(node: any): number {
  let n = 1; // base path
  node.forEachDescendant((child: any) => {
    const k = child.getKind();
    if (BRANCH_KINDS.has(k)) { n++; return; }
    if (k === SyntaxKind.BinaryExpression) {
      const op = child.getOperatorToken().getKind();
      if (op === SyntaxKind.AmpersandAmpersandToken ||
          op === SyntaxKind.BarBarToken ||
          op === SyntaxKind.QuestionQuestionToken) n++;
    }
  });
  return n;
}

export function extractComplexity(source: string, isJs: boolean): FunctionComplexity[] {
  if (source.length > 50_000) return []; // skip large files to avoid stack overflow
  try {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
  });
  const sf = project.createSourceFile(isJs ? "module.js" : "module.ts", source);
  const results: FunctionComplexity[] = [];
  const seen = new Set<string>();

  const add = (name: string, node: any) => {
    if (seen.has(name)) return;
    seen.add(name);
    const c = cyclomaticComplexity(node);
    results.push({
      name,
      complexity: c,
      mutationRisk: c > 8 ? "high" : c > 4 ? "medium" : "low",
    });
  };

  for (const fn of sf.getFunctions()) {
    if (fn.getName()) add(fn.getName()!, fn);
  }
  for (const v of sf.getVariableDeclarations()) {
    const stmt = v.getVariableStatement?.();
    if (!stmt?.isExported()) continue;
    const init = v.getInitializer?.();
    if (!init) continue;
    const k = init.getKind();
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) add(v.getName(), init);
  }

  return results.sort((a, b) => b.complexity - a.complexity);
  } catch { return []; }
}

// ── Local call graph ──────────────────────────────────────────────────
// For each exported function, list the other local functions it calls.
// Used to trace which exported function transitively performs a check
// (e.g. protocol validation in searchProvider, not in seedEngine).

export function buildLocalCallGraph(source: string, isJs: boolean): Record<string, string[]> {
  if (source.length > 50_000) return {}; // skip large files to avoid stack overflow
  try {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
  });
  const sf = project.createSourceFile(isJs ? "module.js" : "module.ts", source);

  // Collect all local function names
  const localNames = new Set<string>();
  for (const fn of sf.getFunctions()) { if (fn.getName()) localNames.add(fn.getName()!); }
  for (const v of sf.getVariableDeclarations()) localNames.add(v.getName());

  const graph: Record<string, string[]> = {};

  const analyse = (name: string, node: any) => {
    const body = node.getBody?.();
    if (!body) return;
    const callees = new Set<string>();
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      const text = expr.getText().split(".")[0]; // first segment
      if (localNames.has(text) && text !== name) callees.add(text);
    }
    if (callees.size > 0) graph[name] = [...callees];
  };

  for (const fn of sf.getFunctions()) {
    if (fn.getName()) analyse(fn.getName()!, fn);
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer?.();
    if (!init) continue;
    const k = init.getKind();
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) analyse(v.getName(), init);
  }

  return graph;
  } catch { return {}; }
}

// ── Text transformer detection ───────────────────────────────────────
// Finds exported (string, ...) → T functions by scanning for format tokens in the source.
// Format tokens are short string prefixes the module uses to recognize input lines
// (e.g. `startsWith("# ")` in a markdown parser). When tokens exist, a synthetic
// valid input string is built from them for use in generated test calls.

export function extractTextTransformerFunctions(
  source: string,
  isJs: boolean,
  degraded: DegradedExtraction[] = []
): Record<string, TextTransformerFn> {
  // Find format-token markers (short startsWith patterns with punctuation prefix)
  const rawTokens = [...source.matchAll(/\.startsWith\(["']([^"']{1,4})["']\)/g)].map(m => m[1]);
  const tokens = [...new Set(rawTokens)].filter(t => /^[#>*\-!]/.test(t));

  // No real format-token evidence (no `.startsWith('#')`-style markers anywhere in the
  // module) -- the module isn't parsing a structured text format, so no exported function in
  // it should be classified as a text transformer. Without this gate, ANY exported function
  // taking a string first-argument and returning a non-primitive (i.e. most functions with a
  // string-in/object-out shape, a very common signature with nothing to do with text parsing)
  // was misclassified -- confirmed concretely: compareSourcesForDrift(beforeSource: string, ...)
  // in drift.ts got auto-described as "parses structured text input into a document object",
  // which then silently won over the real claim-vocabulary pattern for it.
  if (tokens.length === 0) return {};

  const syntheticInput = buildSyntheticDocInput(tokens);

  const result: Record<string, TextTransformerFn> = {};
  try {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true,
      compilerOptions: isJs ? { allowJs: true, checkJs: false } : {} });
    const sf = project.createSourceFile(isJs ? "m.js" : "m.ts", source);
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const params = fn.getParameters();
      if (params.length === 0) continue;
      const firstType = params[0].getTypeNode()?.getText() ?? params[0].getType().getText();
      if (firstType !== "string") continue;
      const retType = fn.getReturnType().getText();
      if (/^(string|number|boolean|void|undefined|null)$/.test(retType)) continue;
      if (fn.isAsync() || retType.startsWith("Promise<")) continue;
      const name = fn.getName();
      if (!name) continue;
      const secondaryArgs = params.slice(1).map(p =>
        p.getType().getText() === "string" ? "test.source" : ""
      );
      const returnsArray = retType.includes("[]") || retType.startsWith("Array<");
      result[name] = { syntheticInput, secondaryArgs, returnsArray };
    }
  } catch (err) {
    // ts-morph may fail on complex TypeScript (import.meta, Bun APIs, etc.) -- falling back to
    // whatever was classified before the failure is deliberate, but not silent.
    degraded.push({ stage: "textTransformerFunctions", reason: reasonOf(err) });
  }
  return result;
}

function buildSyntheticDocInput(tokens: string[]): string {
  const lines: string[] = [];
  if (tokens.some(t => t.startsWith("# "))) lines.push("# Test Document");
  if (tokens.some(t => t.startsWith(">"))) lines.push("> src/test.ts");
  lines.push("");
  if (tokens.some(t => t.startsWith("## "))) lines.push("## Test Group");
  if (tokens.some(t => t.startsWith("- "))) lines.push("- a test assertion");
  return lines.join("\n");
}

// ── Structural comparator detection ──────────────────────────────────
// Finds exported (T, T) → U[] functions by inspecting TypeScript parameter types.
// When both params share the same `Record<string, InterfaceName>` type, the interface
// is read via ts-morph to synthesize before/after objects for generated test calls.

export function extractComparatorFunctions(
  source: string,
  isJs: boolean,
  degraded: DegradedExtraction[] = []
): Record<string, { realFunctionName: string; syntheticBefore: unknown; syntheticAfter: unknown }> {
  if (isJs) return {};
  const result: Record<string, { realFunctionName: string; syntheticBefore: unknown; syntheticAfter: unknown }> = {};
  try {
  const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
  const sf = project.createSourceFile("m.ts", source);

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const params = fn.getParameters();
    if (params.length < 2) continue;
    const t0 = params[0].getTypeNode()?.getText() ?? params[0].getType().getText();
    const t1 = params[1].getTypeNode()?.getText() ?? params[1].getType().getText();
    if (t0 !== t1) continue;
    const recordMatch = t0.match(/Record<string,\s*(\w+)>/);
    if (!recordMatch) continue;
    const innerType = recordMatch[1];
    const base = synthesizeInterface(innerType, sf);
    if (!base) continue;
    const name = fn.getName();
    if (!name) continue;

    // Structural: param added (before empty, after has one param)
    const withParam = { ...base };
    for (const [k, v] of Object.entries(base)) {
      if (Array.isArray(v)) { withParam[k] = [{ name: "a", type: "string", optional: false }]; break; }
    }
    result[name] = { realFunctionName: name, syntheticBefore: { fn: base }, syntheticAfter: { fn: withParam } };

    // No change: identical before/after → empty result
    result[`${name}NoChange`] = { realFunctionName: name, syntheticBefore: { fn: base }, syntheticAfter: { fn: base } };

    // Removed export: before has two functions, after has one
    result[`${name}RemovedExport`] = { realFunctionName: name,
      syntheticBefore: { fn: base, fn2: { ...base, name: "fn2" } },
      syntheticAfter:  { fn: base } };

    // Renamed export: before has "fn1", after has "fn2" → one REMOVED + one ADDED = 2 changes
    result[`${name}RenameExport`] = { realFunctionName: name,
      syntheticBefore: { fn1: { ...base, name: "fn1" } },
      syntheticAfter:  { fn2: { ...base, name: "fn2" } } };

    // Behavioral: guard removal (if the inner type has a guards field)
    if ("guards" in base) {
      const withGuard    = { ...base, guards: ["!a"] };
      const withoutGuard = { ...base, guards: [] };
      result[`${name}GuardRemoval`] = { realFunctionName: name,
        syntheticBefore: { fn: withGuard }, syntheticAfter: { fn: withoutGuard } };
    }

    // Behavioral: try/catch removal (if the inner type has hasTryCatch field)
    if ("hasTryCatch" in base) {
      const withTry    = { ...base, hasTryCatch: true };
      const withoutTry = { ...base, hasTryCatch: false };
      result[`${name}NoCatch`] = { realFunctionName: name,
        syntheticBefore: { fn: withTry }, syntheticAfter: { fn: withoutTry } };
    }
  }
  } catch (err) {
    // ts-morph may fail on complex TypeScript -- keep whatever classified cleanly, but record it.
    degraded.push({ stage: "comparatorFunctions", reason: reasonOf(err) });
  }
  return result;
}

function synthesizeInterface(interfaceName: string, sf: any): Record<string, unknown> | null {
  const iface = sf.getInterface(interfaceName);
  if (!iface) return null;
  const obj: Record<string, unknown> = {};
  for (const prop of iface.getProperties()) {
    const name = prop.getName();
    const t = prop.getType().getText();
    if (t === "string") obj[name] = name === "name" || name === "returnType" ? "fn"
      : name === "type" ? "string" : "test";
    else if (t === "boolean") obj[name] = false;
    else if (t === "number") obj[name] = 0;
    else if (t.includes("[]") || t.startsWith("Array<")) obj[name] = [];
    else if (t.startsWith("Record<")) obj[name] = {};
  }
  return Object.keys(obj).length > 0 ? obj : null;
}

// ── Function type chain detection ────────────────────────────────────
// Detects when fn2(T) can be set up by calling fn1(...) → T first.
// Uses source-level type node text so aliases like Promise<TestSuite> unwrap cleanly.

export function extractFunctionTypeChains(
  source: string,
  modulePath: string,
  isJs: boolean,
  degraded: DegradedExtraction[] = [],
  root: string = process.cwd()
): Record<string, { chain: string[]; rootTextTransformer?: { syntheticInput: string; secondaryArgs: string[] } }> {
  if (isJs) return {};
  try {
  const primitives = /^(string|number|boolean|void|null|undefined|unknown|any|never)/;

  // Collect function signatures from a source string
  const collectSignatures = (src: string) => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const sf = project.createSourceFile("m.ts", src);
    const producerOf = new Map<string, string>();
    const consumerOf = new Map<string, string>();
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const name = fn.getName();
      if (!name) continue;
      const retText = fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText();
      const unwrapped = retText.replace(/^Promise<(.+)>$/, "$1").trim();
      if (unwrapped && !primitives.test(unwrapped) && !unwrapped.includes("<")) {
        producerOf.set(unwrapped, name);
      }
      const params = fn.getParameters();
      if (params.length > 0) {
        const firstType = params[0].getTypeNode()?.getText();
        if (firstType && !primitives.test(firstType) && !firstType.includes("<")) {
          consumerOf.set(name, firstType);
        }
      }
    }
    return { producerOf, consumerOf };
  };

  const producerOf = new Map<string, string>();
  const consumerOf = new Map<string, string>();

  // Scan the module itself
  const own = collectSignatures(source);
  own.producerOf.forEach((v, k) => producerOf.set(k, v));
  own.consumerOf.forEach((v, k) => consumerOf.set(k, v));

  // Follow re-exports: `export { X } from "Y"` -- load Y and scan it
  const reExported = resolveReExportedSources(source, modulePath, root);
  for (const file of reExported) {
    try {
      const sigs = collectSignatures(file.text);
      // Merge consumerOf unconditionally
      sigs.consumerOf.forEach((v, k) => consumerOf.set(k, v));
      // Merge producerOf only when the function doesn't also CONSUME the same type
      // (avoids identity transformers like synthesize(T) → T being their own producer)
      sigs.producerOf.forEach((fnName, typeName) => {
        const alsoConsumes = sigs.consumerOf.get(fnName) === typeName;
        if (!alsoConsumes) producerOf.set(typeName, fnName);
      });
    } catch { /* skip unreadable */ }
  }

  // Build chains: fn's chain = producer's chain + producer
  // Also collect text transformer info for the root (first) function in each chain.
  // Root text transformer info is extracted from the imported source files.
  const rootTextTransformers = new Map<string, { syntheticInput: string; secondaryArgs: string[] }>();
  for (const file of reExported) {
    const ttFns = extractTextTransformerFunctions(file.text, false, degraded);
    for (const [name, info] of Object.entries(ttFns)) {
      rootTextTransformers.set(name, info);
    }
  }

  const chains: Record<string, { chain: string[]; rootTextTransformer?: { syntheticInput: string; secondaryArgs: string[] } }> = {};
  for (const [fnName, inputType] of consumerOf) {
    const producer = producerOf.get(inputType);
    if (producer && producer !== fnName) {
      const producerChain = chains[producer]?.chain ?? [];
      const fullChain = [...producerChain, producer];
      const rootFn = fullChain[0];
      const rootTT = rootTextTransformers.get(rootFn);
      chains[fnName] = { chain: fullChain, rootTextTransformer: rootTT };
    }
  }
  return chains;
  } catch (err) {
    // ts-morph may fail on complex TypeScript (import.meta, Bun APIs, etc.) -- no chains is the
    // deliberate fallback; the record is what lets downstream see the stage gave up.
    degraded.push({ stage: "functionTypeChains", reason: reasonOf(err) });
    return {};
  }
}

// ── API auto-generation from TypeScript types + JSDoc ─────────────────
// Reads exported function signatures and JSDoc to produce __lld_api entries.
// Each entry: "name(params) -> returnType | jsdocDescription"

export function generateApiFromTypes(source: string, isJs: boolean): string {
  try {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
      compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
    });
    const sf = project.createSourceFile(isJs ? "module.js" : "module.ts", source);
    const lines: string[] = [];

    const addEntry = (name: string, params: string, returnType: string, description: string) => {
      const rt = returnType.replace(/Promise<(.+)>/, "$1").replace(/\s+/g, " ").trim();
      lines.push(`  ${name}(${params}) -> ${rt || "void"} | ${description || name}`);
    };

    // Exported const arrow functions and regular functions
    for (const v of sf.getVariableDeclarations()) {
      const stmt = v.getVariableStatement();
      if (!stmt?.isExported()) continue;
      const name = v.getName();
      if (name.startsWith("_") || name === "__entityRegistry") continue;
      const init = v.getInitializer();
      if (!init) continue;
      const k = init.getKindName();
      if (k !== "ArrowFunction" && k !== "FunctionExpression") continue;

      const fn = init as any;
      const params = (fn.getParameters?.() ?? []).map((p: any) => p.getName()).join(", ");
      const retType = fn.getReturnType?.()?.getText(fn) ?? "unknown";
      const jsdoc = (v.getVariableStatement()?.getJsDocs?.() ?? []).map((d: any) => d.getDescription?.()?.trim()).filter(Boolean).join("; ");

      addEntry(name, params, retType, jsdoc);
    }

    for (const fn of sf.getFunctions()) {
      if (!fn.isExported() || !fn.getName()) continue;
      const name = fn.getName()!;
      const params = fn.getParameters().map(p => p.getName()).join(", ");
      const retType = fn.getReturnType().getText(fn);
      const jsdoc = fn.getJsDocs().map(d => d.getDescription()?.trim()).filter(Boolean).join("; ");
      addEntry(name, params, retType, jsdoc);
    }

    return lines.length ? lines.join("\n") : "";
  } catch {
    return "";
  }
}

// ── Improved FK detection using TypeScript types ───────────────────────
// Supplements hook-based detection with type-level analysis:
// "fieldName?: string" in an interface → potential FK if fieldName matches an entity

export function extractForeignKeysFromTypes(
  source: string,
  entityTypes: string[],
  isJs: boolean,
  degraded: DegradedExtraction[] = []
): Record<string, string> {
  const fks: Record<string, string> = {};
  try {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
      compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
    });
    const sf = project.createSourceFile(isJs ? "module.js" : "module.ts", source);

    for (const iface of sf.getInterfaces()) {
      for (const prop of iface.getProperties()) {
        const name = prop.getName();
        if (name === "id") continue;
        const type = prop.getType();
        const isOptionalString = type.isString() && prop.hasQuestionToken();
        if (!isOptionalString) continue;

        // Field is optional string -- check if it matches a known entity name
        const match = entityTypes.find(e =>
          name === e || name === e + "Id" || name === e.replace(/s$/, "") || name === e.replace(/s$/, "") + "Id"
        );
        if (match && !fks[name]) fks[name] = match;
      }
    }

    // Also read JSDoc @param tags for FK hints: "@param category - category id"
    for (const fn of sf.getFunctions()) {
      for (const doc of fn.getJsDocs()) {
        for (const tag of doc.getTags()) {
          if (tag.getTagName() !== "param") continue;
          const text = tag.getText().toLowerCase();
          const entity = entityTypes.find(e => text.includes(e) && (text.includes("id") || text.includes("ref")));
          if (entity) {
            const paramName = tag.getText().split(/\s+/)[1]?.replace(/[{}]/g, "");
            if (paramName && !fks[paramName]) fks[paramName] = entity;
          }
        }
      }
    }
  } catch (err) {
    // ts-morph unavailable for this source -- hook-derived FKs still stand, but record the gap.
    degraded.push({ stage: "foreignKeysFromTypes", reason: reasonOf(err) });
  }
  return fks;
}
