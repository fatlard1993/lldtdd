import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import { inspectModule } from "./inspect.ts";

export interface InferenceResult {
  method: string;
  confidence: "exact" | "camel" | "partial";
}

export interface ModuleInfo {
  exports: string[];
  api?: string;  // from __lld_api export if present
}

/** Whether the caller is allowed to load and run the module under test.
 *
 *  Importing a module runs its top-level code, so this is the boundary between commands that
 *  are supposed to execute the subject (`run`, `mutate`) and commands whose name promises they
 *  will only read it (`lint`, `suggest`). It defaults to false: a new caller that forgets to
 *  think about this gets the reading path, not the running one. */
export interface ExecutionOptions {
  execute?: boolean;
}

// Cached per (path, mode): the static scan sees a superset of names in some files and a subset in
// others, so a static answer must never be served to a caller that asked to execute, or vice versa.
const moduleCache = new Map<string, ModuleInfo>();

export async function getModuleInfo(
  modulePath: string,
  { execute = false }: ExecutionOptions = {}
): Promise<ModuleInfo> {
  if (!existsSync(modulePath)) return { exports: [] };
  const cacheKey = `${execute ? "run" : "read"}:${modulePath}`;
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey)!;

  // Executing falls back to reading when the inspection fails. A DOM component module throws on
  // import outside a browser-ish environment, and without the fallback `--execute` would report
  // *fewer* exports than the default path -- an opt-in that asks for more and delivers less.
  const info = (execute ? await loadModuleInfo(modulePath) : null)
    ?? await readModuleInfo(modulePath);
  if (info) {
    moduleCache.set(cacheKey, info);
    return info;
  }
  return { exports: [] };
}

/** Imports the module -- top-level side effects run -- in a subprocess (see inspectModule), so a
 *  subject that exits, crashes, or tampers with the process at import cannot reach lldtdd itself.
 *  Only for callers that passed `execute`. Null when the module could not be inspected; the caller
 *  then falls back to reading the source. */
async function loadModuleInfo(modulePath: string): Promise<ModuleInfo | null> {
  const inspected = await inspectModule(modulePath);
  return inspected ? { exports: inspected.exports, api: inspected.api } : null;
}

/** Reads the same two facts off the source text. Nothing in the module runs.
 *
 *  Covers the four shapes that appear in practice -- `export function f`, `export const f = () =>`,
 *  `export { f }`, and a `__lld_api` string or template literal. A shape it cannot see becomes a
 *  missing export name, which costs a lint warning its precision; it never costs a false pass,
 *  because the runner still executes the real module when the suite runs. */
async function readModuleInfo(modulePath: string): Promise<ModuleInfo | null> {
  let source: string;
  try { source = await readFile(modulePath, "utf-8"); } catch { return null; }

  const isJs = /\.[cm]?js$/.test(modulePath);
  try {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
      compilerOptions: isJs ? { allowJs: true, checkJs: false } : {},
    });
    const sf = project.createSourceFile(isJs ? "module.js" : "module.ts", source);
    const exports = new Set<string>();

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (fn.isExported() && name) exports.add(name);
    }

    // Named classes count: `typeof MyError === "function"`, so the loading path lists them and the
    // reading path has to agree. Error subclasses are the common case, and a claim naming one
    // resolves through this list.
    //
    // A *default*-exported class does not: the loading path reads `Object.keys(mod)` and drops
    // `default`, so listing it here invented an export the other path never reports. That turned
    // the linter's stale-`**method:**` check on, against a list the module does not actually have,
    // and a group naming a static method of that class was reported as renamed.
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (cls.isExported() && !cls.isDefaultExport() && name) exports.add(name);
    }

    for (const stmt of sf.getVariableStatements()) {
      if (!stmt.isExported()) continue;
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init) continue;
        const kind = init.getKind();
        const isFunction =
          kind === SyntaxKind.ArrowFunction ||
          kind === SyntaxKind.FunctionExpression;
        if (isFunction) exports.add(decl.getName());
      }
    }

    for (const decl of sf.getExportDeclarations()) {
      for (const spec of decl.getNamedExports()) {
        exports.add(spec.getAliasNode()?.getText() ?? spec.getName());
      }
    }

    return {
      exports: [...exports].filter(name => name !== "default" && !name.startsWith("__")),
      api: readDeclaredApi(sf),
    };
  } catch {
    return null;
  }
}

function readDeclaredApi(sf: SourceFile): string | undefined {
  for (const stmt of sf.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      if (decl.getName() !== "__lld_api") continue;
      const init = decl.getInitializer();
      if (!init) continue;
      const literal = init.asKind(SyntaxKind.NoSubstitutionTemplateLiteral)
        ?? init.asKind(SyntaxKind.StringLiteral);
      if (literal) return literal.getLiteralText().trim();
    }
  }
  return undefined;
}

// Convenience: just the export names
export async function getModuleExports(
  modulePath: string,
  opts: ExecutionOptions = {}
): Promise<string[]> {
  return (await getModuleInfo(modulePath, opts)).exports;
}

