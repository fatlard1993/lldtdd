// ── Parsed from markdown ──────────────────────────────────────────────

export interface LLDDocument {
  title: string;
  module: string;
  description?: string;
  /** Document-level lifecycle defaults — applied to all groups that don't override them. */
  defaultBeforeAll?: string;
  defaultBeforeEach?: string;
  groups: LLDGroup[];
  sourcePath: string;
}

export interface LLDGroup {
  name: string;
  context?: string;
  setup?: string;          // runs in beforeEach, binds result as _subject
  beforeEach?: string;     // runs in beforeEach without binding (void call)
  beforeAll?: string;      // runs once before the group (expensive setup, e.g. db init)
  method?: string;
  moduleOverride?: string; // resolved absolute path; overrides doc-level module for this group
  mockHttp?: unknown;      // HTTP mock response body — wraps test calls in withMockFetch
  assertions: RawAssertion[];
}

export interface RawAssertion {
  raw: string;
  condition?: string;
  outcome?: string;
  repeat?: number;       // from "N × condition → outcome" syntax
  callMethod?: string;   // extracted when condition is "method(args)" syntax
  callArgs?: unknown[];
  captures?: string;     // bind result to this name: "call(...) captures result"
  callMethod2?: string;  // second call: "call1(...) captures a and call2(...) captures b"
  callArgs2?: unknown[];
  captures2?: string;
  perspectives?: RawAssertion[];  // indented sub-questions that verify this assertion
}

// ── Translated to executable ──────────────────────────────────────────

export interface TestSuite {
  title: string;
  modulePath: string;
  sourcePath: string;
  groups: TestGroup[];
  /** AstFacts for the primary module — drives inline lifecycle + registry generation */
  moduleAstFacts?: import("./ast.ts").AstFacts;
}

export interface TestGroup {
  name: string;
  setup?: string;
  beforeEach?: string;
  beforeAll?: string;
  method?: string;
  modulePath?: string;        // resolved absolute path; overrides suite.modulePath for this group
  moduleIsDefaultCrud?: boolean; // when true, use default import for modulePath
  mockHttp?: unknown;         // HTTP mock response — wraps group tests in withMockFetch
  cases: TestCase[];
}

export type TranslationSource = "deterministic" | "ast-derived" | "ai" | "needs-fixture";

export interface TestCase {
  description: string;
  setup: SetupStep[];
  action: ActionStep;
  assertion: AssertionStep;
  source: TranslationSource;
  perspectives?: TestCase[];  // sub-tests derived from perspective questions
}

export interface SetupStep {
  type: "seed" | "mock" | "state";
  description: string;
}

export interface ActionStep {
  method?: string;
  argDescription?: string;
  args?: unknown[];
  repeat?: number;
  captures?: string;    // bind result to this variable
  extraCall?: {         // second call for double-capture assertions
    method: string;
    args?: unknown[];
    captures: string;
  };
}

export type AssertionType =
  | "throws"
  | "resolves"
  | "equals"
  | "shape"
  | "property"
  | "called"             // spy was invoked
  | "calledWith"         // spy was invoked with matching args
  | "notCalled"          // spy was NOT invoked
  | "inspect"            // captures + property assertion with generated code
  | "schema-drop"        // calls method with sentinel unknown field, asserts field absent from result
  | "fault-resilience"   // injects fault into target, verifies system recovers (→ true)
  | "contains"           // result or result.field includes a substring (sentinel/marker patterns)
  | "absent";            // result.field is undefined/null (conditional field presence)

export interface AssertionStep {
  type: AssertionType;
  errorClass?: string;
  errorMessage?: string;
  expected?: unknown;
  description?: string;
  callCount?: number;
  code?: string;           // for "inspect": bun:test assertion expression
  negations?: string[];    // secondary .not.toBe() assertions derived from ", not X" qualifiers
  knownFields?: string[];  // for "schema-drop": declared field names from AST, strengthens the test
  /** For "fault-resilience": the target.method path to patch (e.g. "database.db.write") */
  faultTarget?: string;
}

// ── Adapter results ───────────────────────────────────────────────────

export interface CaseResult {
  description: string;
  status: "pass" | "fail" | "skip" | "error";
  error?: string;
  duration?: number;
  perspectives?: CaseResult[];  // sub-results for perspective questions
}

export interface RunResult {
  suiteName: string;
  modulePath: string;
  passed: number;
  failed: number;
  skipped: number;
  cases: CaseResult[];
  duration: number;
  /** Translated test groups — populated when verbose output is needed. */
  groups?: import("./types.ts").TestGroup[];
  /** Absolute path to the source .lld.md file. */
  lldFile?: string;
}
