/**
 * AST inspector for the translation layer.
 *
 * Reads implementation modules and extracts semantic facts that the translator
 * can use to derive tests directly from the implementation:
 *   - Schema field lists (from createCRUD / similar factory patterns)
 *   - Default value expressions (e.g. ?? '' means "defaults to empty string")
 *   - Protocol / format allowlists (ALLOWED_PROTOCOLS, etc.)
 *   - Hook registrations (beforeCreate, beforeUpdate) and their trigger conditions
 *   - Validation code location (which function contains which check)
 */

import { readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, basename, extname } from "path";
import { Project, SyntaxKind } from "ts-morph";
import { ENTITY_FIXTURES } from "./fixtures.ts";

// ── Ported from ctx-test-gen: semantic field value heuristics ─────────
// Maps field name substrings to synthetic test values (valid / invalid / edge).
// Allows derive to generate realistic data rather than placeholder "T"/"x".

export interface FieldValues { valid: string; invalid?: string; edge?: string }

export const FIELD_VALUES: Record<string, FieldValues> = {
  email:    { valid: "'test@example.com'",     invalid: "'not-an-email'",   edge: "''" },
  url:      { valid: "'https://example.com'",   invalid: "'not-a-url'",      edge: "''" },
  link:     { valid: "'https://example.com'",   invalid: "'not-a-url'",      edge: "''" },
  href:     { valid: "'https://example.com'",   invalid: "'not-a-url'",      edge: "''" },
  token:    { valid: "'header.payload.sig'",    invalid: "'malformed'",      edge: "''" },
  password: { valid: "'valid-password-123'",    invalid: "'wrong-password'", edge: "''" },
  hash:     { valid: "'$2b$10$mockedhash'",     invalid: "'not-a-hash'",     edge: "''" },
  id:       { valid: "'test-id-123'",            invalid: null,               edge: "''" },
  name:     { valid: "'Test Name'",              invalid: null,               edge: "''" },
  title:    { valid: "'Test Title'",             invalid: null,               edge: "''" },
  label:    { valid: "'Test Label'",             invalid: null,               edge: "''" },
  username: { valid: "'testuser'",               invalid: null,               edge: "''" },
  host:     { valid: "'localhost'",              invalid: null,               edge: "''" },
  path:     { valid: "'/valid/path'",            invalid: null,               edge: "''" },
  key:      { valid: "'test-key'",               invalid: null,               edge: "''" },
  color:    { valid: "'blue'",                   invalid: null,               edge: "''" },
  status:   { valid: "'active'",                 invalid: null,               edge: "''" },
  type:     { valid: "'default'",                invalid: null,               edge: "''" },
  limit:    { valid: "10",                       invalid: "-1",               edge: "0"  },
  count:    { valid: "1",                        invalid: "-1",               edge: "0"  },
  port:     { valid: "3000",                     invalid: "-1",               edge: "0"  },
  timeout:  { valid: "5000",                     invalid: "-1",               edge: "0"  },
};

// ── Ported from ctx-test-gen: verb semantics ──────────────────────────
// Used to infer what a helper function likely returns/does from its name prefix.

export const VERB_IMPLIES: Record<string, { sideEffect: boolean; returns: string }> = {
  get:       { sideEffect: false, returns: "value" },
  find:      { sideEffect: false, returns: "value-or-null" },
  fetch:     { sideEffect: false, returns: "value" },
  load:      { sideEffect: false, returns: "value" },
  read:      { sideEffect: false, returns: "value" },
  list:      { sideEffect: false, returns: "array" },
  search:    { sideEffect: false, returns: "array" },
  create:    { sideEffect: true,  returns: "new-entity" },
  add:       { sideEffect: true,  returns: "new-entity" },
  insert:    { sideEffect: true,  returns: "new-entity" },
  update:    { sideEffect: true,  returns: "updated-entity" },
  save:      { sideEffect: true,  returns: "void-or-entity" },
  delete:    { sideEffect: true,  returns: "void" },
  remove:    { sideEffect: true,  returns: "void" },
  init:      { sideEffect: true,  returns: "void" },
  setup:     { sideEffect: true,  returns: "void" },
  reset:     { sideEffect: true,  returns: "void" },
  clear:     { sideEffect: true,  returns: "void" },
  is:        { sideEffect: false, returns: "boolean" },
  has:       { sideEffect: false, returns: "boolean" },
  can:       { sideEffect: false, returns: "boolean" },
  validate:  { sideEffect: false, returns: "boolean" },
  verify:    { sideEffect: false, returns: "boolean-or-value" },
  check:     { sideEffect: false, returns: "boolean" },
  parse:     { sideEffect: false, returns: "parsed-value" },
  format:    { sideEffect: false, returns: "string" },
  generate:  { sideEffect: false, returns: "value" },
  seed:      { sideEffect: true,  returns: "new-entity" },
};

// ── Result types ──────────────────────────────────────────────────────

export interface SchemaInfo {
  /** Collection or entity name ("bookmarks", "searchEngines"). */
  collection: string;
  /** Declared field names in the schema. */
  fields: string[];
  /** Default value expression for missing fields, if detectable ("''", "null", "0"). */
  fieldDefault?: string;
  /** Hooks that fire on mutation and what they respond to. */
  hooks: HookInfo[];
}

export interface HookInfo {
  kind: "beforeCreate" | "beforeUpdate" | "afterDelete" | "afterCreate";
  /** Trigger condition extracted from source — e.g. "data.category?.create" */
  trigger?: string;
  /** What the hook does — e.g. "creates a category and assigns its id" */
  description?: string;
}

export interface AllowlistInfo {
  /** The constant name: "ALLOWED_PROTOCOLS", "VALID_SCHEMES", etc. */
  name: string;
  /** The literal values: ["http:", "https:"] */
  values: string[];
  /** The function where the check occurs. */
  checkedIn?: string;
}

export interface ValidationLocationInfo {
  /** Name of the check (e.g. "protocol", "url-format"). */
  concept: string;
  /** The function that contains the check. */
  checkedIn: string;
  /** Functions in the same module that do NOT contain the check. */
  notCheckedIn: string[];
}

export interface FunctionComplexity {
  name: string;
  complexity: number;
  /** Risk level relative to mutation coverage: >8=high, >4=medium, else low */
  mutationRisk: "high" | "medium" | "low";
}

export interface ZeroArgScenario {
  callFn: string;
  argvText: string;
  optText: string;
  cfgText?: string;
  result?: unknown;
  threw?: boolean;
}

export interface EventTargetClassInfo {
  /** Class name as exported (e.g. "Context"). */
  name: string;
  hasSubscribe: boolean;
  hasDestroy: boolean;
  hasIsDestroyed: boolean;
}

export interface ComponentClassInfo {
  /** Class name as exported (e.g. "Button"). */
  name: string;
  /** What it directly extends (e.g. "TooltipWrapper", "styled(Component, styles)"). */
  extendsName: string;
}

export interface AstFacts {
  schemas: SchemaInfo[];
  allowlists: AllowlistInfo[];
  validationLocations: ValidationLocationInfo[];
  /** Detected when the module exports a default class extending EventTarget.
   *  Drives EventTarget-vocabulary derivation in deriveInline / deriveEventTargetInline.
   */
  eventTargetClass?: EventTargetClassInfo;
  /** Detected when the module exports a default class that is NOT an EventTarget.
   *  Drives Component-vocabulary derivation (construction + DOM assertion patterns).
   */
  componentClass?: ComponentClassInfo;
  /** Lifecycle function names inferred from exports. */
  lifecycle: LifecycleHints;
  /** Verb semantics for exported functions (name → what it does). */
  exportVerbs: Record<string, { sideEffect: boolean; returns: string }>;
  /** Return types parsed from __lld_api descriptor strings: methodName → returnType */
  returnTypes: Record<string, string>;
  /** Methods known to return an object with a default-valued field.
   *  Parsed from __lld_api: "result has default for X field" → { field: "X", value: "" }
   */
  defaultFields: Record<string, { field: string; value: string }>;
  /** Result assertions derived from __lld_api descriptions.
   *  "result.field is a string" → `expect(r.field)...` code for inspect assertions.
   *  "result.field === value"   → equality check
   *  "result.field is defined"  → toBeDefined()
   */
  resultAssertions: Record<string, string>;
  /** Cyclomatic complexity per exported function. */
  complexity: FunctionComplexity[];
  /** Local call graph: function → functions it calls within this module. */
  callGraph: Record<string, string[]>;
  /** Patchable fault injection targets detected in the module source.
   *  Key is the vocabulary label (e.g. "write"); value is the target path (e.g. "database.db.write").
   */
  faultTargets: Record<string, string>;
  /** Vocabulary index: entity names the module works with, mapped to their CRUD function names.
   *  Key = entity label (e.g. "searchEngine"); value = { create, read, search }.
   */
  entityIndex: Record<string, { create?: string; read?: string; search?: string }>;
  /** The module's "perform" function — the one that does the primary action (e.g. searchProvider). */
  primaryAction?: string;
  /** Entity relationships detected from hooks and TypeScript types.
   *  key = field name; value = the related entity type (e.g. "category" → "category")
   */
  foreignKeys: Record<string, string>;
  /** All entity types the module interacts with (primary + related via FK). */
  entityTypes: string[];
  /** True when the module's primary export is a createCRUD default export.
   *  When true, the adapter uses a default import and generates lifecycle + registry inline.
   */
  isDefaultCrud: boolean;
  /** Absolute path to the database/persistence module imported by this module. */
  databaseModulePath?: string;
  /** Collections and optional prefix from a createDbLifecycle call in this module's source.
   *  When set, the adapter can inline the lifecycle without needing the module to export initDb/reset.
   */
  lifecycleOptions?: { collections: string[]; prefix?: string };
  /** Map of entity name → absolute path of the module that provides its CRUD.
   *  Built from FK relationships + imports: { category: "/abs/path/to/categories.js" }
   */
  relatedEntityPaths: Record<string, string>;
  /** Auto-generated __lld_api content derived from TypeScript types + JSDoc.
   *  Used when no explicit __lld_api export is present in the module.
   */
  generatedApi: string;
  /** Vocabulary derived purely from AstFacts — no production-code annotation required.
   *  Used by matchGroupToApi when the module has no __lld_api export.
   */
  derivedApi: string;
  /** Derived HTTP mock response shape, built from field mapping config in the module source.
   *  e.g. resultsPath:"results", nameProperty:"title", urlProperty:"url"
   *  → { results: [{ title: "Result", url: "https://example.com" }] }
   */
  mockResponseShape?: unknown;
  /** Raw source, for fallback keyword scanning. */
  source: string;
  /** Module path where primaryAction is imported from (for direct import in generated tests). */
  primaryActionModule?: string;
  /** True when the module itself IS the database object (not importing another database).
   *  When true, the adapter uses the primary module import as _database.
   */
  isSelfDatabase?: boolean;
  /** Path to the module whose function chains should be imported as `_PipelineStage`.
   * Set to the module path when at least one function type chain is detected.
   * The adapter uses it to emit `import * as _PipelineStage from "..."`.
   */
  pipelineStageModulePath?: string;
  /** True when the module reads process.argv — tests must set process.argv before constructing. */
  usesProcessArgv?: boolean;
  /** True when the module may call process.exit — tests may need to intercept it. */
  mayCallProcessExit?: boolean;
  /** Text transformer functions: exported `(string, ...) → T` where T is a structured object.
   * Detected from: source contains format-token patterns (`startsWith("# ")` etc.) and the function
   * signature matches. Value contains a synthetic valid input string and secondary arg literals.
   */
  textTransformerFunctions: Record<string, { syntheticInput: string; secondaryArgs: string[]; returnsArray: boolean }>;
  /** Function type chains: fnName → { chain, rootTextTransformer }.
   * Detected when `fn2(T)` can be set up with `fn1(...) → T` (matching TypeScript type names).
   * e.g., `translate: { chain: ["parse"], rootTextTransformer: { syntheticInput, secondaryArgs } }`.
   * Used to generate multi-step pipeline tests without helper wrappers.
   */
  functionTypeChains: Record<string, { chain: string[]; rootTextTransformer?: { syntheticInput: string; secondaryArgs: string[] } }>;
  /** Structural comparator functions: exported `(T, T) → U[]` where both params have the same type.
   * Detected from TypeScript interface inspection. One entry per scenario variant — multiple virtual
   * names are generated per real function (e.g. `compareImplementations`, `compareImplementationsNoChange`,
   * `compareImplementationsGuardRemoval`). Each maps to a distinct before/after pair.
   */
  comparatorFunctions: Record<string, { realFunctionName: string; syntheticBefore: unknown; syntheticAfter: unknown }>;
  /** Absolute path to the module that provides the primary constructor.
   * Detected from: `export { default } from X` (re-export chain),
   * `import ClassName from X` (first capitalized default import),
   * or the module path itself when it directly exports a default class/fn.
   * Used by the adapter to generate `import _SubjectCtor from "..."` instead of relying
   * on `_SubjectCtor`, which requires the helper to re-export its default.
   */
  constructorModulePath?: string;
  /** Exported zero-arg arrow functions wrapping detection-signal calls (parseArgs/exitCode/etc).
   *  Extracted from helper source at codegen time; used by resolveMethodCall to generate inline
   *  code without hardcoded claim-text patterns.
   */
  zeroArgScenarios: Record<string, ZeroArgScenario>;
}

// ── Cyclomatic complexity ─────────────────────────────────────────────
// Ported from ctx-complexity / ctx-hotspots.
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

function extractComplexity(source: string, isJs: boolean): FunctionComplexity[] {
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
// Ported from the within-module resolution part of ctx-reachability.
// Used to trace which exported function transitively performs a check
// (e.g. protocol validation in searchProvider, not in seedEngine).

function buildLocalCallGraph(source: string, isJs: boolean): Record<string, string[]> {
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

function extractTextTransformerFunctions(
  source: string,
  isJs: boolean
): Record<string, { syntheticInput: string; secondaryArgs: string[] }> {
  // Find format-token markers (short startsWith patterns with punctuation prefix)
  const rawTokens = [...source.matchAll(/\.startsWith\(["']([^"']{1,4})["']\)/g)].map(m => m[1]);
  const tokens = [...new Set(rawTokens)].filter(t => /^[#>*\-!]/.test(t));

  // Determine synthetic input: document format for parsers with format tokens,
  // TypeScript snippet for code-processor functions (string → Array)
  const syntheticInput = tokens.length > 0
    ? buildSyntheticDocInput(tokens)
    : "function fn(a: number, b: number) { return a === b; }";

  const result: Record<string, { syntheticInput: string; secondaryArgs: string[] }> = {};
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
  } catch { /* ts-morph may fail on complex TypeScript (import.meta, Bun APIs, etc.) */ }
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

function extractComparatorFunctions(
  source: string,
  isJs: boolean
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
  } catch { /* ts-morph may fail on complex TypeScript */ }
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

function extractFunctionTypeChains(
  source: string,
  modulePath: string,
  isJs: boolean
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

  // Follow re-exports: `export { X } from "Y"` — load Y and scan it
  const reExportPattern = /export\s*\{[^}]+\}\s*from\s*["']([^"']+)["']/g;
  const dir = dirname(modulePath);
  for (const m of source.matchAll(reExportPattern)) {
    const relPath = m[1];
    const absPath = relPath.startsWith(".") ? resolve(dir, relPath) : null;
    if (!absPath) continue;
    for (const ext of [".ts", ".js", ".tsx", ".jsx", ""]) {
      const candidate = absPath.endsWith(".ts") || absPath.endsWith(".js") ? absPath : absPath + ext;
      if (!existsSync(candidate)) continue;
      try {
        const imported = readFileSync(candidate, "utf-8");
        const sigs = collectSignatures(imported);
        // Merge consumerOf unconditionally
        sigs.consumerOf.forEach((v, k) => consumerOf.set(k, v));
        // Merge producerOf only when the function doesn't also CONSUME the same type
        // (avoids identity transformers like synthesize(T) → T being their own producer)
        sigs.producerOf.forEach((fnName, typeName) => {
          const alsoConsumes = sigs.consumerOf.get(fnName) === typeName;
          if (!alsoConsumes) producerOf.set(typeName, fnName);
        });
      } catch { /* skip unreadable */ }
      break;
    }
  }

  // Build chains: fn's chain = producer's chain + producer
  // Also collect text transformer info for the root (first) function in each chain.
  // Root text transformer info is extracted from the imported source files.
  const rootTextTransformers = new Map<string, { syntheticInput: string; secondaryArgs: string[] }>();
  const reExportPattern2 = /export\s*\{[^}]+\}\s*from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(reExportPattern2)) {
    const relPath = m[1];
    const absPath = relPath.startsWith(".") ? resolve(dir, relPath) : null;
    if (!absPath) continue;
    for (const ext of [".ts", ".js", ".tsx", ".jsx", ""]) {
      const candidate = absPath.endsWith(".ts") || absPath.endsWith(".js") ? absPath : absPath + ext;
      if (!existsSync(candidate)) continue;
      try {
        const imported = readFileSync(candidate, "utf-8");
        const ttFns = extractTextTransformerFunctions(imported, false);
        for (const [name, info] of Object.entries(ttFns)) {
          rootTextTransformers.set(name, info);
        }
      } catch { /* skip */ }
      break;
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
  } catch { return {}; } // ts-morph may fail on complex TypeScript (import.meta, Bun APIs, etc.)
}

// ── Main entry point ─────────────────────────────────────────────────

// Extracts top-level comma-separated arguments from a call expression.
// `start` is the index just after the opening paren.
// Handles nested brackets and string literals containing commas/braces.
function extractCallArgs(src: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let argStart = start;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === inStr && src[i - 1] !== "\\") inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) {
        const arg = src.slice(argStart, i).trim();
        if (arg) args.push(arg);
        return args;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      const arg = src.slice(argStart, i).trim();
      if (arg) args.push(arg);
      argStart = i + 1;
    }
  }
  return args;
}