// Try to match a group heading to an exported function name.
// Conservative -- only matches when confident. Returns null if uncertain.
export function matchGroupToExport(
  groupName: string,
  exports: string[]
): InferenceResult | null {
  if (exports.length === 0) return null;

  const name = groupName.trim();
  const words = name.split(/[\s_]+/).filter(Boolean);
  if (words.length === 0) return null;

  // 1. Exact: "parseBool" -> parseBool, "Login" -> login
  const slug = name.replace(/\s+/g, "").toLowerCase();
  const exact = exports.find(e => e.toLowerCase() === slug);
  if (exact) return { method: exact, confidence: "exact" };

  // 2. Standard camelCase: "Token validation" -> tokenValidation
  const camel =
    words[0].toLowerCase() +
    words.slice(1).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  if (exports.includes(camel)) return { method: camel, confidence: "camel" };

  // 3. Reversed camelCase: "Token validation" -> validateToken
  //    "Publishing" -> publish, "Subscribing" -> subscribe
  if (words.length >= 2) {
    // last word as verb stem + earlier as noun
    for (const verbForm of verbForms(words[words.length - 1])) {
      const noun = words
        .slice(0, -1)
        .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join("");
      const candidate = verbForm + noun;
      if (exports.includes(candidate)) return { method: candidate, confidence: "camel" };
    }

    // first word as verb stem + rest as noun
    for (const verbForm of verbForms(words[0])) {
      const noun = words
        .slice(1)
        .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join("");
      const candidate = verbForm + noun;
      if (exports.includes(candidate)) return { method: candidate, confidence: "camel" };
    }
  }

  // 4. Any single word in the group (exact or de-verbed) matches an export
  for (const word of words) {
    for (const form of verbForms(word)) {
      const match = exports.find(e => e.toLowerCase() === form);
      if (match) return { method: match, confidence: "partial" };
    }
  }

  return null;
}

// Generate candidate verb forms from a word: "publishing" -> ["publishing", "publish", "publishe"]
function verbForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms = [w];

  if (w.endsWith("ing")) {
    forms.push(w.slice(0, -3));        // "publishing" -> "publish"
    forms.push(w.slice(0, -3) + "e");  // "subscribing" -> "subscribe"
  }
  if (w.endsWith("ation")) {
    forms.push(w.slice(0, -5) + "ate"); // "validation" -> "validate"
  }
  if (w.endsWith("tion")) {
    forms.push(w.slice(0, -4) + "te");  // "creation" -> "create"
  }
  if (w.endsWith("al")) {
    forms.push(w.slice(0, -2)); // "removal" -> "remov" -- safe only if in exports
  }

  return forms;
}

export function clearModuleCache() {
  moduleCache.clear();
}

// ── __lld_api description matching ───────────────────────────────────
// Matches a group to an __lld_api method by scoring token overlap between
// the method's description and the combined group name + claim vocabulary.
// Uses 5-char stem prefix to bridge write/writes, order/ordering, etc.

const STOP = new Set([
  "a","an","the","is","not","to","of","and","or","in","at","by","for",
  "with","on","that","this","are","be","was","were","it","as","from",
  "has","have","do","does","did","when","if","only","all","any","no",
  "but","can","will","just","one","two","its","their","our","each",
  "after","then","same","new","true","false","null","set","result",
]);

// Dual-stem: emit both 4-char and 5-char prefixes so "read" and "reads",
// "order" and "ordering", "write" and "writes" all collapse to the same key.
function apiTokens(text: string): string[] {
  const raw = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of raw) {
    out.add(w.slice(0, 4));
    if (w.length >= 5) out.add(w.slice(0, 5));
  }
  return [...out];
}

export function matchGroupToApi(
  groupName: string,
  claims: string[],
  api: string,
  threshold = 0.35
): { method: string; description: string; score: number } | null {
  const sourceBag = new Set([
    ...apiTokens(groupName),
    ...claims.flatMap(c => apiTokens(c)),
  ]);
  if (sourceBag.size === 0) return null;

  let best: { method: string; description: string; score: number } | null = null;

  for (const line of api.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pipeIdx = trimmed.indexOf("|");
    if (pipeIdx === -1) continue;

    const methodName = trimmed.slice(0, pipeIdx).trim().split(/[\s(]/)[0];
    const description = trimmed.slice(pipeIdx + 1).trim();
    if (!methodName || !description) continue;

    const descTokens = apiTokens(description);
    if (descTokens.length === 0) continue;

    const overlapCount = descTokens.filter(t => sourceBag.has(t)).length;
    // F1 of precision (overlap/desc) and recall (overlap/source):
    // rewards specificity -- a short description that matches all its tokens scores lower
    // than a longer description that matches most of its tokens, because recall penalises
    // the short description's failure to cover the group vocabulary.
    const precision = overlapCount / descTokens.length;
    const recall    = overlapCount / sourceBag.size;
    const score     = precision + recall < 1e-9 ? 0 : 2 * precision * recall / (precision + recall);

    if (score >= threshold && (!best || score > best.score)) {
      best = { method: methodName, description, score };
    }
  }

  return best;
}
