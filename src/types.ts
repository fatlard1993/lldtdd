// ── Parsed from markdown ──────────────────────────────────────────────

export interface LLDDocument {
  title: string;
  module: string;
  description?: string;
  /** Document-level lifecycle defaults -- applied to all groups that don't override them. */
  defaultBeforeAll?: string;
  defaultBeforeEach?: string;
  /** Resolved absolute path to an auxiliary module (e.g. a base class) generated inline code
   *  can reference as `_Companion` -- for modules under test that are generic over another
   *  module rather than being directly constructible themselves (e.g. a higher-order function
   *  like `styled(BaseComponent, ...)` that needs a real BaseComponent to test against). */
  companionModule?: string;
  /** `**mutate:** false` opts this document out of the mutation pass.
   *
   *  For when the probe costs more than it tells you. The clearest case is a document describing
   *  orchestration code, where each claim already drives a whole pipeline -- mutating that module
   *  re-runs every claim per mutant, and the claims are about wiring rather than about the branch
   *  a mutation would flip. This is the author's judgment to make, in the same way that leaving a
   *  behavior undescribed is; the tool should not spend minutes proving a point nobody asked for.
   *
   *  Undefined means the default (mutation on). `--no-mutate` still overrides everything. */
  mutate?: boolean;
  groups: LLDGroup[];
  sourcePath: string;
  /** The project root this document's module pointers were resolved and contained against. Carried
   *  on the document so downstream fact extraction enforces the same boundary on transitively-read
   *  imports that the parser enforced on the module pointer itself. */
  root: string;
}

export interface LLDGroup {
  name: string;
  setup?: string;          // runs in beforeEach, binds result as _subject
  beforeEach?: string;     // runs in beforeEach without binding (void call)
  beforeAll?: string;      // runs once before the group (expensive setup, e.g. db init)
  method?: string;
  moduleOverride?: string; // resolved absolute path; overrides doc-level module for this group
  mockHttp?: unknown;      // HTTP mock response body -- wraps test calls in withMockFetch
  /** Run this group's scenarios in a real browser rather than under happy-dom.
   *
   *  For the claims that are about *layout* -- a textarea growing to fit its content, a popover
   *  flipping at an edge, two elements sitting side by side. happy-dom computes no layout and reports
   *  0 for every measurement, so those claims cannot be answered there at any effort. Marking the
   *  group says so out loud, which is better than leaving them to read as gaps the tool merely has
   *  not got around to. Without a browser on the machine they stay pending. */
  browser?: boolean;
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
  /** Calls after the first, in written order, for a chained condition:
   *  "a(...) captures x then b(...) captures y then c(...) captures z".
   *  The first call stays in callMethod/callArgs/captures above, so every consumer that only
   *  cares about "what does this claim call" keeps reading one place. Same name as
   *  ActionStep.extraCalls below, because it is the same list one layer down. */
  extraCalls?: ChainStep[];
  /** An ordered scenario, for claims whose subject is a thing you build and then act on.
   *
   *  Some design decisions are only observable as a sequence: construct, render, assign an option,
   *  look at what changed. Those cannot be derived -- what they describe is intent, and intent is not
   *  in the source -- so the author states them, and this is where they live. A scenario is written on
   *  one line and begins with a construction, which is what distinguishes it from the call chain
   *  above and means neither form can be mistaken for the other. */
  scenario?: ScenarioStep[];
  perspectives?: RawAssertion[];  // indented sub-questions that verify this assertion
}

export interface ScenarioStep {
  /** The step as written, evaluated with `Subject` and earlier captures in scope. */
  expression: string;
  /** Name to bind the step's value to, when the step produces one worth naming. */
  captures?: string;
}

export interface ChainStep {
  method?: string;
  args?: unknown[];
  captures: string;
}

// ── Translated to executable ──────────────────────────────────────────

export interface TestSuite {
  title: string;
  modulePath: string;
  sourcePath: string;
  groups: TestGroup[];
  /** AstFacts for the primary module -- drives inline lifecycle + registry generation */
  moduleAstFacts?: import("./ast/index.ts").AstFacts;
  /** Resolved absolute path to a companion module, imported as `_Companion` by the adapter. */
  companionModulePath?: string;
  /**
   * The module path this suite was translated against, when `modulePath` has since been pointed at a
   * stand-in -- mutation testing writes a mutant copy and runs the same suite against it. Generation
   * rewrites every occurrence of this path to `modulePath`, which is what makes the swap reach the
   * imports derived from AST facts and the paths embedded in browser assertion code.
   */
  substitutedFor?: string;
}

export interface TestGroup {
  name: string;
  setup?: string;
  beforeEach?: string;
  beforeAll?: string;
  method?: string;
  modulePath?: string;        // resolved absolute path; overrides suite.modulePath for this group
  moduleIsDefaultCrud?: boolean; // when true, use default import for modulePath
  mockHttp?: unknown;         // HTTP mock response -- wraps group tests in withMockFetch
  cases: TestCase[];
}