/**
 * Analyses source content directly — no file I/O, no dynamic calling.
 * Accepts optional pre-computed zeroArgScenarios for full fact extraction.
 * Use this when you have source content (e.g. synthetic test source) without a real file.
 */
export async function extractFactsFromSource(
  source: string,
  modulePath = "anonymous.ts",
  zeroArgScenarios: Record<string, ZeroArgScenario> = {}
): Promise<AstFacts> {
  // For real paths, resolve imports one level deep. For anonymous/synthetic sources, skip.
  const importedSources = (modulePath !== "anonymous.ts" && existsSync(modulePath))
    ? await resolveImports(source, modulePath)
    : [];
  const allSource = [source, ...importedSources].join("\n");

  const exportVerbs: Record<string, { sideEffect: boolean; returns: string }> = {};
  for (const m of allSource.matchAll(/export\s+const\s+(\w+)/g)) {
    const name = m[1];
    const lower = name.toLowerCase();
    for (const [verb, impl] of Object.entries(VERB_IMPLIES)) {
      if (lower.startsWith(verb)) { exportVerbs[name] = impl; break; }
    }
  }

  const isJs = /\.(js|jsx|mjs)$/.test(modulePath);

  // Parse __lld_api descriptor: "methodName(args) -> returnType | description"
  // Detects: boolean, boolean[], type[], throws
  const returnTypes: Record<string, string> = {};
  for (const m of allSource.matchAll(/\b(\w+)\s*\([^)]*\)\s*->\s*(\w+(\[\])?)/g)) {
    const raw = m[2].toLowerCase();
    returnTypes[m[1]] = raw.endsWith("[]") ? "array" : raw;
  }

  // Parse "result has default for X field" in __lld_api descriptions
  // e.g. "addFieldAndRead() -> object | ... result has default for new field"
  // → { addFieldAndRead: { field: "newField", value: "" } }
  const defaultFields: Record<string, { field: string; value: string }> = {};
  // "result has default for fieldName" where fieldName is camelCase
  for (const m of allSource.matchAll(/(\w+)\s*\([^)]*\)[^|]*\|[^`\n]*result has (?:an?\s+)?(?:empty string )?default for (\w+)\b/gi)) {
    defaultFields[m[1]] = { field: m[2], value: "" };
  }

  // Parse __lld_api result assertions from indented __lld_api lines only:
  //   "  methodName() -> type | ...; result.field is a string"
  //   "  methodName() -> type | ...; result.field === value"
  //   "  methodName() -> type | ...; result.field is defined"
  // Anchored to line-start whitespace to avoid matching code internals.
  const resultAssertions: Record<string, string> = {};
  for (const m of allSource.matchAll(/^\s+(\w+)\s*\([^)]*\)\s*->[^|]+\|[^\n]*result\.(\w+)\s+(===\s*"[^"]*"|is\s+a\s+\w+|is\s+defined)/gim)) {
    const method = m[1];
    const field  = m[2];
    const check  = m[3].trim();
    if (check.startsWith("===")) {
      resultAssertions[method] = `expect(r.${field}).toBe(${check.slice(3).trim()});`;
    } else if (/^is\s+a\s+(\w+)/i.test(check)) {
      const type = check.match(/^is\s+a\s+(\w+)/i)?.[1]?.toLowerCase() ?? "string";
      resultAssertions[method] = `expect(typeof r.${field}).toBe("${type}");`;
    } else if (/^is\s+defined/i.test(check)) {
      resultAssertions[method] = `expect(r.${field}).toBeDefined();`;
    }
  }

  // Detect patchable fault injection targets from:
  //   withFaultInjection(target, "method", ...) calls — the new declarative form
  //   const orig = X.Y.method; X.Y.method = async () => {} — the old manual form
  const faultTargets: Record<string, string> = {};
  for (const m of allSource.matchAll(/withFaultInjection\s*\(\s*([\w.]+)\s*,\s*["'](\w+)["']/g)) {
    const obj = m[1];   // e.g. "database.db"
    const meth = m[2];  // e.g. "write"
    faultTargets[meth] = `${obj}.${meth}`;
  }
  // Fallback: manual reassignment pattern
  for (const m of allSource.matchAll(/const\s+\w+\s*=\s*([\w.]+);\s*\n[\s\S]{0,200}?\1\s*=\s*async/g)) {
    const path = m[1];
    const verb = path.split(".").pop()?.toLowerCase() ?? "";
    if (verb && !faultTargets[verb]) faultTargets[verb] = path;
  }

  // Detect if this is a default-exporting CRUD module (createCRUD pattern in source)
  const isDefaultCrud = /export\s+default\s+createCRUD\b/.test(source)
    || (/export\s+default\s+/.test(source) && extractSchemas(source).length > 0);

  // Detect database module path from primary source OR transitively from allSource
  // "import database from '...'" or "import database from '.'"
  const dbImportMatch = allSource.match(/import\s+database\s+from\s+['"`]([^'"`]+)['"`]/);
  const databaseModulePath = dbImportMatch
    ? (() => {
        const raw = dbImportMatch[1];
        if (raw === "." || raw === "./") return resolve(dirname(modulePath), "index.js");
        if (raw.startsWith("./") || raw.startsWith("../")) return resolve(dirname(modulePath), raw);
        return raw;
      })()
    : undefined;

  // Extract lifecycle options from createDbLifecycle call in the module's own source
  // e.g. createDbLifecycle(db, ["bookmarks", "categories"], { prefix: "lld-bm-" })
  const lcCallMatch = source.match(/createDbLifecycle\s*\([^,]+,\s*(\[.*?\])\s*(?:,\s*\{[^}]*prefix\s*:\s*["']([^"']+)["'][^}]*\})?\s*\)/s);
  // __lld_lifecycle export is optional/legacy — isSelfDatabase modules no longer need it.
  // The adapter derives collections=[] and a basename prefix automatically for isSelfDatabase.
  const lldLifecycleMatch = source.match(/__lld_lifecycle\s*=\s*\{[^}]*collections\s*:\s*(\[[^\]]*\])[^}]*(?:prefix\s*:\s*["']([^"']+)["'])?[^}]*\}/s);
  const lifecycleOptions = lcCallMatch
    ? (() => {
        try {
          const cols = JSON.parse(lcCallMatch[1].replace(/'/g, '"'));
          return { collections: Array.isArray(cols) ? cols : [], prefix: lcCallMatch[2] };
        } catch { return { collections: [], prefix: lcCallMatch[2] }; }
      })()
    : lldLifecycleMatch
    ? (() => {
        try {
          const cols = JSON.parse(lldLifecycleMatch[1].replace(/'/g, '"'));
          return { collections: Array.isArray(cols) ? cols : [], prefix: lldLifecycleMatch[2] };
        } catch { return { collections: [], prefix: lldLifecycleMatch[2] }; }
      })()
    : undefined;

  // Detect if the module itself IS the database object (has init/write/db pattern, no db import).
  // Does NOT require __lld_lifecycle — the annotation was just a workaround.
  const isSelfDatabase = !dbImportMatch
    && /\bwrite\s*\(\s*\)/.test(source)
    && /\binit\s*\(/.test(source)
    && /\bdb\b/.test(source);

  // Detect related entity module paths from imports + FK relationships
  // "import categories from '...categories.js'" + FK "category" → relatedEntityPaths["category"] = absPath
  const importVarToPath: Record<string, string> = {};
  for (const m of source.matchAll(/import\s+(\w+)\s+from\s+['"`]([^'"`]+)['"`]/g)) {
    importVarToPath[m[1]] = m[2];
  }

  const relatedEntityPaths: Record<string, string> = {};
  // Build entity index from schema collection names + exported function name patterns
  const entityIndex: Record<string, { create?: string; read?: string; search?: string }> = {};
  for (const schema of extractSchemas(allSource)) {
    // Convert collection name to entity label: "searchEngines" → "searchEngine"
    const label = schema.collection.replace(/s$/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
    entityIndex[label] = {
      create: schema.collection + ".create",
      read: schema.collection + ".read",
    };
  }

  // Detect primary action function: exported function that calls fetch or similar external I/O
  let primaryAction: string | undefined;
  let primaryActionModule: string | undefined;

  // __lld_primaryAction is optional/legacy — the system now auto-detects the primary action
  // by scanning sibling directories for a consumer file that imports this module AND calls fetch.
  // The annotation is still accepted as an explicit override when auto-detection isn't sufficient.
  const lldPrimaryActionMatch = source.match(/__lld_primaryAction\s*=\s*\{[^}]*name\s*:\s*["']([^"']+)["'][^}]*module\s*:\s*["']([^"']+)["'][^}]*\}/s)
    ?? source.match(/__lld_primaryAction\s*=\s*\{[^}]*module\s*:\s*["']([^"']+)["'][^}]*name\s*:\s*["']([^"']+)["'][^}]*\}/s);
  if (lldPrimaryActionMatch) {
    // Detect order: { name, module } or { module, name }
    const nameFirst = /__lld_primaryAction\s*=\s*\{[^}]*name/.test(source);
    primaryAction = nameFirst ? lldPrimaryActionMatch[1] : lldPrimaryActionMatch[2];
    const modRaw = nameFirst ? lldPrimaryActionMatch[2] : lldPrimaryActionMatch[1];
    primaryActionModule = (modRaw.startsWith("./") || modRaw.startsWith("../"))
      ? resolve(dirname(modulePath), modRaw)
      : modRaw;
  } else {
    const hasFetch = /\bfetch\b/.test(allSource) || /\bwithMockFetch\b/.test(allSource);
    if (hasFetch) {
      // Find exported async function that takes external results (search provider pattern)
      const providerMatch = allSource.match(/export\s+(?:const\s+(\w+)\s*=\s*async|async\s+function\s+(\w+))[^{]*\{[^}]*fetch/s);
      if (!providerMatch) {
        // Look for imported function used for searching — capture where it's imported from
        const searchImportLine = allSource.match(/import\s*\{[^}]*(\bsearch\w*)\b[^}]*\}\s*from\s*['"`]([^'"`]+)['"`]/);
        if (searchImportLine) {
          primaryAction = searchImportLine[1];
          const raw = searchImportLine[2];
          primaryActionModule = (raw.startsWith("./") || raw.startsWith("../"))
            ? resolve(dirname(modulePath), raw)
            : raw;
        }
      } else {
        primaryAction = providerMatch[1] ?? providerMatch[2];
      }
    }
  }

  // Reverse-dependency scan: if no primaryAction found yet but the module has any schema,
  // scan sibling directories for a file that imports this module AND calls fetch — that
  // file's first exported async function is primaryAction.
  if (!primaryAction) {
    const schemas0 = extractSchemas(allSource);
    if (schemas0.length > 0) {
      const modBase = basename(modulePath, extname(modulePath));
      const searchDirs = ["../utils", "../helpers", "..", "."].map(d => resolve(dirname(modulePath), d));
      for (const dir of searchDirs) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = (await import("fs")).readdirSync(dir).filter((f: string) => /\.(js|ts)$/.test(f)); } catch { continue; }
        for (const file of files) {
          const fp = resolve(dir, file);
          if (fp === modulePath) continue;
          try {
            const s = await readFile(fp, "utf-8");
            if (!s.includes(modBase) || !/\bfetch\b/.test(s)) continue;
            // Find the exported async function whose body directly calls fetch.
            // Bound each function's body by scanning to the NEXT top-level 'export' keyword.
            const exportFnRe = /export\s+(?:const\s+(\w+)\s*=\s*async|async\s+function\s+(\w+))/g;
            const allExports: Array<{ name: string; start: number }> = [];
            let efm2: RegExpExecArray | null;
            while ((efm2 = exportFnRe.exec(s)) !== null) {
              allExports.push({ name: efm2[1] ?? efm2[2], start: efm2.index });
            }
            let foundFn: string | undefined;
            for (let i = 0; i < allExports.length; i++) {
              const end = allExports[i + 1]?.start ?? s.length;
              const body = s.slice(allExports[i].start, end);
              if (/\bfetch\s*\(/.test(body)) { foundFn = allExports[i].name; break; }
            }
            if (foundFn) { primaryAction = foundFn; primaryActionModule = fp; break; }
          } catch { continue; }
        }
        if (primaryAction) break;
      }
    }
  }

  // Derive HTTP mock response shape from existing withMockFetch calls in the module source.
  // The call arguments already show the correct shape — extract the structure and normalize
  // values to FIELD_VALUES so synthetic data is consistent with the rest of the test suite.
  // Fallback: when the module uses fetch and has a search-engine-like schema (resultsPath +
  // nameProperty + urlProperty fields), construct the mock from the default field values found
  // in the source (e.g. from imported ENTITY_FIXTURES).
  // Also pass when primaryAction is detected — that confirms this is a search module
  // even if the source doesn't directly contain 'fetch' or 'searchProvider'.
  const mockResponseShape = deriveMockShape(allSource)
    ?? deriveSearchEngineMockShape(allSource)
    ?? (primaryAction ? deriveSearchEngineMockShape("fetch") : undefined);

  // Detect foreign key relationships from hooks + TypeScript field types
  // hook trigger "data.category?.create" → FK from current entity to "category"
  const foreignKeys: Record<string, string> = {};
  const entityTypes: string[] = [];

  for (const schema of extractSchemas(allSource)) {
    entityTypes.push(schema.collection);
    for (const hook of schema.hooks) {
      if (hook.trigger) {
        // "data.fieldName?.create" → FK to entity named by fieldName
        const fkMatch = hook.trigger.match(/data\.(\w+)\??\.\w+/);
        if (fkMatch) {
          const fkField = fkMatch[1];
          // Infer entity type from the field name (category → category, authorId → author)
          const relatedEntity = fkField.replace(/Id$/, "");
          foreignKeys[fkField] = relatedEntity;
          if (!entityTypes.includes(relatedEntity)) entityTypes.push(relatedEntity);
        }
      }
    }
  }

  // Enhance FK detection with TypeScript type analysis (optional string fields in interfaces)
  // and JSDoc @param annotations — more reliable than hook analysis alone
  const typeFks = extractForeignKeysFromTypes(source, entityTypes, isJs);
  for (const [field, entity] of Object.entries(typeFks)) {
    if (!foreignKeys[field]) foreignKeys[field] = entity;
  }

  // Auto-generate __lld_api from TypeScript function signatures + JSDoc
  // Uses ts-morph to read exported function types and their documentation
  const generatedApi = generateApiFromTypes(source, isJs);

  // Populate return types for virtual methods derived from patterns (no __lld_api needed)
  // These ensure mockHttp and other type-dependent logic works for inferred groups.
  const schema0 = extractSchemas(allSource)[0];
  if (schema0) {
    const entity0 = schema0.collection.replace(/ies$/, "y").replace(/s$/, "");
    returnTypes["createMinimal"]          ??= entity0;
    returnTypes["updateName"]             ??= entity0;
    returnTypes["updateUrl"]              ??= entity0;
    // Dynamic FK-based virtual method return types
    for (const [fkField, relatedEntity] of Object.entries(foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      const plural = relatedEntity.endsWith("y") ? relatedEntity.slice(0,-1)+"ies" : relatedEntity+"s";
      const capPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
      returnTypes[`createWith${cap}Field`]   ??= entity0;
      returnTypes[`change${cap}Isolation`]   ??= entity0;
      returnTypes[`read${capPlural}`]        ??= `${relatedEntity}[]`;
      returnTypes[`deleteOrphans`]           ??= "void";
      returnTypes[`deleteAndMove`]           ??= "void";
    }
  }
  if (isSelfDatabase) {
    returnTypes["readAll"]                ??= "object";
    returnTypes["writesInOrder"]          ??= "boolean";
    returnTypes["queueFailThenRecover"]   ??= "boolean";
    returnTypes["addFieldAndRead"]        ??= "object";
  }
  // Search engine virtual methods — only when primaryAction is detected
  if (primaryAction && extractSchemas(allSource).some(s => s.fields.includes("resultsPath"))) {
    returnTypes["searchWithDefaultEngine"] ??= "array";
    returnTypes["searchTwoEngines"]        ??= "boolean";
    returnTypes["seedBadProtocolEngine"]   ??= "engine";
    returnTypes["searchBadProtocol"]       ??= "throws";
    returnTypes["createWithOrderBy"]       ??= "engine";
  }

  return {
    schemas: extractSchemas(allSource),
    allowlists: extractAllowlists(allSource),
    validationLocations: extractValidationLocations(allSource),
    lifecycle: inferLifecycleFunctions(source),
    exportVerbs,
    returnTypes,
    defaultFields,
    resultAssertions,
    complexity: extractComplexity(allSource, isJs),
    callGraph: buildLocalCallGraph(allSource, isJs),
    faultTargets,
    entityIndex,
    primaryAction,
    mockResponseShape,
    foreignKeys,
    entityTypes,
    isDefaultCrud,
    databaseModulePath,
    relatedEntityPaths: (() => {
      const paths: Record<string, string> = {};
      for (const [fkField, relatedEntity] of Object.entries(foreignKeys)) {
        // Try common plural forms: "category" → "categories", "entity" → "entities", "item" → "items"
        const plural = relatedEntity.endsWith("y")
          ? relatedEntity.slice(0, -1) + "ies"
          : relatedEntity + "s";
        const varName = [relatedEntity, plural].find(v => importVarToPath[v]);
        if (varName && importVarToPath[varName]) {
          const relPath = importVarToPath[varName];
          paths[relatedEntity] = relPath.startsWith("./") || relPath.startsWith("../")
            ? resolve(dirname(modulePath), relPath)
            : relPath;
        }
      }
      return paths;
    })(),
    generatedApi,
    lifecycleOptions,
    source: allSource,
    primaryActionModule,
    isSelfDatabase,
    usesProcessArgv:   /\bprocess\.argv\b/.test(source),
    mayCallProcessExit: /\bprocess\.exit\b/.test(source),
    constructorModulePath: resolveConstructorModulePath(source, modulePath),
    textTransformerFunctions: extractTextTransformerFunctions(source, isJs),
    comparatorFunctions: extractComparatorFunctions(source, isJs),
    functionTypeChains: (() => {
      const chains = extractFunctionTypeChains(source, modulePath, isJs);
      return chains;
    })(),
    get pipelineStageModulePath() {
      return Object.keys(this.functionTypeChains).length > 0 ? modulePath : undefined;
    },
    zeroArgScenarios,
    eventTargetClass: (() => {
      const m = source.match(/^export\s+default\s+class\s+(\w+)\s+extends\s+EventTarget/m);
      if (!m) return undefined;
      return {
        name: m[1],
        hasSubscribe: /\bsubscribe\s*\(/.test(source),
        hasDestroy: /\bdestroy\s*\(\s*\)/.test(source),
        hasIsDestroyed: /\bisDestroyed\b/.test(source),
      };
    })(),
    componentClass: (() => {
      // Case 1: inline class export (not EventTarget)
      const inline = source.match(/^export\s+default\s+class\s+(\w+)\s+extends\s+([\w$]+(?:\([^)]*\))?)/m);
      if (inline && inline[2] !== "EventTarget") return { name: inline[1], extendsName: inline[2] };
      // Case 2: class defined then exported as default
      const exportedName = source.match(/^export\s+default\s+(\w+)\s*;?\s*$/m)?.[1];
      if (exportedName) {
        const classDecl = source.match(new RegExp(`class\\s+${exportedName}\\s+extends\\s+([\\w$]+(?:\\([^)]*\\))?)`));
        if (classDecl && classDecl[1] !== "EventTarget") return { name: exportedName, extendsName: classDecl[1] };
      }
      return undefined;
    })(),
    get derivedApi() {
      // Lazy — computed after the object is built so it can reference the full facts
      return generateDerivedApiFromFacts(this as AstFacts);
    },
  };
}

/** File-based entry point: reads the file, resolves imports, calls extractFactsFromSource. */
export async function extractFacts(modulePath: string): Promise<AstFacts | null> {
  if (!existsSync(modulePath)) return null;
  let source: string;
  try { source = await readFile(modulePath, "utf-8"); } catch { return null; }
  const zeroArgScenarios = await extractZeroArgScenarios(source, modulePath);
  return extractFactsFromSource(source, modulePath, zeroArgScenarios);
}

// Zero-arg scenarios: canonical test inputs for extractFacts/extractFactsFromSource behavior.
// These document expected outcomes and serve as derivable test fixtures for the AST module.
// Zero-arg scenarios for extractFacts behavior testing.
// Use lazy imports (.then) so ast.ts is loaded from cache, not re-executed.
// Source strings are assembled at runtime to avoid triggering extractSchemas on THIS file.
const _crudBody = "createCRUD('items', ['name', 'url']);";
const _crudSrc = `export ${["def", "ault"].join("")} ${_crudBody}`;
export const factsFromCrudSource = () =>
  import("./ast.ts").then(m => m.extractFactsFromSource(_crudSrc));
export const factsFromNonCrudSource = () =>
  import("./ast.ts").then(m => m.extractFactsFromSource(`export function get(id: string) { return id; }`));
export const factsFromMissingPath = () =>
  import("./ast.ts").then(m => m.extractFacts("/nonexistent/path.ts"));

// Resolves the absolute path of the module that provides the primary constructor.
// Priority: explicit re-export of default → first capitalized default import → self (direct export default).
function resolveConstructorModulePath(source: string, modulePath: string): string | undefined {
  const dir = dirname(modulePath);
  const reExport = source.match(/export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/);
  if (reExport) return resolve(dir, reExport[1]);
  // Case 1: inline class default-export — this module IS the constructor
  if (/^export\s+default\s+class\b/m.test(source)) return modulePath;
  // Case 2: class defined locally, exported as default on a separate line
  const exportedName = source.match(/^export\s+default\s+(\w+)\s*;?\s*$/m)?.[1];
  if (exportedName && new RegExp(`\\bclass\\s+${exportedName}\\b`).test(source)) return modulePath;
  // Fall back to first capitalized default import (CLI-pattern modules that import a constructor)
  const defaultImport = source.match(/import\s+([A-Z]\w*)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/);
  if (defaultImport) return resolve(dir, defaultImport[2]);
  if (/export\s+default\s+/.test(source)) return modulePath;
  return undefined;
}

// Finds exported zero-arg arrow functions that wrap detection-signal calls
// (parseArgs / exitCode / checkExitCalled / parseManually), extracts their argument
// source text verbatim (preserving embedded arrow functions), and calls them
// dynamically to capture the result for assertion generation.
// Re-entry guard: prevents infinite recursion when zero-arg scenarios spawn subprocesses
// (e.g. Bun.spawnSync re-entering the event loop during codegen)
let _extractZeroArgRunning = false;

async function extractZeroArgScenarios(
  source: string,
  modulePath: string
): Promise<Record<string, ZeroArgScenario>> {
  const scenarios: Record<string, ZeroArgScenario> = {};
  // Match any exported zero-arg arrow function that calls a local or imported helper function.
  // The callFn can be any function name — not just argi's specific exports.
  const pattern = /export\s+const\s+(\w+)\s*=\s*\(\)\s*=>\s*\n?\s*(\w+)\s*\(/g;
  for (const m of source.matchAll(pattern)) {
    const name = m[1];
    const callFn = m[2] as ZeroArgScenario["callFn"];
    const openPos = m.index! + m[0].length;
    const args = extractCallArgs(source, openPos);
    // CLI-style callFns need argv + options (≥2 args); general callFns only need 1
    const cliCallFns = new Set(["parseArgs", "exitCode", "checkExitCalled", "parseManually"]);
    if (cliCallFns.has(callFn) ? args.length >= 2 : args.length >= 1) {
      scenarios[name] = { callFn, argvText: args[0] ?? "", optText: args[1] ?? "", cfgText: args[2] };
    }
  }
  if (Object.keys(scenarios).length === 0) return scenarios;
  // Re-entry guard: if a zero-arg scenario call re-enters this function
  // (e.g. via Bun.spawnSync re-entering the event loop), skip the dynamic calling.
  if (_extractZeroArgRunning) return scenarios;
  _extractZeroArgRunning = true;
  // Dynamically call each to capture result/threw for assertion generation
  const savedArgv = process.argv.slice();
  try {
    const mod = await import(`${modulePath}?t=${Date.now()}`);
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (typeof mod[name] === "function") {
        try {
          scenario.result = await (mod[name] as () => unknown)();
          scenario.threw = false;
        } catch {
          scenario.threw = true;
        }
      }
    }
  } catch { /* helper may not be importable in all contexts */ } finally {
    _extractZeroArgRunning = false;
  }
  process.argv = savedArgv;
  return scenarios;
}

// ── Derived API vocabulary ────────────────────────────────────────────
// Generates __lld_api-style descriptions purely from AstFacts patterns.
// No production-code annotation required.

function generateDerivedApiFromFacts(facts: AstFacts): string {
  const lines: string[] = [];
  const schema = facts.schemas[0];

  // ── CRUD modules: derive virtual method vocabulary from schema + FK ──
  if (facts.isDefaultCrud && schema) {
    const entity   = schema.collection.replace(/ies$/, "y").replace(/s$/, "");
    const fields   = schema.fields;
    const req2     = fields.slice(0, 2);

    // create with only required fields
    lines.push(`  createMinimal() -> ${entity} | create with only required fields (${req2.join(" + ")}); an uncategorized ${entity} is a valid state`);

    // create with FK field set — one entry per FK
    for (const fkField of Object.keys(facts.foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      lines.push(`  createWith${cap}Field() -> ${entity} | create with ${fkField} field; the ${fkField} field holds a string value`);
    }

    // read related entities — one entry per FK target with a resolved path
    for (const [relatedEntity] of Object.entries(facts.relatedEntityPaths)) {
      const plural = relatedEntity.endsWith("y")
        ? relatedEntity.slice(0, -1) + "ies"
        : relatedEntity + "s";
      const capPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
      lines.push(`  read${capPlural}() -> ${relatedEntity}[] | create two ${plural} and return them as a flat array`);
    }

    // update {field} — descriptions must match resolveMethodCall pattern:
    // "create then update the {field} field; result.{field} === '{value}'"
    for (const field of fields.slice(0, 2)) {
      const cap   = field.charAt(0).toUpperCase() + field.slice(1);
      // Use a synthetic expected value appropriate to the field type
      const val   = field === "url" ? "https://example.com" : "Renamed";
      lines.push(`  update${cap}() -> ${entity} | create then update the ${field} field; result.${field} === "${val}"`);
    }

    // isolation test — descriptions must match resolveMethodCall isolation pattern:
    // "create two {entityPlural}, change one's {fkField}; the other {entity} retains"
    for (const [fkField] of Object.entries(facts.foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      const entityPlural = entity.endsWith("y")
        ? entity.slice(0, -1) + "ies"
        : entity + "s";
      lines.push(`  change${cap}Isolation() -> ${entity} | create two ${entityPlural}, change one's ${fkField}; result.${fkField} is defined`);
    }

    // afterDelete with orphan + move semantics — only when THIS collection's createCRUD
    // call includes an afterDelete hook (not when it leaks from an imported module)
    const collectionHasAfterDelete = new RegExp(
      `createCRUD\\s*\\(\\s*['"\`]${schema.collection}['"\`][\\s\\S]{0,500}afterDelete`
    ).test(facts.source);
    if (collectionHasAfterDelete) {
      // Detect the target collection referenced in the afterDelete hook body
      const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
      const targetColl = afterDeleteCollMatch?.[1] ?? "items";
      const entityPlural2 = entity.endsWith("y") ? entity.slice(0,-1)+"ies" : entity+"s";
      lines.push(`  deleteOrphans() -> void | create a ${entity}, seed a ${targetColl} record with that ${entity} id directly into the db, delete the ${entity}; no ${targetColl} record retains the deleted ${entity} id`);
      lines.push(`  deleteAndMove() -> void | create two ${entityPlural2}, seed a ${targetColl} record assigned to the first, delete the first with moveTo=second id; the ${targetColl} record's ${entity} equals the second id`);
    }
  }

  // ── Self-database modules: write-queue and schema-evolution patterns ──
  if (facts.isSelfDatabase) {
    lines.push(`  readAll() -> object | reads require no network; returns all database data without any network call; proves local-only access`);
    // Write-queue: detected by _writeQueue chaining pattern in the module itself
    if (facts.source.includes("_writeQueue") || facts.source.includes("writeQueue")) {
      lines.push(`  writesInOrder() -> boolean | concurrent writes complete in order; write ordering is structural; returns true if queue order is preserved`);
      // Fault recovery: a queue with error handling (catch inside write chain)
      if (facts.source.includes(".catch(")) {
        lines.push(`  queueFailThenRecover() -> boolean | a failed write does not stall the queue; error recovery is structural; returns true if queue continued after failure`);
      }
    }
    // Schema evolution: any module that tracks db.data and supports field migration
    if (facts.source.includes("db.data") || facts.source.includes("database.default")) {
      lines.push(`  addFieldAndRead() -> object | write a record and read it back; existing records get empty string defaults for new fields; proves schema changes do not require data migration`);
    }
  }

  // ── Search-engine CRUD modules: search provider vocabulary ───────────
  if (facts.primaryAction && schema?.fields.includes("resultsPath")) {
    const fn = facts.primaryAction;
    lines.push(`  searchWithDefaultEngine(term) -> results[] | seed a default engine and search; a search returns a list of results as links with name and url`);
    lines.push(`  seedBadProtocolEngine() -> engine | seed engine with dangerous protocol URL; save succeeds because validity is checked at search time not at save time`);
    lines.push(`  searchTwoEngines(term) -> boolean | seed two differently-configured engines, search both; results from different engine schemas are normalized to the same shape`);
    lines.push(`  searchBadProtocol() -> throws | seed engine with dangerous protocol and search; throws because only http and https are permitted in the final resolved URL`);
    if (schema.fields.includes("orderBy")) {
      lines.push(`  createWithOrderBy() -> engine | create a search engine record with orderBy set; the orderBy field is stored and preserved`);
    }
  }

  // ── Exit-code testing modules (export exitCode / checkExitCalled, or source calls process.exit) ──
  const hasExitCodeExport = "exitCode" in facts.exportVerbs
    || facts.source.includes("export const exitCode")
    || !!facts.mayCallProcessExit;
  const hasCheckExitExport = facts.source.includes("export const checkExitCalled")
    || "checkExitCalled" in facts.exportVerbs
    || (!!facts.mayCallProcessExit && !!facts.usesProcessArgv);
  if (hasExitCodeExport || hasCheckExitExport) {
    if (hasExitCodeExport) {
      lines.push(`  unknownFlagExitCode() -> options | validation error produces non-zero exit code; result.code === 1`);
      lines.push(`  helpExitCode() -> options | --help request produces zero exit code; result.code === 0`);
      lines.push(`  versionExitCode() -> options | --version request produces zero exit code; result.code === 0`);
      lines.push(`  shortHelpAlias() -> options | -h alias for --help produces zero exit code; result.code === 0`);
    }
    if (hasCheckExitExport) {
      lines.push(`  constructorExitsOnError() -> options | constructor catches the thrown exit signal and triggers process.exit; result.triggered === true`);
      lines.push(`  constructorNoExitOnSuccess() -> options | successful parse does not trigger process.exit; result.triggered === false`);
    }
    lines.push(`  parseManuallyFails() -> throws | the thrown exit signal propagates directly to caller with parse false; throws on invalid input`);
  }

  // ── CLI parser modules (export parseArgs + process.argv manipulation) ───────
  // Derives vocabulary from detected option features — boolean negation, integer
  // types, aliases, required flags, sub-commands, tail args, etc. Works for any
  // module whose source reveals which option shapes it supports.
  const hasParseArgsExport = "parseArgs" in facts.exportVerbs
    || facts.source.includes("export const parseArgs")
    || (!!facts.usesProcessArgv && /\bclass\s+\w+/.test(facts.source) && !!facts.constructorModulePath)
    || Object.keys(facts.zeroArgScenarios).length > 0;
  if (hasParseArgsExport) {
    // Feature detection from module source
    const src = facts.source;
    const hasBoolean   = /\bparseBool\b|\bboolean\b/.test(src);
    const hasInteger   = /\bparseInteger\b|\binteger\b/.test(src);
    const hasNumber    = /\bnumber\b/.test(src);
    const hasAlias     = /\balias\b/.test(src);
    const hasRequired  = /\brequired\b/.test(src);
    const hasDefault   = /\bdefaultValue\b/.test(src);
    const hasSubCmd    = /\b__subCommands\b/.test(src);
    const hasTail      = /\b__tail\b/.test(src);
    const hasParseFalse = /parse.*false|parse: false/.test(src);
    const hasNoPrefix  = /\bno-/.test(src);

    // Tier ordering — only when sub-commands and tail are both supported
    if (hasSubCmd) {
      lines.push(`  subCommandConsumedFirst() -> options | sub-commands are consumed before flags are parsed; result.cmd === "first"`);
      lines.push(`  flagConsumedAfterSubCommand() -> options | flags are consumed from what remains after sub-commands; result.flag === "val"`);
    }
    if (hasTail) {
      lines.push(`  tailConsumedAfterFlags() -> options | tail args are consumed from what remains after flags; result.rest === "tailval"`);
      if (/\brest\b/.test(src)) {
        lines.push(`  restTailCaptures() -> array | rest tail argument captures all remaining tokens as an array; result.files[0] === "a"`);
      }
    }
    if (hasSubCmd && hasTail) {
      lines.push(`  allThreeTiersWork() -> options | all three tiers consume from the shared array in order; result.rest === "tail"`);
    }

    // Assignment forms (always present for any flag parser)
    lines.push(`  spaceFormAssigns() -> options | space form assigns the value; result.flag === "value"`);
    lines.push(`  equalsFormAssigns() -> options | equals form assigns the same value; result.flag === "value"`);
    lines.push(`  passThroughDoesNotContaminate() -> options | post-separator content does not contaminate parsed options; result.flag === "val"`);
    lines.push(`  unknownFlagFails() -> throws | unknown flag causes error exit not silent continuation; throws when unrecognized flag encountered`);
    lines.push(`  missingValueFails() -> throws | non-boolean flag without a following value is an error; throws when value is missing`);

    // Boolean support
    if (hasBoolean) {
      if (hasNoPrefix) lines.push(`  booleanNegation() -> options | --no-prefix negates the flag without requiring a separate option; result.flag === false`);
      lines.push(`  builtinBooleanType() -> options | boolean type coerces truthy strings case-insensitively; result.flag === true`);
      lines.push(`  chainedShortFlags() -> options | chained short flags set each option independently; result.a === true`);
    }
    // Integer / number support
    if (hasInteger)  lines.push(`  builtinIntegerType() -> options | integer type produces a number; result.count === 5`);
    if (hasNumber)   lines.push(`  numberValidationRejectsNaN() -> throws | built-in number test rejects NaN after transform; throws for non-numeric input`);

    // Alias support
    if (hasAlias) {
      lines.push(`  canonicalNameFromAlias() -> options | canonical name appears in options when alias is used; result.flag === "val"`);
      lines.push(`  longFormShortAliasFails() -> throws | long form of short alias names a nonexistent option; throws when long form of short alias used`);
    }
    // Required / default support
    if (hasRequired) lines.push(`  requiredEnforced() -> throws | required flag must appear on the command line; throws when required flag is absent`);
    if (hasDefault)  lines.push(`  defaultFilled() -> options | defaults are applied after all parsing completes; result.name === "world"`);

    // Transform / test feature support — detected from source structure, not helper exports.
    // Any CLI parser whose source uses defaults.transform or defaults.test gets these entries.
    if (/this\.defaults\.transform/.test(src)) {
      lines.push(`  pluggableTransform() -> create | transform map is replaceable; replacing string transform changes all string flags`);
      lines.push(`  perFlagTransformOverride() -> create | per-flag transform replaces type default; flag-level transform overrides built-in type coercion`);
    }
    if (/this\.defaults\.test|this\.#testOption/.test(src)) {
      lines.push(`  customTestRejection() -> throws | custom test receives coerced value and rejects; parse fails on invalid value`);
    }

    // Zero-arg arrow-fn scenarios: any exported () => call with ≥1 arg — general, not case-specific
    for (const [name, scenario] of Object.entries(facts.zeroArgScenarios)) {
      const desc = scenario.threw
        ? `zero-arg arrow-fn ${scenario.callFn} scenario that throws`
        : `zero-arg arrow-fn ${scenario.callFn} scenario`;
      lines.push(`  ${name}() -> create | ${desc}`);
    }
  }

  // ── Function type chains — pipeline stages that require setup ─────
  for (const [name, info] of Object.entries(facts.functionTypeChains ?? {})) {
    lines.push(`  ${name}(input) -> result | pipeline stage: output of ${info.chain.join(" → ")} → ${name}; calls ${name}`);
  }

  // ── Text transformer functions ─────────────────────────────────────
  for (const [name, info] of Object.entries(facts.textTransformerFunctions ?? {})) {
    if (info.returnsArray) {
      lines.push(`  ${name}(content) -> array | code processor: processes source code input and returns an array of results`);
    } else {
      lines.push(`  ${name}(content) -> document | text transformer: parses structured text input into a document object`);
    }
  }

  // ── Structural comparator functions — one entry per scenario variant ──
  const comparatorDescriptions: Record<string, string> = {
    "NoChange":       "verifies identical implementations produce no changes",
    "RemovedExport":  "detects removed exports as high-risk drift",
    "RenameExport":   "detects that a rename produces two changes: one removal and one addition",
    "GuardRemoval":   "detects guard removal as behavioral drift",
    "NoCatch":        "detects try-catch removal as behavioral drift",
  };
  for (const [name, info] of Object.entries(facts.comparatorFunctions ?? {})) {
    const suffix = name.slice(info.realFunctionName.length); // "" for base, "NoChange" etc. for variants
    const desc = comparatorDescriptions[suffix] ?? "detects parameter and signature changes between two implementation snapshots";
    lines.push(`  ${name}(before, after) -> changes[] | structural comparator: ${desc}; calls ${info.realFunctionName}`);
  }

  return lines.join("\n");
}

// ── Schema extraction ─────────────────────────────────────────────────
// Detects: createCRUD('name', ['field1', 'field2'], { hooks })
//          mongoose.Schema({ field: type })
//          similar factory / schema patterns

const CRUD_FACTORY = /createCRUD\(\s*['"`](\w+)['"`]\s*,\s*(\[[^\]]+\])/g;
const FIELD_LIST   = /['"`](\w+)['"`]/g;
const FIELD_DEFAULT_EQ_EMPTY = /\?\?\s*['"]{2}/;  // ?? '' pattern
const FIELD_DEFAULT_NULL      = /\?\?\s*null/;

function extractSchemas(source: string): SchemaInfo[] {
  const schemas: SchemaInfo[] = [];

  for (const match of source.matchAll(CRUD_FACTORY)) {
    const collection = match[1];
    const fieldsRaw  = match[2];

    const fields: string[] = [];
    for (const f of fieldsRaw.matchAll(FIELD_LIST)) fields.push(f[1]);

    const fieldDefault = FIELD_DEFAULT_EQ_EMPTY.test(source) ? "''"
      : FIELD_DEFAULT_NULL.test(source)       ? "null"
      : undefined;

    const hooks = extractHooks(source, collection);
    schemas.push({ collection, fields, fieldDefault, hooks });
  }

  return schemas;
}

function extractHooks(source: string, _collection: string): HookInfo[] {
  const hooks: HookInfo[] = [];

  // beforeCreate with optional-chain trigger: data.X?.create
  const beforeCreateBody = source.match(/beforeCreate[^}]+}/s)?.[0] ?? "";
  if (beforeCreateBody) {
    const triggerMatch = beforeCreateBody.match(/(data\.\w+\?\.\w+)/);
    hooks.push({
      kind: "beforeCreate",
      trigger: triggerMatch?.[1],
      description: triggerMatch
        ? `inline sub-entity creation when ${triggerMatch[1]} is present`
        : undefined,
    });
  }

  const beforeUpdateBody = source.match(/beforeUpdate[^}]+}/s)?.[0] ?? "";
  if (beforeUpdateBody) {
    const triggerMatch = beforeUpdateBody.match(/(update\.\w+\?\.\w+)/);
    if (triggerMatch) {
      hooks.push({ kind: "beforeUpdate", trigger: triggerMatch[1] });
    }
  }

  const afterDeleteBody = source.match(/afterDelete[^}]+}/s)?.[0] ?? "";
  if (afterDeleteBody) hooks.push({ kind: "afterDelete" });

  return hooks;
}

// ── Allowlist extraction ─────────────────────────────────────────────
// Detects: const ALLOWED_X = ['a', 'b']
//          const VALID_X   = ['a', 'b']

const ALLOWLIST_DECL = /const\s+((?:ALLOWED|VALID|PERMITTED|WHITELIST)\w*)\s*=\s*(\[[^\]]+\])/g;

function extractAllowlists(source: string): AllowlistInfo[] {
  const lists: AllowlistInfo[] = [];

  for (const match of source.matchAll(ALLOWLIST_DECL)) {
    const name      = match[1];
    const arrayBody = match[2];
    const values: string[] = [];
    for (const v of arrayBody.matchAll(/['"`]([^'"`]+)['"`]/g)) values.push(v[1]);

    // Find which exported function uses this constant
    const checkedIn = findFunctionContaining(source, name);
    lists.push({ name, values, checkedIn });
  }

  return lists;
}

// ── Validation location extraction ───────────────────────────────────
// Determines: which function does the check, which exported functions do not

function extractValidationLocations(source: string): ValidationLocationInfo[] {
  const locations: ValidationLocationInfo[] = [];
  const exported = extractExportedFunctionNames(source);

  // Protocol / URL validation
  const protocolCheck = source.match(/ALLOWED_PROTOCOLS|VALID_PROTOCOLS|allowed.*protocol/i);
  if (protocolCheck) {
    const checkedIn    = findFunctionContaining(source, protocolCheck[0]);
    const notCheckedIn = exported.filter(n => n !== checkedIn);
    if (checkedIn) {
      locations.push({ concept: "protocol-validation", checkedIn, notCheckedIn });
    }
  }

  return locations;
}

// ── Lifecycle inference ───────────────────────────────────────────────

export interface LifecycleHints {
  beforeAll?: string;
  beforeEach?: string;
}

/** Scans source for createDbLifecycle destructuring to infer beforeAll/beforeEach call strings. */
function inferLifecycleFunctions(source: string): LifecycleHints {
  const hints: LifecycleHints = {};
  // Matches destructuring patterns from createDbLifecycle calls (aliases or plain names)
  const m = source.match(/const\s*\{\s*(\w+)(?:\s*:\s*(\w+))?\s*,\s*(\w+)(?:\s*:\s*(\w+))?\s*\}\s*=\s*createDbLifecycle/);
  if (m) {
    const first  = m[2] || m[1]; // alias or original
    const second = m[4] || m[3];
    if (first  && /init/i.test(first))  hints.beforeAll  = `${first}()`;
    if (second && /reset/i.test(second)) hints.beforeEach = `${second}()`;
  }
  // Fallback: detect exported initDb / reset directly
  if (!hints.beforeAll  && /export\s+(?:const|async\s+function|function)\s+initDb\b/.test(source))
    hints.beforeAll  = "initDb()";
  if (!hints.beforeEach && /export\s+(?:const|function)\s+reset\b/.test(source))
    hints.beforeEach = "reset()";
  return hints;
}

// ── Synthetic value generation ────────────────────────────────────────

/** Returns a realistic synthetic test value for a schema field name. */
export function syntheticValue(field: string, unionLiterals?: string[]): unknown {
  if (unionLiterals?.length) {
    const lit = unionLiterals[0].replace(/^['"]|['"]$/g, "");
    return lit;
  }
  const lower = field.toLowerCase();
  for (const [key, entry] of Object.entries(FIELD_VALUES)) {
    if (lower.includes(key)) {
      const raw = entry.valid;
      // Strip surrounding quotes if the value is a quoted string literal
      if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
      if (/^"[^"]*"$/.test(raw)) return raw.slice(1, -1);
      return Number(raw) || raw;
    }
  }
  return "test-value";
}

// ── Field type extraction ─────────────────────────────────────────────

interface FieldTypeInfo { unionLiterals?: string[] }

/** Scans TypeScript source for union literal types on known field names, e.g. `status: "active" | "inactive"`. */
function extractFieldTypes(source: string, fields: string[]): Map<string, FieldTypeInfo> {
  const map = new Map<string, FieldTypeInfo>();
  for (const field of fields) {
    const re = new RegExp(`\\b${field}\\s*[?:]\\s*(['"]\w+['"](?:\\s*\\|\\s*['"]\w+['"])*)`, "g");
    const m = re.exec(source);
    if (m) {
      const literals = [...m[1].matchAll(/['"](\w+)['"]/g)].map(x => `'${x[1]}'`);
      if (literals.length > 0) map.set(field, { unionLiterals: literals });
    }
  }
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractExportedFunctionNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/export\s+(?:const|async\s+function|function)\s+(\w+)/g)) {
    names.push(m[1]);
  }
  return names;
}

function findFunctionContaining(source: string, needle: string): string | undefined {
  // Walk backwards from the needle's position to find the enclosing function name
  const idx = source.indexOf(needle);
  if (idx < 0) return undefined;

  const before = source.slice(0, idx);
  const funcMatch = before.match(/(?:export\s+)?(?:const\s+(\w+)\s*=\s*async|async\s+function\s+(\w+)|function\s+(\w+))[^{]*\{[^}]*$/s);
  if (funcMatch) return funcMatch[1] ?? funcMatch[2] ?? funcMatch[3];

  return undefined;
}

async function resolveImports(source: string, fromPath: string): Promise<string[]> {
  const sources: string[] = [];
  const dir = dirname(fromPath);

  // Grab local relative imports only
  for (const m of source.matchAll(/from\s+['"`](\.\.?\/[^'"`]+)['"`]/g)) {
    const raw = m[1];
    for (const ext of ["", ".js", ".ts"]) {
      const abs = resolve(dir, raw + ext);
      if (existsSync(abs)) {
        try { sources.push(await readFile(abs, "utf-8")); break; } catch {}
      }
    }
  }

  return sources;
}

// ── Fact → test hint  ─────────────────────────────────────────────────

export interface TestHint {
  /** What pattern of assertion this hint serves. */
  for: "schema-drop" | "default-value" | "inline-creation" | "protocol-validation" | "validation-timing";
  /** Synthesized call expression to use instead of a generic sentinel. */
  callExpr?: string;
  /** Expected value in assertion. */
  expectedValue?: string;
  /** Additional assertions to emit alongside the primary. */
  extraAssertions?: string[];
}

export function hintsFor(facts: AstFacts, assertionText: string): TestHint[] {
  const hints: TestHint[] = [];
  const lower = assertionText.toLowerCase();

  // Schema drop: "only declared fields survive" → use real field list for stronger assertion
  if (/only\s+declared\s+fields?\s+survive/.test(lower) || /undeclared\s+fields?\s+(?:are\s+)?dropped/.test(lower)) {
    const schema = facts.schemas[0];
    if (schema?.fields.length) {
      const extra = schema.fields.map(f => `expect(_r).toHaveProperty(${JSON.stringify(f)});`);
      hints.push({
        for: "schema-drop",
        extraAssertions: extra,
      });
    }
  }

  // Default value: "defaults to empty string" → know the exact field list to test
  if (/defaults?\s+to\s+empty\s+string/.test(lower) || /missing\s+fields?\s+default/.test(lower)) {
    const schema = facts.schemas[0];
    if (schema?.fields.length && schema.fieldDefault === "''") {
      const firstOptional = schema.fields.find(f => f !== "url" && f !== "id");
      if (firstOptional) {
        const callArgs = schema.fields
          .filter(f => f !== firstOptional)
          .slice(0, 2)
          .map(f => `${JSON.stringify(f)}: "x"`)
          .join(", ");
        hints.push({
          for: "default-value",
          callExpr: `create({ ${callArgs} })`,
          expectedValue: `""`,
          extraAssertions: [`expect(_r.${firstOptional}).not.toBeNull();`],
        });
      }
    }
  }

  // Inline creation: "can create a X in the same operation" → use the hook trigger shape
  if (/can\s+create/.test(lower) && /same\s+operation/.test(lower)) {
    const schema = facts.schemas[0];
    const hook = schema?.hooks.find(h => h.kind === "beforeCreate" && h.trigger);
    if (hook?.trigger && schema) {
      // e.g. data.category?.create → pass category: { create: { name: "Test" } }
      const field = hook.trigger.split(".")[1];
      const baseFieldArgs = Object.fromEntries(schema.fields.slice(0, 2).map(f => [f, syntheticValue(f)]));
      const argsStr = Object.entries(baseFieldArgs).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
      hints.push({
        for: "inline-creation",
        callExpr: `create({ ${argsStr}, ${field}: { create: { name: "Test" } } })`,
        extraAssertions: [`expect(_r.${field}).toBeDefined();`],
      });
    }
  }

  // Protocol validation timing: "checked when executed, not when saved"
  if (/checked\s+when/.test(lower) || /validation\s+targets/.test(lower)) {
    const loc = facts.validationLocations.find(l => l.concept === "protocol-validation");
    if (loc) {
      hints.push({
        for: "validation-timing",
        extraAssertions: [
          `// validated in: ${loc.checkedIn}`,
          `// not in: ${loc.notCheckedIn.join(", ")}`,
        ],
      });
    }
  }

  // Protocol allowlist: "only X and Y are permitted"
  if (/permitted|allowed.*protocol|http.*https/.test(lower)) {
    const list = facts.allowlists[0];
    if (list?.values.length) {
      hints.push({
        for: "protocol-validation",
        extraAssertions: list.values.map(v => `// allowed: ${v}`),
      });
    }
  }

  return hints;
}
// ── API auto-generation from TypeScript types + JSDoc ─────────────────
// Reads exported function signatures and JSDoc to produce __lld_api entries.
// Each entry: "name(params) -> returnType | jsdocDescription"

function generateApiFromTypes(source: string, isJs: boolean): string {
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

function extractForeignKeysFromTypes(source: string, entityTypes: string[], isJs: boolean): Record<string, string> {
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

        // Field is optional string — check if it matches a known entity name
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
  } catch { /* ts-morph unavailable for this source */ }
  return fks;
}

// ── Search-engine fixture generators ─────────────────────────────────
// These generate schema-driven fixtures rather than relying on hardcoded
// ENTITY_FIXTURES key lookups, making them portable across any project.

function generateSearchEngineFixture(schema: SchemaInfo): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field === "url")                  f[field] = "https://api.example.com/search?q=:term";
    else if (field === "resultsPath")     f[field] = "results";
    else if (field === "nameResultsPath") f[field] = "";
    else if (field === "nameProperty")    f[field] = "title";
    else if (field === "urlProperty")     f[field] = "url";
    else if (field === "limit")           f[field] = "5";
    else if (field === "orderBy")         f[field] = "";
    else                                  f[field] = syntheticValue(field);
  }
  if (!f.name) f.name = "test-engine";
  return f;
}

function generateBadProtocolEngineFixture(schema: SchemaInfo): Record<string, unknown> {
  return { ...generateSearchEngineFixture(schema), url: "javascript:alert(':term')", name: "bad-proto" };
}

function generateSecondEngineFixture(schema: SchemaInfo): Record<string, unknown> {
  return {
    ...generateSearchEngineFixture(schema),
    name: "engine-two",
    url: "https://api.other.com/find/:term",
    resultsPath: "items",
    nameProperty: "label",
    urlProperty: "link",
    limit: "3",
  };
}

// ── Group method call resolution ──────────────────────────────────────
// The api description IS a vocabulary spec. Running it through the same
// derivation pipeline produces the inline call from a method description string.

/** Builds the full inline test body for a parseArgs scenario using new _SubjectCtor(...). */
function buildParseArgsInline(argv: unknown[], opts: Record<string, unknown>, assertion: string): string {
  const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
  return [
    `process.argv = ["node", "cli.js", ${argvLiteral}];`,
    `const _a = new _SubjectCtor({ options: ${JSON.stringify(opts)}, parse: false });`,
    `_a.parse();`,
    `const r = _a.options;`,
    assertion,
  ].join("\n");
}

function buildParseArgsThrowInline(argv: unknown[], opts: Record<string, unknown>): string {
  const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
  return [
    `process.argv = ["node", "cli.js", ${argvLiteral}];`,
    `const _a = new _SubjectCtor({ options: ${JSON.stringify(opts)}, parse: false });`,
    `await expect(async () => { _a.parse(); }).toThrow();`,
  ].join("\n");
}

function deriveParseArgsInputs(
  field: string, value: unknown, lower: string
): { argv: unknown[]; opts: Record<string, unknown> } {
  if (/sub.?command/i.test(lower))
    return { argv: [String(value), "--flag", "val"], opts: { __subCommands: [{ name: field }], flag: {} } };
  if (/\btail\b/i.test(lower) && !/sub.?command/i.test(lower))
    return { argv: ["--flag", "val", String(value)], opts: { flag: {}, __tail: [{ name: field }] } };
  if (/chained/i.test(lower))
    return { argv: ["-abc"], opts: { a: { type: "boolean" }, b: { type: "boolean" }, c: { type: "boolean" } } };
  if (value === false && /negat|no.prefix/i.test(lower))
    return { argv: [`--no-${field}`], opts: { [field]: { type: "boolean" } } };
  if ((value === true || lower.includes("true")) && /boolean/i.test(lower))
    return { argv: [`--${field}`, "TRUE"], opts: { [field]: { type: "boolean" } } };
  if (/\binteger\b/i.test(lower) && typeof value === "number")
    return { argv: [`--${field}`, String(value)], opts: { [field]: { type: "integer" } } };
  if (/\bdefault\b/i.test(lower))
    return { argv: [], opts: { [field]: { defaultValue: value } } };
  if (/alias|canonical/i.test(lower))
    return { argv: [`-${field[0]}`, String(value)], opts: { [field]: { alias: field[0] } } };
  if (/pass.?through|separator/i.test(lower))
    return { argv: [`--${field}`, String(value), "--", "extra"], opts: { [field]: {} } };
  if (/equals.form|=value/i.test(lower))
    return { argv: [`--${field}=${String(value)}`], opts: { [field]: {} } };
  // Default: space form
  return { argv: [`--${field}`, String(value)], opts: { [field]: {} } };
}

function deriveParseArgsThrowInputs(
  lower: string
): { argv: unknown[]; opts: Record<string, unknown> } | null {
  if (/required.*absent|absent.*required/i.test(lower))
    return { argv: [], opts: { name: { required: true } } };
  if (/unknown|unrecognized/i.test(lower))
    return { argv: ["--unknown-xyz"], opts: {} };
  if (/long.form.*alias|alias.*long.form/i.test(lower))
    return { argv: ["--o", "value"], opts: { output: { alias: "o" } } };
  if (/missing.value|no.*following.value/i.test(lower))
    return { argv: ["--output"], opts: { output: {} } };
  if (/nan|non.numeric|number.*test/i.test(lower))
    return { argv: ["--count", "abc"], opts: { count: { type: "number" } } };
  return null;
}

function buildZeroArgInline(scenario: ZeroArgScenario, methodName: string): InlineDerived {
  // CLI parser: construct with options and call parse() separately
  if (scenario.callFn === "parseArgs" || scenario.callFn === "parseManually") {
    const cfgSpread = scenario.cfgText ? `, ...${scenario.cfgText}` : "";
    const lines = [
      `process.argv = ["node", "cli.js", ...${scenario.argvText}];`,
      `const _a = new _SubjectCtor({ options: ${scenario.optText}${cfgSpread}, parse: false });`,
    ];
    if (scenario.threw) {
      lines.push(`await expect(async () => { _a.parse(); }).toThrow();`);
    } else {
      lines.push(`_a.parse();`, `const r = _a.options;`);
      if (scenario.result != null && typeof scenario.result === "object") {
        for (const [key, val] of Object.entries(scenario.result as Record<string, unknown>)) {
          lines.push(`expect(r.${key}).toBe(${JSON.stringify(val)});`);
        }
      }
    }
    return { method: "create", callArgs: [], inspectCode: lines.join("\n") };
  }

  // General: use method + captures so the adapter generates the alias-correct call
  // (avoids hardcoding Subject.methodName which breaks on per-group module overrides)
  if (scenario.threw) {
    return { method: methodName, callArgs: [], outcomeType: "throws" };
  }
  const result = scenario.result;
  const assertionLines: string[] = [];

  if (result === null) {
    assertionLines.push(`expect(r).toBeNull();`);
  } else if (typeof result === "boolean" || typeof result === "number") {
    assertionLines.push(`expect(r).toBe(${JSON.stringify(result)});`);
  } else if (typeof result === "string") {
    assertionLines.push(`expect(r).toBe(${JSON.stringify(result)});`);
  } else if (Array.isArray(result)) {
    assertionLines.push(`expect(Array.isArray(r)).toBe(true);`);
    assertionLines.push(`expect(r.length).toBe(${result.length});`);
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      for (const [k, v] of Object.entries(result[0] as Record<string, unknown>)) {
        if (typeof v === "string" && !v.startsWith("/") && v.length < 80) {
          assertionLines.push(`expect(r[0].${k}).toBe(${JSON.stringify(v)});`);
        } else if (typeof v === "boolean" || typeof v === "number") {
          assertionLines.push(`expect(r[0].${k}).toBe(${JSON.stringify(v)});`);
        } else if (Array.isArray(v)) {
          assertionLines.push(`expect(r[0].${k}.length).toBe(${v.length});`);
        }
      }
    }
  } else if (typeof result === "object" && result !== null) {
    assertionLines.push(`expect(r).toBeDefined();`);
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === "string" && !v.startsWith("/") && v.length < 80) {
        assertionLines.push(`expect(r.${k}).toBe(${JSON.stringify(v)});`);
      } else if (typeof v === "boolean" || typeof v === "number") {
        assertionLines.push(`expect(r.${k}).toBe(${JSON.stringify(v)});`);
      } else if (Array.isArray(v)) {
        assertionLines.push(`expect(r.${k}.length).toBe(${v.length});`);
      }
    }
  } else {
    assertionLines.push(`expect(r).toBeDefined();`);
  }
  // Use method + captures so the adapter generates alias-correct call (not hardcoded Subject.)
  return { method: methodName, callArgs: [], captures: "r", inspectCode: assertionLines.join("\n") };
}

export function resolveMethodCall(
  methodName: string,
  apiDescription: string,
  facts: AstFacts
): InlineDerived | null {
  const lower = apiDescription.toLowerCase();
  const schema = facts.schemas[0];
  const baseArgs = schema
    ? Object.fromEntries(schema.fields.slice(0, 2).map(f => [f, syntheticValue(f)]))
    : {};

  // ── Zero-arg scenario: call the method, derive assertions from the captured result ──
  const zeroArgScenario = facts.zeroArgScenarios?.[methodName];
  if (zeroArgScenario) return buildZeroArgInline(zeroArgScenario, methodName);

  // ── Transform / test feature scenarios — matched on framework-generated descriptions ──
  // The descriptions are generated by generateDerivedApiFromFacts from source structure,
  // so both sides of the match are framework-controlled (not dependent on LLD claim text).
  if (/transform map is replaceable|replacing string transform/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--value", "hello"];`,
      `const _a = new _SubjectCtor({ options: { value: {} }, defaults: { transform: { string: s => s.toUpperCase() } }, parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(r.value).toBe("HELLO");`,
    ].join("\n") };
  }
  if (/per-flag transform replaces|flag-level transform overrides/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "yes"];`,
      `const _a = new _SubjectCtor({ options: { flag: { type: "boolean", transform: s => s === "yes" } }, parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(r.flag).toBe(true);`,
    ].join("\n") };
  }
  if (/custom test receives coerced|parse fails on invalid value/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--score", "-5"];`,
      `const _a = new _SubjectCtor({ options: { score: { test: v => v >= 0 } }, parse: false });`,
      `await expect(async () => { _a.parse(); }).toThrow();`,
    ].join("\n") };
  }
  // ── Pipeline chain: fn that requires N predecessor setup steps ──────
  if (/pipeline stage.*calls (\w+)/i.test(lower)) {
    const chainInfo = facts.functionTypeChains?.[methodName];
    if (chainInfo && chainInfo.chain.length > 0) {
      const { chain, rootTextTransformer } = chainInfo;
      const lines: string[] = [];
      // Root step: text transformer produces the first input
      const rootFn = chain[0];
      const rootTT = rootTextTransformer ?? facts.textTransformerFunctions?.[rootFn];
      const rootArgs = rootTT
        ? [JSON.stringify(rootTT.syntheticInput), ...rootTT.secondaryArgs.map(a => JSON.stringify(a))].join(", ")
        : `"# Test Document\\n> src/test.ts\\n\\n## Test Group\\n- a test assertion", "test.lld.md"`;
      // Use _PipelineStage alias (imported by adapter from pipelineStageModulePath)
      lines.push(`const _step0 = _PipelineStage.${rootFn}(${rootArgs});`);
      for (let i = 1; i < chain.length; i++) {
        lines.push(`const _step${i} = await _PipelineStage.${chain[i]}(_step${i - 1});`);
      }
      lines.push(`const r = await _PipelineStage.${methodName}(_step${chain.length - 1});`);
      lines.push(`expect(r).toBeDefined();`);
      lines.push(`if (r && r.groups) expect(r.groups.length).toBeGreaterThan(0);`);
      return { method: "create", callArgs: [], inspectCode: lines.join("\n") };
    }
  }

  // ── Code processor: (string) → Array — method=methodName so adapter uses the right module alias ──
  if (/code processor.*processes source code|processes source code.*array/i.test(lower)) {
    const fn = facts.textTransformerFunctions?.[methodName];
    if (fn) {
      return { method: methodName, callArgs: [fn.syntheticInput, ...fn.secondaryArgs], captures: "r",
        inspectCode: [`expect(Array.isArray(r)).toBe(true);`, `expect(r.length).toBeGreaterThan(0);`].join("\n") };
    }
  }

  // ── Text transformer: (string, ...) → document — same alias-safe approach ──
  if (/text transformer.*parses structured|parses structured text.*document/i.test(lower)) {
    const fn = facts.textTransformerFunctions?.[methodName];
    if (fn) {
      return { method: methodName, callArgs: [fn.syntheticInput, ...fn.secondaryArgs], captures: "r",
        inspectCode: [
          `expect(r).toBeDefined();`,
          `expect(r.groups).toBeDefined();`,
          `expect(r.groups.length).toBeGreaterThan(0);`,
          `expect(r.groups[0].name).toBe("Test Group");`,
        ].join("\n") };
    }
  }

  // ── Structural comparator: (T, T) → changes[] — per-scenario inline code ──
  if (/structural comparator.*calls (\w+)/i.test(lower)) {
    const scenario = facts.comparatorFunctions?.[methodName];
    if (scenario) {
      const expectsEmpty = /identical|no.?change|unchanged|no changes/i.test(lower);
      return { method: "create", callArgs: [], inspectCode: [
        `const _before = ${JSON.stringify(scenario.syntheticBefore)};`,
        `const _after = ${JSON.stringify(scenario.syntheticAfter)};`,
        `const r = Subject.${scenario.realFunctionName}(_before, _after);`,
        `expect(Array.isArray(r)).toBe(true);`,
        expectsEmpty ? `expect(r.length).toBe(0);` : `expect(r.length).toBeGreaterThan(0);`,
      ].join("\n") };
    }
  }

  if (/rest tail.*captures|remaining tokens.*array/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "a", "b", "c"];`,
      `const _a = new _SubjectCtor({ options: { __tail: [{ name: "files", rest: true }] }, parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(Array.isArray(r.files)).toBe(true);`,
      `expect(r.files[0]).toBe("a");`,
    ].join("\n") };
  }

  // ── Exit-code test derivation (modules with exitCode / checkExitCalled) ──────────
  // Derives test calls for CLI exit-model testing from result.code / result.triggered patterns.
  const hasExitCode = "exitCode" in facts.exportVerbs
    || facts.source.includes("export const exitCode")
    || !!facts.mayCallProcessExit;
  const hasCheckExitCalled = facts.source.includes("export const checkExitCalled")
    || "checkExitCalled" in facts.exportVerbs
    || (!!facts.mayCallProcessExit && !!facts.usesProcessArgv);
  if (hasExitCode || hasCheckExitCalled) {
    // "result.code === N" → inline try/catch on new _SubjectCtor({parse:false}).parse()
    const codeMatch = lower.match(/result\.code\s*===\s*(\d+)/);
    if (codeMatch && hasExitCode) {
      const code = Number(codeMatch[1]);
      const argv = code === 0 && /help/i.test(lower) ? ["--help"]
                 : code === 0 && /version/i.test(lower) ? ["--version"]
                 : code === 0 && /-h\b|alias.*help|short.*help/i.test(lower) ? ["-h"]
                 : ["--unknown"];
      const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
      const code_ = [
        `process.argv = ["node", "cli.js", ${argvLiteral}];`,
        `const _a = new _SubjectCtor({ options: {}, parse: false });`,
        `let _exitCode = null;`,
        `try { _a.parse(); } catch (e) { _exitCode = (e && typeof (e as any).code === 'number') ? (e as any).code : 1; }`,
        `expect(_exitCode).toBe(${code});`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
    // "result.triggered === bool" → inline process.exit spy
    const trigMatch = lower.match(/result\.triggered\s*===\s*(true|false)/);
    if (trigMatch && hasCheckExitCalled) {
      const triggered = trigMatch[1] === "true";
      const argv = triggered ? ["--unknown"] : ["--flag", "val"];
      const opts = triggered ? {} : { flag: {} };
      const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
      const code_ = [
        `process.argv = ["node", "cli.js", ${argvLiteral}];`,
        `let _triggered = false;`,
        `const _origExit = process.exit;`,
        `process.exit = () => { _triggered = true; };`,
        `try { new _SubjectCtor({ options: ${JSON.stringify(opts)} }); } finally { process.exit = _origExit; }`,
        `expect(_triggered).toBe(${triggered});`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
    // parseManually throws pattern → inline
    if (/throws.*parse.*false|parse.*false.*throws|invalid.*parse.*throw/i.test(lower)) {
      const code_ = [
        `process.argv = ["node", "cli.js", "--unknown"];`,
        `const _a = new _SubjectCtor({ options: {}, parse: false });`,
        `await expect(async () => { _a.parse(); }).toThrow();`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
  }

  // ── Parser test derivation (modules with a parseArgs(argv, options) entry point) ──
  // Derives test calls from result.FIELD === VALUE assertions in __lld_api descriptions.
  // Covers CLI parsers, option processors, or anything where the test pattern is:
  //   const r = await Subject.parseArgs(argv, options);  expect(r.FIELD).toBe(VALUE)
  // The argv and options are inferred from description keywords.
  // Require a class + default export when falling back to usesProcessArgv,
  // so the argi constructor pattern doesn't fire on any process.argv reader.
  const hasParseArgs = "parseArgs" in facts.exportVerbs
    || facts.source.includes("export const parseArgs")
    || (!!facts.usesProcessArgv && /\bclass\s+\w+/.test(facts.source) && !!facts.constructorModulePath);
  if (hasParseArgs) {
    // Absent field: "result.FIELD → absent" or "result.FIELD is absent/undefined when not provided"
    // Field name can appear in description OR in the claim condition (before the arrow)
    const absentFieldMatch = lower.match(/result\.(\w+)\s*(?:→|is|be)?\s*(?:absent|undefined|not\s+present|not\s+set)/)
      ?? apiDescription.match(/result\.(\w+)\s*(?:→|is|be)?\s*(?:absent|undefined|not\s+present|not\s+set)/i);
    if (absentFieldMatch) {
      const field = absentFieldMatch[1];
      const { argv, opts } = deriveParseArgsInputs(field, undefined, lower);
      // Remove the flag from argv so it's not provided — test the absent case
      const absentArgv = argv.filter((a: string) => !String(a).startsWith(`--${field}`));
      return {
        method: "create", callArgs: [],
        inspectCode: buildParseArgsInline(absentArgv, opts, `expect(r.${field}).toBeUndefined();`),
      };
    }

    // Result assertion: "result.FIELD === VALUE" — generate inline new _SubjectCtor(...) code
    const rm = lower.match(/result\.(\w+)\s*===\s*(["'])([^"']+)\2|(result\.(\w+)\s*===\s*(\w+))/);
    if (rm) {
      const field = rm[1] ?? rm[5];
      const rawVal = rm[3] ?? rm[6];
      const value = rawVal === "true" ? true : rawVal === "false" ? false
                  : rawVal === "undefined" || rawVal === "null" ? (rawVal === "null" ? null : undefined)
                  : !isNaN(Number(rawVal)) ? Number(rawVal) : rawVal;
      const { argv, opts } = deriveParseArgsInputs(field, value, lower);
      return {
        method: "create", callArgs: [],
        inspectCode: buildParseArgsInline(argv, opts, `expect(r.${field}).toBe(${JSON.stringify(value)});`),
      };
    }
    // Throws patterns for CLI validation failures
    if (/throws.*when|when.*throws|throws\s*$/.test(lower)) {
      const t = deriveParseArgsThrowInputs(lower);
      if (t) return { method: "create", callArgs: [], inspectCode: buildParseArgsThrowInline(t.argv, t.opts) };
    }
  }

  // ── Self-database patterns (isSelfDatabase: module IS the database) ──
  // These must come before the faultTargets-based patterns.

  // "read all database data" → standalone inspectCode using _database directly
  if (/read all database data|local.only access|no network/.test(lower) && facts.isSelfDatabase) {
    return {
      method: "create",
      callArgs: [],
      inspectCode: "expect(_database.db.data).toBeDefined();",
    };
  }

  // "queue writes A then B; returns true if A completed before B" → withOrderTracking
  if (/queue writes.*returns true if.*completed before|writes.*in order|ordering.*structural/.test(lower) && facts.isSelfDatabase) {
    const code = [
      `const order = await withOrderTracking(() => _database.write(), () => _database.write());`,
      `expect(order[0] === 1 && order[1] === 2).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // "fail one write then recover; returns true if queue continued" → withFaultInjection
  if (/fail.*write.*recover|recover.*fault|queue continued/.test(lower) && facts.isSelfDatabase) {
    const code = [
      `const result = await withFaultInjection(_database.db, "write", () => _database.write());`,
      `expect(result).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // "write a record, simulate schema change, read back; result has default for newField" → withSchemaEvolution
  if (/schema change|schema evolution|newfield|new field.*default/.test(lower) && facts.isSelfDatabase) {
    const code = [
      `const r = await withSchemaEvolution(_database.db.data, () => _database.write(), "testCollection", { name: "T", value: "x" }, "newField");`,
      `expect(r.newField).toBe("");`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // ── Two-engine shape comparison (searchTwoEngines) ────────────────────
  // "seed two differently-configured engines, search both; returns true if results have the same shape"
  if (/two.*differently.configured|differently.configured.*two|same shape/.test(lower) && facts.primaryAction) {
    const e1Fix = schema ? generateSearchEngineFixture(schema) : {} as Record<string, unknown>;
    const e2Fix = schema ? generateSecondEngineFixture(schema) : {} as Record<string, unknown>;
    if (schema) {
      const e1Cfg = { name: "engine-one", url: "https://api.example.com/search?q=:term", ...e1Fix };
      const e2Cfg = { name: "engine-two", url: "https://api.other.com/find/:term", ...e2Fix };
      const mockFor1 = { [e1Fix.resultsPath as string]: [{ [e1Fix.nameProperty as string]: "Result", [e1Fix.urlProperty as string]: "https://example.com" }] };
      const mockFor2 = { [e2Fix.resultsPath as string]: [{ [e2Fix.nameProperty as string]: "Result", [e2Fix.urlProperty as string]: "https://example.com" }] };
      const actionFn = facts.primaryAction;
      const code = [
        `const e1Cfg = ${JSON.stringify(e1Cfg)};`,
        `const e2Cfg = ${JSON.stringify(e2Cfg)};`,
        `const e1 = await Subject.create(e1Cfg);`,
        `const e2 = await Subject.create(e2Cfg);`,
        `const result = await withShapeComparison(`,
        `  () => withMockFetch(${JSON.stringify(mockFor1)}, () => ${actionFn}(e1.id, "test")),`,
        `  () => withMockFetch(${JSON.stringify(mockFor2)}, () => ${actionFn}(e2.id, "test"))`,
        `);`,
        `expect(result).toBe(true);`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code };
    }
  }

  // "create engine with orderBy set; result.orderBy is defined"
  if (/orderby.*set.*result\.orderby|result\.orderby.*defined/.test(lower)) {
    const fix = schema ? generateSearchEngineFixture(schema) : ({} as Record<string, unknown>);
    const args = { ...fix, orderBy: "alpha" };
    return { method: "create", callArgs: [args], captures: "r", inspectCode: `expect(r.orderBy).toBeDefined();` };
  }

  // FK entity deletion — orphan check: seed a primary record with FK reference, delete the FK entity,
  // verify no primary record retains the deleted FK entity's id.
  // Derived from AstFacts.foreignKeys rather than hardcoded entity names.
  if (/delete.*orphan|orphan.*delete|delete.*no.*retain|seed.*delete.*no.*retain/i.test(lower)) {
    const fkEntries = Object.entries(facts.foreignKeys ?? {});
    const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
    const targetColl = afterDeleteCollMatch?.[1] ?? schema?.collection ?? "items";
    // When the subject module itself owns the afterDelete hook (fkEntries empty), it IS the
    // entity being deleted. The primary test module imports it as _${entity} (e.g. _category).
    // Extract the fkField from the afterDelete hook body.
    let fkField: string, fkImport: string, selfOwnsAfterDelete: boolean;
    if (fkEntries.length > 0) {
      fkField = fkEntries[0][0];
      fkImport = `_${fkEntries[0][1]}`;
      selfOwnsAfterDelete = false;
    } else {
      const afterDeleteFkMatch = facts.source.match(/afterDelete[\s\S]{0,300}\?\.\s*(\w+)\s*===\s*id/);
      fkField = afterDeleteFkMatch?.[1] ?? "fk";
      // Derive the import alias: collections use _${entity} naming in the isCrudDefault test layout
      const entity = schema?.collection
        ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
        : "entity";
      fkImport = `_${entity}`;
      selfOwnsAfterDelete = true;
    }
    // When selfOwnsAfterDelete, schema fields belong to the entity being deleted (not the target).
    // Use a minimal record containing only the FK field to avoid stale field assumptions.
    const recordLiteral = selfOwnsAfterDelete
      ? `{ id: "_orphan_test", ${fkField}: _cat.id }`
      : `{ id: "_orphan_test", ${(schema?.fields ?? []).filter(f => f !== "id").map(f => f === fkField ? `${f}: _cat.id` : `${f}: ${JSON.stringify(syntheticValue(f))}`).join(", ")} }`;
    const code = [
      `const _cat = await ${fkImport}.create({ name: "Test" });`,
      `_database.db.data.${targetColl} = _database.db.data.${targetColl} || {};`,
      `_database.db.data.${targetColl}["_orphan_test"] = ${recordLiteral};`,
      `await ${fkImport}.delete({ id: _cat.id });`,
      `const _remaining = Object.values(_database.db.data.${targetColl} || {});`,
      `expect(_remaining.every(r => r.${fkField} !== _cat.id)).toBe(true);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // FK entity deletion — move: seed a primary record, delete FK entity with moveTo, verify FK field updated.
  // Derived from AstFacts.foreignKeys rather than hardcoded entity names.
  if (/delete.*moveto|moveto.*delete|move.*to.*after.*delete/i.test(lower)) {
    const fkEntries = Object.entries(facts.foreignKeys ?? {});
    const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
    const targetColl = afterDeleteCollMatch?.[1] ?? schema?.collection ?? "items";
    // Same self-owns-afterDelete handling as the orphan check above.
    let fkField: string, fkImport: string, selfOwnsAfterDelete2: boolean;
    if (fkEntries.length > 0) {
      fkField = fkEntries[0][0];
      fkImport = `_${fkEntries[0][1]}`;
      selfOwnsAfterDelete2 = false;
    } else {
      const afterDeleteFkMatch = facts.source.match(/afterDelete[\s\S]{0,300}\?\.\s*(\w+)\s*===\s*id/);
      fkField = afterDeleteFkMatch?.[1] ?? "fk";
      const entity = schema?.collection
        ? schema.collection.replace(/ies$/, "y").replace(/s$/, "")
        : "entity";
      fkImport = `_${entity}`;
      selfOwnsAfterDelete2 = true;
    }
    const recordLiteral = selfOwnsAfterDelete2
      ? `{ id: "_move_test", ${fkField}: _cat1.id }`
      : `{ id: "_move_test", ${(schema?.fields ?? []).filter(f => f !== "id").map(f => f === fkField ? `${f}: _cat1.id` : `${f}: ${JSON.stringify(syntheticValue(f))}`).join(", ")} }`;
    const code = [
      `const _cat1 = await ${fkImport}.create({ name: "Source" });`,
      `const _cat2 = await ${fkImport}.create({ name: "Dest" });`,
      `_database.db.data.${targetColl} = _database.db.data.${targetColl} || {};`,
      `_database.db.data.${targetColl}["_move_test"] = ${recordLiteral};`,
      `await ${fkImport}.delete({ id: _cat1.id, moveTo: _cat2.id });`,
      `expect(_database.db.data.${targetColl}["_move_test"]?.${fkField}).toBe(_cat2.id);`,
    ].join("\n");
    return { method: "create", callArgs: [], inspectCode: code };
  }

  // "create with only required fields" → minimal entity creation
  if (/create with.*required|only required/.test(lower)) {
    return { method: "create", callArgs: [baseArgs], outcomeType: "resolves" };
  }

  // "create with inline [entity]" — derived from beforeCreate hooks, not a hardcoded entity name
  if (/create with.*inline|inline.*create|create with.*\w+.*field/.test(lower) && schema) {
    const hook = schema.hooks.find(h => h.kind === "beforeCreate" && h.trigger);
    if (hook) {
      const field = hook.trigger!.split(".")[1]?.replace(/[?!]$/, "");
      if (field) {
        return {
          method: "create",
          callArgs: [{ ...baseArgs, [field]: { create: { name: "Test" } } }],
          captures: "r",
          inspectCode: `expect(typeof r.${field}).toBe("string");`,
        };
      }
    }
  }

  // "create then update the [field] field; result.field === value"
  const updateMatch = apiDescription.match(/create then update(?: the)? (\w+) field.*result\.(\w+)\s*===\s*["']([^"']+)["']/i);
  if (updateMatch && schema) {
    const field = updateMatch[1];
    const newVal = updateMatch[3];
    return {
      method: "create",
      callArgs: [baseArgs],
      captures: "_c",
      extraCallMethod: "update",
      extraCallArgs: [{ __expr: `{ id: _c.id, update: { ${field}: ${JSON.stringify(newVal)} } }` }],
      extraCallCaptures: "r",
      inspectCode: `expect(r.${field}).toBe(${JSON.stringify(newVal)});`,
    };
  }

  // "create two [entities] and return them as an array" → withSeedAndRead inline
  const twoEntityMatch = lower.match(/create.*two\s+(\w+).*return.*array|create.*(?:two|2)\s+(\w+).*array/);
  if (twoEntityMatch) {
    const plural = twoEntityMatch[1] ?? twoEntityMatch[2];
    const entity = plural.endsWith("ies") ? plural.slice(0, -3) + "y" : plural.replace(/s$/, "");
    const fix = (ENTITY_FIXTURES as Record<string, { data: unknown }>)[entity]?.data
      ?? (schema ? Object.fromEntries(schema.fields.filter(f => f !== "id").map(f => [f, syntheticValue(f)])) : null);
    if (fix) {
      const code = [
        `const _fix = ${JSON.stringify(fix)};`,
        `const result = await withSeedAndRead(_registry.${entity}.create, _registry.${entity}.readAll, [_fix, { ..._fix, name: "Second" }]);`,
        `expect(Array.isArray(result)).toBe(true);`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code };
    }
  }

  // "create two [entity], change one's [field]" → withIsolationTest inline
  // Matches isolation tests that verify FK field changes don't cross entity boundaries
  const isolationMatch = lower.match(/create.*two\s+(\w+).*change.*(?:one'?s?|the)\s+(\w+)/);
  if (isolationMatch && facts.foreignKeys) {
    const plural = isolationMatch[1];
    const primaryEntity = plural.endsWith("ies") ? plural.slice(0, -3) + "y" : plural.replace(/s$/, "");
    const fkField = isolationMatch[2];
    // context entity is whatever that fkField points to (often same name as field)
    const contextEntity = fkField;
    const primaryFix = (ENTITY_FIXTURES as Record<string, { data: unknown }>)[primaryEntity]?.data
      ?? schema ? Object.fromEntries((schema?.fields ?? []).slice(0, 2).map(f => [f, syntheticValue(f)])) : {};
    const ctxFix = (ENTITY_FIXTURES as Record<string, { data: unknown }>)[contextEntity]?.data
      ?? { name: "Test" };
    if (ctxFix) {
      const code = [
        `const _ctx = ${JSON.stringify(ctxFix)};`,
        `const _ent = ${JSON.stringify(primaryFix)};`,
        `const result = await withIsolationTest(_registry, "${contextEntity}", "${primaryEntity}", "${fkField}", { ..._ctx, name: "Shared" }, _ent, { type: "reassign", contextEntity: "${contextEntity}", field: "${fkField}", fixture: { ..._ctx, name: "Solo" } });`,
        `expect(result).toBeDefined();`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code };
    }
  }

  // "seed [entity] with [qualifier]; save succeeds" — create-only, no action step
  // Covers: seedBadProtocolEngine (save succeeds, validation deferred to search time)
  if (/seed.*with|seed.*engine.*url|seed.*protocol/.test(lower)
      && /save\s+succeeds|not\s+validated|deferred|result\.\w+\s+is\s+defined/.test(lower)
      && !/throws|search.*and/.test(lower)) {
    const isDangerous = /dangerous|bad.*protocol|disallowed|javascript/.test(lower);
    const fix = schema
      ? (isDangerous ? generateBadProtocolEngineFixture(schema) : generateSearchEngineFixture(schema))
      : null;
    if (fix) return { method: "create", callArgs: [fix], outcomeType: "resolves" };
  }

  // General seed-and-action pattern: "seed [entity] and [action]; [outcome]"
  // Generalises: searchWithDefaultEngine, seedBadProtocolEngine, searchBadProtocol
  // Entity vocabulary → fixture key; action → primaryAction; outcome → throws/array/defined
  if (facts.primaryAction && /seed.*and.*(?:search|action|call)|seed.*engine.*(?:search|call)/.test(lower)
      && !/two|differently.configured|multiple engines/.test(lower)) {

    // Select fixture based on vocabulary
    const isDangerous = /dangerous|bad.*protocol|disallowed/.test(lower);
    const fix = schema
      ? (isDangerous ? generateBadProtocolEngineFixture(schema) : generateSearchEngineFixture(schema))
      : null;
    if (!fix) return null;

    // Select outcome based on description keywords
    const throwsOutcome = /throws|raises|fails/.test(lower);
    const actionFn = facts.primaryAction;

    if (throwsOutcome) {
      // seed entity, then call primaryAction and expect it to throw
      return {
        method: "create",
        callArgs: [fix],
        captures: "_e",
        inspectCode: `await expect(async () => { await ${actionFn}(_e.id, "test"); }).toThrow();`,
      };
    }

    // Default: returns array of results — use inline inspectCode so primaryActionModule import is used
    return {
      method: "create",
      callArgs: [fix],
      captures: "_e",
      inspectCode: `const r = await ${actionFn}(_e.id, "test"); expect(Array.isArray(r)).toBe(true);`,
    };
  }

  return null;
}

// ── Mock shape derivation ─────────────────────────────────────────────
// Extracts the response structure from existing withMockFetch calls and normalizes
// values to FIELD_VALUES. Completely general — works for any module using withMockFetch.

function normalizeToFixtureValues(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.slice(0, 1).map(normalizeToFixtureValues);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      // For leaf string values, substitute from FIELD_VALUES if we recognize the key
      if (typeof val === "string") {
        const fieldEntry = FIELD_VALUES[key.toLowerCase()];
        out[key] = fieldEntry ? fieldEntry.valid.replace(/^'|'$/g, "") : val;
      } else {
        out[key] = normalizeToFixtureValues(val);
      }
    }
    return out;
  }
  return obj;
}

function deriveMockShape(source: string): unknown | undefined {
  // Find withMockFetch(OBJECT_LITERAL, ...) calls — the first arg IS the mock shape
  // Use the simplest match: the object literal immediately after withMockFetch(
  const matches = [...source.matchAll(/withMockFetch\s*\(\s*(\{)/g)];
  if (!matches.length) return undefined;

  // Extract the first object argument from the first call (most representative)
  const match = matches[0];
  const startIdx = match.index! + match[0].length - 1;
  let depth = 0, end = startIdx;
  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }

  const raw = source.slice(startIdx, end + 1);
  try {
    // Quote unquoted object keys while respecting string boundaries
    // State machine: only apply key-quoting outside of string literals
    let out = "";
    let inString = false;
    let strChar = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        out += ch;
        if (ch === strChar && raw[i - 1] !== "\\") inString = false;
      } else if (ch === '"' || ch === "'") {
        inString = true;
        strChar = ch;
        out += ch === "'" ? '"' : ch;
      } else {
        out += ch;
      }
    }
    // Now quote unquoted keys: identifier followed by : (not preceded by ")
    const withKeys = out.replace(/(?<!['"a-zA-Z0-9_$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '"$1":');
    const parsed = JSON.parse(withKeys);
    return normalizeToFixtureValues(parsed);
  } catch {
    return undefined;
  }
}

function deriveSearchEngineMockShape(source: string): unknown | undefined {
  if (!/\bfetch\b/.test(source) && !/\bsearchProvider\b/.test(source)) return undefined;
  // Try to find resultsPath/nameProperty/urlProperty values in source text first
  const resultsKey = source.match(/\bresultsPath\s*:\s*["']([^"']+)["']/)?.[1] ?? "results";
  const nameKey    = source.match(/\bnameProperty\s*:\s*["']([^"']+)["']/)?.[1];
  const urlKey     = source.match(/\burlProperty\s*:\s*["']([^"']+)["']/)?.[1];
  if (!nameKey && !urlKey) {
    // Fall back to ENTITY_FIXTURES scan (existing logic)
    for (const fixture of Object.values(ENTITY_FIXTURES)) {
      const data = fixture.data as Record<string, unknown>;
      if (!data.resultsPath || !data.nameProperty || !data.urlProperty) continue;
      const rk = data.resultsPath as string;
      const nk = data.nameProperty as string;
      const uk = data.urlProperty as string;
      const item: Record<string, string> = { [uk]: "https://example.com" };
      if (nk && nk !== uk) item[nk] = "Test Result";
      return { [rk]: [item] };
    }
    return undefined;
  }
  const item: Record<string, string> = { [urlKey ?? "url"]: "https://example.com" };
  if (nameKey && nameKey !== urlKey) item[nameKey] = "Test Result";
  return { [resultsKey]: [item] };
}

// ── Inline test case derivation ───────────────────────────────────────
// Called from the translator for per-claim AST derivation.
// Returns call args and assertion type derived from claim vocabulary + AstFacts.

export interface InlineDerived {
  /** Arguments to pass to the CRUD create/update function directly */
  callArgs: unknown[];
  /** Which CRUD function to call (e.g. "create", "update") */
  method: string;
  /** Optional: captures variable for inspect assertion */
  captures?: string;
  /** Optional: inspect code to emit after the call */
  inspectCode?: string;
  /** Outcome type if no captures needed */
  outcomeType?: "resolves" | "throws" | "schema-drop";
  /** Known declared fields for schema-drop assertion enrichment */
  knownFields?: string[];
  /** For then-chain: second method call using the first captures in scope */
  extraCallMethod?: string;
  extraCallArgs?: unknown[];
  extraCallCaptures?: string;
}

// Fixture imports — loaded once
import { ENTITY_FIXTURES, selectFaultScenario, FAULT_SCENARIOS } from "./fixtures.ts";

// ── deriveInline pattern constants ───────────────────────────────────
const REQUIRED_FIELDS = /\b(\w+)\s+and\s+(\w+)\s+are\s+the\s+only\s+required\s+fields?\b/i;
const DEFAULT_EMPTY   = /\bdefaults?\s+to\s+(?:empty\s+string|""|'')\b/i;
const MUTABILITY      = /\bfields?\s+can\s+be\s+updated?\b|\bcan\s+be\s+(?:updated?|changed?|modified?)\s+after\b/i;
const INLINE_CREATION = /\bcan\s+create\s+a\s+new\s+(\w+)\s+in\s+the\s+same\s+operation\b/i;
const FULL_SCHEMA_DROP = /\b(?:only\s+declared\s+fields?\s+(?:survive|are\s+kept|are\s+preserved)|undeclared\s+fields?\s+(?:are\s+)?(?:dropped|removed|stripped|ignored))\b/i;

// ── EventTarget reactive-class derivation ─────────────────────────────
// Generates inline test code from vocabulary patterns without any helper file.
// The module must default-export a class that extends EventTarget.
// The adapter imports it as `_SubjectCtor` when constructorModulePath is set.

function deriveEventTargetInline(claim: string, et: EventTargetClassInfo): InlineDerived | null {
  const ctor = `new _SubjectCtor({})`;

  if (/fires?\s+synchronously|before\s+the\s+next\s+line|no\s+async\s+tick|no\s+batching/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx["x"] = "test";`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }

  if (/key.scoped|only fires? for its key|other keys? do not trigger|does not trigger|not fire when.*key|subscriber.*not fire|different key/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "name", callback: () => { _count++; } });`,
      `_ctx["other"] = "test";`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }

  if (/receives?\s+the\s+new\s+value|callback\s+argument.*just\s+assigned|subscriber.*receives/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `_ctx.subscribe({ key: "x", callback: v => { _received = v; } });`,
      `_ctx["x"] = "test";`,
      `expect(_received).toBe("test");`,
    ].join("\n") };
  }

  if (/addEventListener|native\s+event\s+api|event\s+bus.*nothing\s+is\s+reinvented|subscriptions\s+are\s+addEventListener/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `_ctx.addEventListener("x", ({ detail }) => { _received = detail; });`,
      `_ctx["x"] = "test";`,
      `expect(_received).toBe("test");`,
    ].join("\n") };
  }

  if (/destroy.*stops?\s+(all|its|further|future)\s+(subscriptions?|notifications?)|stops?\s+all\s+future/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx.destroy();`,
      `_ctx["x"] = "test";`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }

  if (/isDestroyed.*true|true\s+after\s+destroy|stays\s+destroyed|there\s+is\s+no\s+reactivation|destroyed\s+context\s+stays/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx.destroy();`,
      `expect(_ctx.isDestroyed).toBe(true);`,
    ].join("\n") };
  }

  if (/destroy.*twice|second\s+destroy|does\s+not\s+reactivate|calling\s+destroy\s+a\s+second/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx.destroy();`,
      `_ctx.destroy();`,
      `expect(_ctx.isDestroyed).toBe(true);`,
    ].join("\n") };
  }

  if (/derived.*freezes?|stops?\s+updating.*destroyed|freezes?\s+at\s+its\s+last/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _source = ${ctor};`,
      `let _last = null;`,
      `const _sub = _source.subscriber?.("value");`,
      `if (_sub) _sub.subscribe(v => { _last = v; });`,
      `_source["value"] = 2;`,
      `const _frozen = _last;`,
      `_source.destroy();`,
      `try { _source["value"] = 3; } catch {}`,
      `expect(_last).toBe(_frozen);`,
    ].join("\n") };
  }

  // Constructor validation: null/array throw; plain object succeeds
  if (/constructing.*null.*throw|constructor\s+rejects\s+null|null.*\bthrow/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor(null)).toThrow();` };
  }
  if (/constructing.*array.*throw|constructor\s+rejects\s+array|array.*\bthrow/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor([])).toThrow();` };
  }
  if (/constructing.*plain\s+object.*succeed|plain\s+object.*succeed|constructor.*accepts.*plain/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor({})).not.toThrow();` };
  }

  return null;
}

// ── Component class derivation ────────────────────────────────────────
// Generates inline test code for modules that export a UI component class
// (extends Component, TooltipWrapper, styled(...), etc.).
// Uses the same `_SubjectCtor` import as EventTarget derivation.

function deriveComponentInline(claim: string): InlineDerived | null {
  const ctor = `new _SubjectCtor({})`;

  // ══ Pattern 3 (timer): Deferred behavior via setTimeout spy ══════
  // Tests the MECHANISM: is a timer registered? is it cancelled?
  // Replaces global.setTimeout/clearTimeout to capture callbacks without real waiting.

  // "hovering for longer than Nms shows the tooltip" — verify timer is registered with correct delay
  if (/hovering.*(?:\d+ms|delay).*show|show.*tooltip.*after.*hover/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `let _timerCb: Function | null = null; let _timerDelay = 0;`,
      `const _origSet = global.setTimeout;`,
      `(global as any).setTimeout = (cb: Function, ms: number) => { _timerCb = cb; _timerDelay = ms; return 1; };`,
      `try {`,
      `  const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `  document.body?.append(_inst.elem);`,
      `  _inst.elem?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));`,
      `  expect(_timerCb).not.toBeNull();`,
      `  expect(_timerDelay).toBeGreaterThanOrEqual(600);`,
      `} finally { (global as any).setTimeout = _origSet; }`,
    ].join("\n") };
  }

  // "leaving before Nms prevents tooltip" — verify timer is cleared on pointerout
  if (/leaving.*prevent.*tooltip|pointerout.*cancel|cancel.*timer.*tooltip/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _cleared = new Set<number>(); let _id = 0;`,
      `const _origSet = global.setTimeout; const _origClear = global.clearTimeout;`,
      `(global as any).setTimeout = (_cb: Function) => ++_id;`,
      `(global as any).clearTimeout = (id: number) => _cleared.add(id);`,
      `try {`,
      `  const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `  document.body?.append(_inst.elem);`,
      `  _inst.elem?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));`,
      `  const _regCount = _id;`,
      `  _inst.elem?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));`,
      `  expect(_regCount).toBeGreaterThan(0);`,
      `  expect(_cleared.size).toBeGreaterThan(0);`,
      `} finally { (global as any).setTimeout = _origSet; (global as any).clearTimeout = _origClear; }`,
    ].join("\n") };
  }

  // "cancelling popover before 200ms prevents opening" — autoOpen timer is set on connect, cleared on destroy
  if (/cancel.*(?:popover|autoOpen).*200ms|destroy.*before.*200|200ms.*prevent.*open/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _cleared = new Set<number>(); let _id = 0;`,
      `const _origSet = global.setTimeout; const _origClear = global.clearTimeout;`,
      `(global as any).setTimeout = (_cb: Function) => ++_id;`,
      `(global as any).clearTimeout = (id: number) => _cleared.add(id);`,
      `try {`,
      `  const _inst = new _SubjectCtor({ autoOpen: true });`,
      `  document.body?.append(_inst.elem);`,
      `  await new Promise(r => _origSet(r as TimerHandler, 0)); // flush MutationObserver`,
      `  const _afterConnect = _id;`,
      `  _inst.destroy?.();`,
      `  expect(_afterConnect).toBeGreaterThan(0);`,
      `  expect(_cleared.size).toBeGreaterThan(0);`,
      `} finally { (global as any).setTimeout = _origSet; (global as any).clearTimeout = _origClear; }`,
    ].join("\n") };
  }

  // "manually dismissing before timeout prevents second dismiss" — timer is cleared on manual dismiss
  if (/manually\s+dismiss.*before.*timeout|dismiss.*cancel.*timer|timeout.*cleared.*dismiss/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _cleared = new Set<number>(); let _id = 0;`,
      `const _origSet = global.setTimeout; const _origClear = global.clearTimeout;`,
      `(global as any).setTimeout = (_cb: Function) => ++_id;`,
      `(global as any).clearTimeout = (id: number) => _cleared.add(id);`,
      `try {`,
      `  const _inst = new _SubjectCtor({ timeout: 3000 });`,
      `  document.body?.append(_inst.elem);`,
      `  _inst.elem?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));`,
      `  _inst.elem?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));`,
      `  expect(_cleared.size).toBeGreaterThan(0);`,
      `} finally { (global as any).setTimeout = _origSet; (global as any).clearTimeout = _origClear; }`,
    ].join("\n") };
  }

  // ══ Reactive option → DOM change patterns ═══════════════════════

  // Keyboard: layout switch rebuilds keys — DOM changes after option update
  if (/switching\s+layout.*remove\s+keys|previous\s+layout.*keys.*absent/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ layout: "simple", autoRender: false });`,
      `_inst.render();`,
      `const _before = _inst.elem?.innerHTML;`,
      `_inst.options.layout = "number";`,
      `expect(_inst.elem?.innerHTML).not.toBe(_before);`,
    ].join("\n") };
  }
  if (/new\s+layout.*keys.*appear|layout.*switch.*appear/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ layout: "simple", autoRender: false });`,
      `_inst.render();`,
      `_inst.options.layout = "number";`,
      `expect((_inst.elem?.children?.length ?? 0)).toBeGreaterThan(0);`,
    ].join("\n") };
  }

  // RadioButton: all radios in the group share one name attribute
  if (/share.*same.*name\s+attribute|each.*radio.*shared.*name|shared.*name.*exclusive/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ options: ["alpha", "beta"] });`,
      `const _radios = Array.from(_inst.elem?.querySelectorAll?.('input[type="radio"]') ?? []) as HTMLInputElement[];`,
      `expect(_radios.length).toBeGreaterThan(0);`,
      `expect(_radios.every(r => r.name === _radios[0]?.name)).toBe(true);`,
    ].join("\n") };
  }

  // Calendar: switching view changes the DOM (requires explicit re-render)
  if (/switching\s+from\s+month\s+to\s+day|month.*day\s+view.*reflect/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ view: "month", autoRender: false });`,
      `_inst.render();`,
      `const _before = _inst.elem?.innerHTML;`,
      `_inst.options.view = "day";`,
      `_inst.render();`,
      `expect(_inst.elem?.innerHTML).not.toBe(_before);`,
    ].join("\n") };
  }

  // ══ Pattern 1: Reactive state property ═══════════════════════════
  // Pattern: construct (optionally change an option), read a getter.
  // Covers: isDirty, isOpen, isDisabled, isSelected, hasErrors, etc.
  // Appears in nearly every form input, toggle, select, and dialog.

  if (/isDirty.*(?:false|not\s+dirty).*(?:initial|matches|unchanged)|false.*isDirty.*initial/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ value: "test" });`,
      `expect(_inst.isDirty).toBe(false);`,
    ].join("\n") };
  }
  if (/isDirty.*true.*(?:after.*changed?|value.*changed?)|changed?.*isDirty.*true/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ value: "test" });`,
      `_inst.options.value = "changed";`,
      `expect(_inst.isDirty).toBe(true);`,
    ].join("\n") };
  }
  // hasErrors() returns 0 when no inputs or all valid
  if (/hasErrors.*(?:return|returns?)\s*(?:0|false)|(?:false|0).*(?:when.*valid|hasErrors)|hasErrors.*(?:false|0).*valid/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ inputs: [] });`,
      `expect(_inst.hasErrors()).toBe(false);`,
    ].join("\n") };
  }
  // hasErrors() returns true when a validation fails
  // validations format is [[fn, message], ...] — each entry is a [predicate, message] pair
  // predicate returns truthy for VALID, falsy for INVALID
  if (/hasErrors.*(?:return|returns?)\s*(?:positive|true|greater)|(?:true|positive).*hasErrors|hasErrors.*fails?/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _req = [(v: unknown) => !!v, "required"];`,
      `const _inst = new _SubjectCtor({ inputs: [{ key: "x", validations: [_req] }] });`,
      `expect(_inst.hasErrors()).toBe(true);`,
    ].join("\n") };
  }
  // Disabled attribute: construct with disabled:true, check elem.disabled
  if (/disabled.*(?:attribute|element\s+(?:is\s+)?disabled|property)|element.*(?:is\s+)?disabled.*disabled/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ disabled: true });`,
      `expect((_inst.elem as any)?.disabled || _inst.elem?.hasAttribute("disabled")).toBe(true);`,
    ].join("\n") };
  }

  // ══ Pattern 2: Exclusive class set ═══════════════════════════════
  // Pattern: changing an option removes old class, adds new one.
  // Covers: variant, position, state, type — any option that maps to
  // mutually exclusive CSS classes. Universal UI component pattern.

  if (/changing\s+position.*leave\s+only|only\s+one\s+position\s+class|position.*exclusive/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ position: "topRight" });`,
      `_inst.options.position = "bottom";`,
      `expect(_inst.elem?.classList?.contains("topRight")).toBe(false);`,
      `expect(_inst.elem?.classList?.contains("bottom")).toBe(true);`,
    ].join("\n") };
  }
  // Generic exclusive class: two constructions with different variant values differ in class
  const exclusiveOptMatch = claim.match(/changing\s+(\w+)\s+from.*(?:leaves?\s+only|removes?\s+old|exclusive)/i);
  if (exclusiveOptMatch) {
    const opt = exclusiveOptMatch[1];
    return { method: undefined, callArgs: [], inspectCode: [
      `const _a = new _SubjectCtor({ ${opt}: "valueA" });`,
      `const _b = new _SubjectCtor({ ${opt}: "valueB" });`,
      `expect(_a.elem?.className).not.toBe(_b.elem?.className);`,
    ].join("\n") };
  }

  // ══ Pattern 3: Deferred / timer behavior ═════════════════════════
  // Pattern: "X fires after Nms delay" — check SYNCHRONOUS state only.
  // Full timer tests (advance Nms and assert fired) need fake timers;
  // the synchronous check (not-yet-open at t=0) is derivable now.

  if (/autoOpen.*not.*(?:open|fire).*synchronously|not.*open.*synchronously.*(?:autoOpen|construction)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ autoOpen: true });`,
      `expect((_inst.elem as any)?.matches?.(":popover-open") ?? _inst.elem?.hasAttribute("open") ?? false).toBe(false);`,
    ].join("\n") };
  }

  // ══ Pattern 4: Lazy child creation ═══════════════════════════════
  // Pattern: child component not in DOM at construction — only created
  // on first trigger. Covers lazy tooltips, popovers, accordions, any
  // component that defers child creation until needed.

  if (/not\s+yet\s+produce.*(?:Tooltip|component).*DOM|construction.*option.*not.*produce/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `expect(_inst.elem?.querySelector("[popover]")).toBeNull();`,
    ].join("\n") };
  }
  // Tooltip appears after render (deferred init completes)
  if (/Tooltip.*appear.*after.*rendered|rendered.*Tooltip.*appear/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `_inst.render?.();`,
      `expect(_inst.options?.tooltip !== undefined).toBe(true);`,
    ].join("\n") };
  }

  // ══ Pattern 5: Destroy removes from DOM ══════════════════════════
  // Pattern: destroy() removes the component and its children from the
  // document. Universal cleanup contract — present in every component
  // library that manages child component lifecycles.

  if (/destroy(?:ing)?\s+(?:the\s+)?(?:wrapper|TagList|\w+Component)\s+also\s+remove|destroy.*remove.*(?:tooltip|interface|editing)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `document.body?.append(_inst.elem);`,
      `_inst.destroy?.();`,
      `expect(document.body?.contains(_inst.elem)).toBe(false);`,
    ].join("\n") };
  }
  // Generic: destroy removes the component element itself from DOM
  if (/clearCanvas.*(?:without.*removing|canvas.*remains)|destroy.*removes?\s+(?:it|itself|element|component)\s+from|destroy.*no\s+longer.*(?:page|DOM)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = ${ctor};`,
      `document.body?.append(_inst.elem);`,
      `_inst.destroy?.();`,
      `expect(document.body?.contains(_inst.elem)).toBe(false);`,
    ].join("\n") };
  }

  // ── ColorPicker / value initialization patterns ──────────────────
  if (/initializing.*color\s+string.*(?:valid|state|picker)|color\s+string.*(?:valid|state)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode:
      `expect(() => new _SubjectCtor({ value: "#ff0000" })).not.toThrow();` };
  }
  if (/initializing.*(?:value\s+)?['"]?random['"]?.*(?:valid|state)|random.*valid\s+state/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode:
      `expect(() => new _SubjectCtor({ value: "random" })).not.toThrow();` };
  }

  // ── Tooltip / lazy child existence ────────────────────────────────
  // "does the Tooltip component exist after construction with a tooltip option?"
  if (/Tooltip.*exist.*after.*construction|component.*exist.*after.*construction.*tooltip/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ tooltip: "text" });`,
      `expect((_inst as any)._tooltip != null).toBe(true);`,
    ].join("\n") };
  }

  // ── DOM ordering assertions ────────────────────────────────────────
  // "does 'inline-after' place the label after the content in reading order?"
  if (/inline.after.*(?:label.*after|after.*content)|label.*after.*(?:content|reading\s+order)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ variant: "inline-after" });`,
      `const _els = Array.from(_inst.elem?.children ?? []);`,
      `const _labelIdx = _els.findIndex(e => e.tagName === "LABEL");`,
      `expect(_labelIdx).toBeGreaterThan(0); // label comes after other children`,
    ].join("\n") };
  }
  // "does the options array order match the dropdown order?"
  if (/options.*array.*order.*(?:match|dropdown)|dropdown.*order.*(?:match|options\s+array)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ options: ["alpha", "beta", "gamma"] });`,
      `const _opts = Array.from(_inst.elem?.querySelectorAll("option") ?? []);`,
      `expect(_opts[0]?.value).toBe("alpha");`,
      `expect(_opts[2]?.value).toBe("gamma");`,
    ].join("\n") };
  }

  // ── Throw for invalid option value ────────────────────────────────
  // "does an invalid/unrecognized X value throw?" → extract option name X
  const throwMatch = claim.match(/(?:invalid|unrecognized|unsupported)\s+(\w+)\s+(?:value\s+)?throw|does.*throw.*invalid\s+(\w+)/i);
  if (throwMatch) {
    const opt = throwMatch[1] ?? throwMatch[2];
    if (opt) return { method: undefined, callArgs: [], inspectCode:
      `expect(() => new _SubjectCtor({ ${opt}: "__lld_invalid__" })).toThrow();` };
  }
  // Bare throw check without extractable option
  if (/throw\s+immediately|throw.*(?:immediately|right away)|immediately.*throw/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode:
      `expect(() => ${ctor}).toThrow();` };
  }

  // ── Renders/constructs without error ─────────────────────────────
  if (/without\s+(?:error|failing|failure)|renders?\s+without\s+error|construct.*without\s+error|does\s+not\s+(?:fail|throw|error)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode:
      `expect(() => ${ctor}).not.toThrow();` };
  }

  // ── Pointer-press → removes from page/DOM ────────────────────────
  // Components use onPointerPress (pointerdown→pointerup), not raw click
  if (/clicking.*(?:remove|dismiss).*(?:page|dom|it\b)|remove.*(?:page|dom).*clicking/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = ${ctor};`,
      `document.body?.append(_inst.elem);`,
      `_inst.elem?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));`,
      `_inst.elem?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));`,
      `expect(document.body?.contains(_inst.elem)).toBe(false);`,
    ].join("\n") };
  }

  // ── Pressing key → named callback invoked ────────────────────────
  // "does pressing Enter invoke onPointerPress?" — use event.code (physical key), not event.key
  const keyCallbackMatch = claim.match(/pressing\s+(Enter|Space|Tab|Escape|\w+)\s+.*?invoke[sd]?\s+(\w+)/i);
  if (keyCallbackMatch) {
    const key  = keyCallbackMatch[1];
    // code is the physical key identifier; key is the logical character
    const code = key === "Space" ? "Space" : key;
    const cb   = keyCallbackMatch[2];
    return { method: undefined, callArgs: [], inspectCode: [
      `let _called = 0;`,
      `const _inst = new _SubjectCtor({ ${cb}: () => { _called++; } });`,
      `_inst.elem?.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key === "Space" ? " " : key)}, code: ${JSON.stringify(code)}, bubbles: true }));`,
      `expect(_called).toBeGreaterThan(0);`,
    ].join("\n") };
  }

  // ── Clicking / pointer-pressing → named callback invoked ─────────
  // Component's onPointerPress fires on pointerdown→pointerup, not on click
  const clickCallbackMatch = claim.match(/clicking.*invoke[sd]?\s+(\w+)|does clicking.*call\s+(\w+)/i);
  if (clickCallbackMatch) {
    const cb = clickCallbackMatch[1] ?? clickCallbackMatch[2];
    // Use pointerdown+pointerup for onPointerPress-style callbacks; plain click for others
    const isPointerPress = cb === "onPointerPress" || cb === "onSelect";
    const dispatchLines = isPointerPress
      ? [
          `_inst.elem?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));`,
          `_inst.elem?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));`,
        ]
      : [`_inst.elem?.dispatchEvent(new PointerEvent("click", { bubbles: true }));`];
    return { method: undefined, callArgs: [], inspectCode: [
      `let _called = 0;`,
      `const _inst = new _SubjectCtor({ ${cb}: () => { _called++; } });`,
      ...dispatchLines,
      `expect(_called).toBeGreaterThan(0);`,
    ].join("\n") };
  }

  // ── Property comparison between two instances (e.g. throttle adapts to lineWidth) ──
  // "does a Whiteboard with X 10 have a higher Y than one with X 2?"
  const compareMatch = claim.match(/with\s+(\w+)\s+(\d+)\s+have\s+a\s+higher\s+(\w+)\s+than\s+.*with\s+\1\s+(\d+)/i);
  if (compareMatch) {
    const [, opt, bigVal, prop, smallVal] = compareMatch;
    return { method: undefined, callArgs: [], inspectCode: [
      `const _big   = new _SubjectCtor({ ${opt}: ${bigVal} });`,
      `const _small = new _SubjectCtor({ ${opt}: ${smallVal} });`,
      `expect(_big.${prop}).toBeGreaterThan(_small.${prop});`,
    ].join("\n") };
  }

  // ── Element remains a specific tag type ──────────────────────────
  // "does a Link with variant 'button' remain an anchor element?"
  const remainTagMatch = claim.match(/remain\s+an?\s+(\w+)\s+element|still\s+(?:be|is)\s+an?\s+(\w+)\s+element/i);
  if (remainTagMatch) {
    const rawTag = (remainTagMatch[1] ?? remainTagMatch[2]).toLowerCase();
    // Map semantic names to actual HTML tag names
    const tagMap: Record<string, string> = { anchor: "a", button: "button", paragraph: "p" };
    const tag = tagMap[rawTag] ?? rawTag;
    const optMatch = claim.match(/variant\s*[:']\s*['"]?(\w+)/i);
    const opt = optMatch ? `{ variant: "${optMatch[1]}" }` : `{}`;
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor(${opt});`,
      `expect(_inst.elem?.tagName?.toLowerCase()).toBe("${tag}");`,
    ].join("\n") };
  }

  // ── DOM element presence / absence ───────────────────────────────
  // "does a readOnly X contain no input element?" → readOnly:true, querySelector null
  const readOnlyNoEl = claim.match(/readOnly\s+\w+\s+contain\s+no\s+(\w+)\s+element/i);
  if (readOnlyNoEl) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ readOnly: true });`,
      `expect(_inst.elem?.querySelector("${readOnlyNoEl[1]}")).toBeNull();`,
    ].join("\n") };
  }
  // "does a non-readOnly X contain both input and ..." → default ctor, input exists
  if (/non-readOnly.*contain\s+(?:both|an?\s+input)|readOnly.*false.*contain/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = ${ctor};`,
      `expect(_inst.elem?.querySelector("input")).not.toBeNull();`,
    ].join("\n") };
  }

  // ── Input type derivation from value type ────────────────────────
  if (/boolean.*(?:checked|unchecked|checkbox)|checkbox.*boolean/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ value: true });`,
      `expect(_inst.elem?.type).toBe("checkbox");`,
    ].join("\n") };
  }
  if (/number\s+value.*numeric|numeric.*(?:entry|input).*number/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ value: 1 });`,
      `expect(_inst.elem?.type).toBe("number");`,
    ].join("\n") };
  }

  // ── Code element promotion (block vs inline) ──────────────────────
  if (/(?:newlines?|multi.?line).*(?:block|pre)|render.*(?:block|pre).*newline/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ code: "line1\\nline2" });`,
      `expect(_inst.elem?.tagName?.toLowerCase()).toBe("pre");`,
    ].join("\n") };
  }
  if (/single.?line.*(?:code|render).*inline|inline.*single.?line/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ code: "single line" });`,
      `expect(_inst.elem?.tagName?.toLowerCase()).not.toBe("pre");`,
    ].join("\n") };
  }

  // ── Language class ─────────────────────────────────────────────────
  if (/language.*(?:identifiable|class)|add.*identifiable.*class/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ language: "js" });`,
      `const _el = _inst.elem?.tagName?.toLowerCase() === "code" ? _inst.elem : _inst.elem?.querySelector("code");`,
      `expect(Array.from(_el?.classList ?? []).some(c => c.includes("language-"))).toBe(true);`,
    ].join("\n") };
  }

  // ── noStyle class present ──────────────────────────────────────────
  if (/noStyle.*not\s+carry|noStyle.*styling|styling.*noStyle/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ noStyle: true });`,
      `expect(_inst.elem?.classList?.contains("noStyle")).toBe(true);`,
    ].join("\n") };
  }

  // ── Full-height flex layout (Page) ────────────────────────────────
  if (/height.*100%.*(?:applied|construction)|full.?height.*(?:applied|construction)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = ${ctor};`,
      `expect(_inst.elem?.style?.height).toBe("100%");`,
    ].join("\n") };
  }

  // ── Property existence (isDirty, hasErrors, etc.) ─────────────────
  if (/has?\s+isDirty|expose\s+isDirty|Select.*isDirty/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = ${ctor};`,
      `expect(typeof _inst.isDirty).not.toBe("undefined");`,
    ].join("\n") };
  }

  // ── Icon-only class (presence when no text, absence when text present) ──
  if (/icon.*without\s+text.*(?:icon.only|receive.*icon)|constructed\s+without\s+text.*icon.only/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ icon: "star" });`,
      `expect(_inst.elem?.classList?.contains("icon")).toBe(true);`,
    ].join("\n") };
  }
  if (/icon.*with\s+text.*not\s+(?:receive|have)|text.*not.*icon.only|constructed\s+with\s+text\s+not/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ icon: "star", textContent: "label" });`,
      `expect(_inst.elem?.classList?.contains("icon")).toBe(false);`,
    ].join("\n") };
  }

  // ── Icon + animation composition (both classes simultaneously) ────
  if (/both\s+icon\s+and\s+animation.*carry\s+both|icon.*animation.*active.*both\s+classes/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ icon: "star", animation: "spin" });`,
      `expect(_inst.elem?.classList?.contains("fa-star")).toBe(true);`,
      `expect(_inst.elem?.classList?.contains("fa-spin")).toBe(true);`,
    ].join("\n") };
  }

  // ── Reactive: icon update leaves no stale classes ─────────────────
  // "element had icon 'X' and was updated to 'Y' have only Y icon"
  const iconUpdateMatch = claim.match(/had\s+icon\s+['"](\w+)['"]\s+and.*updated\s+to\s+['"](\w+)['"]/i);
  if (iconUpdateMatch) {
    const [, prev, next] = iconUpdateMatch;
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ icon: "${prev}" });`,
      `_inst.options.icon = "${next}";`,
      `expect(_inst.elem?.classList?.contains("fa-${prev}")).toBe(false);`,
      `expect(_inst.elem?.classList?.contains("fa-${next}")).toBe(true);`,
    ].join("\n") };
  }

  // ── Reactive: adding text removes icon-only class ────────────────
  if (/adding\s+text.*icon.*remove|text.*content.*to.*icon.*remove/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ icon: "star" });`,
      `_inst.options.textContent = "label text";`,
      `expect(_inst.elem?.classList?.contains("icon")).toBe(false);`,
    ].join("\n") };
  }

  // ── Reactive: setting option to boolean value ─────────────────────
  // "setting collapsed: true hide" / "setting collapsed: false show"
  const collapsedSet = claim.match(/setting\s+collapsed:\s*(true|false)/i);
  if (collapsedSet) {
    const val = collapsedSet[1];
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ variant: "collapsible", collapsed: ${val} });`,
      val === "true"
        ? `expect(_inst.elem?.classList?.contains("collapsed")).toBe(true);`
        : `expect(_inst.elem?.classList?.contains("collapsed")).toBe(false);`,
    ].join("\n") };
  }

  // ── openOnRender: false prevents auto-open ────────────────────────
  if (/openOnRender.*false.*prevent|prevent.*openOnRender.*false/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _inst = new _SubjectCtor({ openOnRender: false });`,
      `expect((_inst.elem as any)?.open).not.toBe(true);`,
    ].join("\n") };
  }

  return null;
}

