// Shared types for the AST-derivation engine -- the dependency-free root every other
// src/ast/* module imports from. No logic here, only shapes.

// `invalid: null` is meaningful and distinct from omitting the key: it records that a field name
// has no meaningful invalid value (any string is a legal `id` or `name`), so a future
// invalid-value derivation knows not to try rather than not knowing whether anyone considered it.
export interface FieldValues { valid: string; invalid?: string | null; edge?: string }

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

// ── Verb semantics ────────────────────────────────────────────────────
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
  /** Trigger condition extracted from source -- e.g. "data.category?.create" */
  trigger?: string;
  /** What the hook does -- e.g. "creates a category and assigns its id" */
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

/** A stage of fact extraction that gave up and fell back to its empty result.
 *
 *  The ts-morph stages deliberately degrade rather than fail -- a module the compiler chokes on
 *  still gets the regex-derived facts. But silence at those catch sites made "your claim is vague"
 *  and "our parser gave up" indistinguishable downstream. This records the difference as data;
 *  surfacing it in output is a later wave's job. */
export interface DegradedExtraction {
  /** Which extraction stage fell back (e.g. "functionTypeChains"). */
  stage: string;
  /** The error that made it give up, as a message. */
  reason: string;
}

/** What a default-exported `extends EventTarget` class can actually do.
 *
 *  These are capabilities, not trivia: the EventTarget family emits calls against them, and
 *  `extends EventTarget` implies none of them. Deriving `subscribe({ key, callback })` against a
 *  module that has the base class but no `subscribe` reports the claim as *failing*: the author
 *  reading red for a premise they never wrote. `deriveEventTargetInline` checks the emitted code
 *  against these before returning. */
export interface EventTargetClassInfo {
  /** Class name as exported (e.g. "Context"). */
  name: string;
  hasSubscribe: boolean;
  hasDestroy: boolean;
  hasIsDestroyed: boolean;
  hasBatch: boolean;
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
  /** The module's "perform" function -- the one that does the primary action (e.g. searchProvider). */
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
  /** Vocabulary derived purely from AstFacts -- no production-code annotation required.
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
  /** True when the module reads process.argv -- tests must set process.argv before constructing. */
  usesProcessArgv?: boolean;
  /** True when the module may call process.exit -- tests may need to intercept it. */
  mayCallProcessExit?: boolean;
  /** Text transformer functions: exported `(string, ...) → T` where T is a structured object.
   * Detected from: source contains format-token patterns (`startsWith("# ")` etc.) and the function
   * signature matches. Value contains a synthetic valid input string and secondary arg literals.
   */
  textTransformerFunctions: Record<string, TextTransformerFn>;
  /** Function type chains: fnName → { chain, rootTextTransformer }.
   * Detected when `fn2(T)` can be set up with `fn1(...) → T` (matching TypeScript type names).
   * e.g., `translate: { chain: ["parse"], rootTextTransformer: { syntheticInput, secondaryArgs } }`.
   * Used to generate multi-step pipeline tests without helper wrappers.
   */
  functionTypeChains: Record<string, { chain: string[]; rootTextTransformer?: { syntheticInput: string; secondaryArgs: string[] } }>;
  /** Structural comparator functions: exported `(T, T) → U[]` where both params have the same type.
   * Detected from TypeScript interface inspection. One entry per scenario variant -- multiple virtual
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
  /** Extraction stages that gave up on this module and fell back to empty results.
   *  Empty when every stage ran clean. See DegradedExtraction.
   */
  degraded: DegradedExtraction[];
}

// ── Lifecycle inference result ──────────────────────────────────────

export interface LifecycleHints {
  beforeAll?: string;
  beforeEach?: string;
}

/** A `(string, ...) → T` exported function the engine can drive with synthetic input. Named
 *  rather than inlined because core.ts builds these and AstFacts stores them -- two structural
 *  literals that had already drifted apart on `returnsArray` before anything typechecked. */
export interface TextTransformerFn {
  syntheticInput: string;
  secondaryArgs: string[];
  returnsArray: boolean;
}

// ── Inline test case derivation ───────────────────────────────────────

export interface InlineDerived {
  /** Arguments to pass to the CRUD create/update function directly */
  callArgs: unknown[];
  /** Which function to call (e.g. "create", "update"). Undefined when `inspectCode` is fully
   *  self-contained -- it constructs its own subject and needs no framework-generated call.
   *  Consumers already branch on this (see translator/index.ts's `resolved.method !== undefined`
   *  specificity check); the field was declared required only because nothing typechecked. */
  method?: string;
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

// ── Vocabulary-pattern catalog entry shape ────────────────────────────

export interface ComponentPattern {
  test: RegExp;
  /** Builds the test body. `source` is the module under test, for patterns whose probe values
   *  must come from the module's own declarations rather than from a literal in the pattern.
   *
   *  `parentClaim` is the claim a perspective hangs under, and is absent when the claim being derived
   *  *is* the parent. A perspective inherits vocabulary from the claim above it -- "does an Icon
   *  constructed without text receive the icon-only class?" names no class because the claim above
   *  already said the element receives the `icon` class -- so a pattern that needs an identifier the
   *  perspective refers to but does not repeat can find it there. It is context, not a second claim:
   *  what is asserted still comes from the perspective. */
  build: (m: RegExpMatchArray, source?: string, parentClaim?: string) => string[];
  /** Higher wins when more than one pattern matches the same claim (default 0, ties broken by
   *  array order). Give a pattern an explicit priority when it's deliberately more specific than
   *  a looser pattern elsewhere in the catalog -- this makes the win durable if the catalog is
   *  ever reordered, instead of depending on staying physically earlier in the array. */
  priority?: number;
}

// ── Synthetic value generation ────────────────────────────────────────
// Pure and dependency-free (only needs FIELD_VALUES above), so it lives here rather than in
// core.ts -- both core.ts and the mock-shape helpers need it, and core.ts already imports
// from mockShapes.ts, so putting it in core.ts would create a cycle.

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