/** How a test case was derived. Both productive sources are offline and deterministic:
 *  `deterministic` matched a documented grammar rule, `ast-derived` matched a structural pattern
 *  in the implementation's AST. `pending` is the pending state -- the claim is recorded but
 *  nothing checks it yet. There is deliberately no source that guesses. */
export type TranslationSource = "deterministic" | "ast-derived" | "pending";

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
  /** True when the claim itself named the call or the outcome, rather than inheriting a method from
   *  its group and a shape from inference.
   *
   *  This is what tells an authored claim from a filled-in one, and the two must not be treated
   *  alike. A resolved `__lld_api` call is legitimately more specific than a *vocabulary* match on
   *  bare prose -- "a failed write does not stall the queue" is better served by the self-database
   *  family's fault-injection body than by the generic fault-resilience one. It is not more specific
   *  than `parse("…") captures r -> r.title === "The Title"`, where the author already said exactly
   *  what to call and what to check. Overriding that discarded both and left the claim's own text as
   *  the test's name, reporting it verified while checking something else. */
  fromClaim?: boolean;
  /** Calls after the first, in written order. Each binds its own capture, and each is emitted
   *  after the one before it -- the ordering is frequently the claim itself ("subscribing *after*
   *  a publish receives nothing"), so it is preserved exactly as written rather than normalised. */
  extraCalls?: ExtraCall[];
}

export interface ExtraCall {
  method: string;
  args?: unknown[];
  captures: string;
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

// ── Test run results ──────────────────────────────────────────────────

/** How a claim came out.
 *
 *  `indirect` is a success state, distinct from `pass` on purpose. It means the claim itself had no
 *  test -- every check behind it belongs to one of its perspectives, and they all passed. That is a
 *  legitimate way to verify a claim: the perspectives are the author's own operationalization of
 *  it, written directly underneath it. But it is not the same evidence as a test of the claim, and
 *  collapsing the two let a suite report "0 pending, all passed" while a quarter of its claims had
 *  nothing of their own behind them. A reader deciding whether to trust a green document needs to
 *  see that difference, so the runner reports it instead of averaging it away. */
/** `shallow` is a passing state, distinct from `pass` on purpose -- the strength analog of what
 *  `indirect` is for directness. It means the claim's only assertion is no-throw (`-> resolves`):
 *  the call ran without throwing and nothing about what it returned or did was checked. That is a
 *  real green -- the code didn't crash -- but it passes for any implementation that doesn't crash,
 *  including a gutted one, so it is not the same evidence as a claim that pins a value or a thrown
 *  error. The tool already refuses to let a no-throw check wear a bare invariant's name (see
 *  GRAMMAR "Form 2"); this carries that same distinction into the *report*, so a reader deciding
 *  whether to trust a green document can see which of its greens actually bite. */
export type CaseStatus = "pass" | "shallow" | "indirect" | "fail" | "pending" | "error";

export interface CaseResult {
  description: string;
  status: CaseStatus;
  error?: string;
  duration?: number;
  perspectives?: CaseResult[];  // sub-results for perspective questions
}

export interface RunResult {
  suiteName: string;
  modulePath: string;
  passed: number;
  failed: number;
  pending: number;
  /** Claims verified only through their perspectives -- see `CaseStatus`. Counted separately from
   *  `passed` so a caller can tell direct evidence from indirect; both are successes. */
  indirect: number;
  /** Passing claims whose only assertion is no-throw (`-> resolves`) -- see `CaseStatus`. A success,
   *  counted apart from `passed` so a weak green is not tallied as a verified one. */
  shallow: number;
  cases: CaseResult[];
  duration: number;
  /** Translated test groups -- populated when verbose output is needed. */
  groups?: TestGroup[];
  /** Absolute path to the source .lld.md file. */
  lldFile?: string;
  /** True when the module never loaded -- an import that didn't resolve, a syntax error, a
   *  top-level throw -- so no test in the suite actually executed.
   *
   *  A normal run reports this as failures, which is right: the caller's code is broken and the
   *  claims are unverified either way. Mutation testing must not, and that distinction is the
   *  whole reason this flag exists. "The claims caught this mutant" and "the mutant never ran"
   *  produce the same zero passing tests, and collapsing them makes every unloadable mutant read
   *  as caught -- a false green precisely where the tool is supposed to be finding weakness. */
  crashed?: boolean;
  /** Set on a crashed suite: a short reason the module never loaded (unresolved import, syntax
   *  error, nonzero exit with no attributable failure), surfaced so the reporter can say *why*
   *  instead of showing every claim as a bare failure. */
  error?: string;
}