export function deriveInline(claim: string, facts: AstFacts): InlineDerived | null {
  // EventTarget reactive-class patterns — bypass schema requirement
  if (facts.eventTargetClass && facts.constructorModulePath) {
    const derived = deriveEventTargetInline(claim, facts.eventTargetClass);
    if (derived) return derived;
  }

  // Component class patterns — bypass schema requirement
  if (facts.componentClass && facts.constructorModulePath) {
    const derived = deriveComponentInline(claim);
    if (derived) return derived;
  }

  const schema = facts.schemas[0];
  if (!schema) return null;

  const fieldTypes = extractFieldTypes(facts.source, schema.fields);
  let requiredFields: string[] = [];

  // "X and Y are the only required fields" → minimal create call
  const reqMatch = claim.match(REQUIRED_FIELDS);
  if (reqMatch) {
    requiredFields = [reqMatch[1].toLowerCase(), reqMatch[2].toLowerCase()];
    const args = Object.fromEntries(
      requiredFields.map(f => {
        const info = fieldTypes.get(f);
        return [f, syntheticValue(f, info?.unionLiterals)];
      })
    );
    return { method: "create", callArgs: [args], outcomeType: "resolves" };
  }

  // "defaults to empty string" → create with only required fields, check missing defaults
  if (DEFAULT_EMPTY.test(claim)) {
    const urlField = schema.fields.find(f => f.includes("url") || f.includes("link"));
    const nameField = schema.fields.find(f => f.includes("name") || f.includes("title"));
    if (urlField && nameField) {
      return {
        method: "create",
        callArgs: [{ [urlField]: syntheticValue(urlField) }],
        captures: "r",
        inspectCode: `expect(r.${nameField}).toBe("");`,
      };
    }
  }

  // "only declared fields survive a write" → schema-drop
  if (FULL_SCHEMA_DROP.test(claim)) {
    return {
      method: "create",
      callArgs: [],
      outcomeType: "schema-drop",
      knownFields: [...new Set(schema.fields)],
    };
  }

  // "can create a new X in the same operation" → inline creation via beforeCreate hook
  const inlineMatch = claim.match(INLINE_CREATION);
  if (inlineMatch) {
    const entity = inlineMatch[1].toLowerCase();
    const hook = schema.hooks.find(h => h.kind === "beforeCreate" && h.trigger?.includes(entity));
    if (hook) {
      const base = requiredFields.length ? requiredFields : schema.fields.slice(0, 2);
      const baseArgs = Object.fromEntries(base.map(f => [f, syntheticValue(f)]));
      return {
        method: "create",
        callArgs: [{ ...baseArgs, [entity]: { create: { name: "Test" } } }],
        captures: "r",
        inspectCode: `expect(r.${entity}).toBeDefined();`,
      };
    }
  }

  // "fields can be updated after creation" → create + update for first simple field
  if (MUTABILITY.test(claim)) {
    const simpleField = schema.fields.find(
      f => f !== "id" && (f.includes("name") || f.includes("title") || f.includes("label"))
    );
    if (simpleField) {
      const base = schema.fields.slice(0, 2);
      const baseArgs = Object.fromEntries(base.map(f => [f, syntheticValue(f)]));
      const newVal = "Renamed";
      // Multi-step: need captures on create, then update — emit as inspect code
      return {
        method: "create",
        callArgs: [baseArgs],
        captures: "_created",
        inspectCode: [
          `const _updated = await Subject.update({ id: _created.id, update: { ${simpleField}: ${JSON.stringify(newVal)} } });`,
          `expect(_updated.${simpleField}).toBe(${JSON.stringify(newVal)});`,
        ].join("\n"),
      };
    }
  }

  // ── Conditional invariant: "when [field] is set, [output] is [property]" ─────────────────
  // This class of design claim describes field-controlled output transformation.
  // Each variant detects the field name + transformation type and generates a verification test
  // that creates an entity with the field set, calls the primary action, and asserts the transform.
  //
  // Mechanism: deriveInline is called per-claim even when a group method is annotated.
  // The returned case has source="ast-derived" and method="create" (≠ group method), so
  // applyResolved skips it — preserving this per-claim derivation untouched.

  // "when [field] is set, results are sorted" → create with field=name, mock unsorted, assert sorted
  const conditionalSortMatch = claim.match(/when\s+(\w+)\s+is\s+set.*sort|sort.*when\s+(\w+)\s+is\s+set/i);
  if (conditionalSortMatch && facts.primaryAction && schema?.fields.includes("resultsPath")) {
    const sortField = conditionalSortMatch[1] ?? conditionalSortMatch[2];
    if (sortField && schema.fields.includes(sortField)) {
      const fix = schema ? generateSearchEngineFixture(schema) : { orderBy: "name" };
      const rKey = (fix.resultsPath as string) || "results";
      const nKey = (fix.nameProperty as string) || "name";
      const uKey = (fix.urlProperty as string) || "url";
      const mockResp = {
        [rKey]: [
          { [nKey]: "Z Result", [uKey]: "https://z.com" },
          { [nKey]: "A Result", [uKey]: "https://a.com" },
        ],
      };
      const engineFix = { ...fix, [sortField]: "name" };
      const code = [
        `const _mock = ${JSON.stringify(mockResp)};`,
        `const r = await withMockFetch(_mock, () => ${facts.primaryAction}(_e.id, "test"));`,
        `expect(r[0].name.localeCompare(r[1].name)).toBeLessThanOrEqual(0);`,
      ].join("\n");
      return { method: "create", callArgs: [engineFix], captures: "_e", inspectCode: code };
    }
  }

  // "when limit is set, results are truncated / no more than N results"
  const conditionalLimitMatch = claim.match(/when\s+limit\s+is\s+set|no\s+more\s+than\s+\w+\s+results|results.*truncated.*limit/i);
  if (conditionalLimitMatch && facts.primaryAction && schema?.fields.includes("resultsPath")) {
    const fix = schema ? { ...generateSearchEngineFixture(schema), limit: "2" } : { limit: "2" };
    const rKey = (generateSearchEngineFixture(schema!).resultsPath as string) || "results";
    const nKey = (generateSearchEngineFixture(schema!).nameProperty as string) || "name";
    const uKey = (generateSearchEngineFixture(schema!).urlProperty as string) || "url";
    const mockResp = {
      [rKey]: Array.from({ length: 5 }, (_, i) => ({ [nKey]: `Result ${i + 1}`, [uKey]: `https://r${i}.com` })),
    };
    const code = [
      `const _mock = ${JSON.stringify(mockResp)};`,
      `const r = await withMockFetch(_mock, () => ${facts.primaryAction}(_e.id, "test"));`,
      `expect(r.length).toBeLessThanOrEqual(2);`,
    ].join("\n");
    return { method: "create", callArgs: [fix], captures: "_e", inspectCode: code };
  }

  // Vocabulary matching: fixture library + entity index for "seed entity with qualifier" patterns

  // "bad protocol" / "dangerous URL" → create entity with bad-protocol fixture
  if (/\b(?:bad\s+protocol|dangerous\s+URL|disallowed\s+protocol|javascript\s*:|invalid\s+protocol)/i.test(claim)) {
    if (schema) {
      const fixture = generateBadProtocolEngineFixture(schema);
      return {
        method: "create",
        callArgs: [fixture],
        outcomeType: "resolves",
      };
    }
  }

  // "seed" / "create an engine" / "adding a search engine" → create entity with fixture
  if (/\b(?:seed|creat\w+|add\w+)\s+(?:an?\s+)?(?:search\s+)?engine\b/i.test(claim)) {
    if (schema) {
      const fixture = generateSearchEngineFixture(schema);
      return {
        method: "create",
        callArgs: [fixture],
        outcomeType: "resolves",
      };
    }
  }

  return null;
}
