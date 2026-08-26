import type { RawAssertion, TestCase, ActionStep, AssertionStep } from "../types.ts";

// ── Value patterns ────────────────────────────────────────────────────

// Prefix is optional so the bare builtins match, not just prefixed forms: `-> `Error`` must
// resolve the same as `-> `AuthError``.
const THROWS = /^(?:throws?\s+)?`((?:[A-Z]\w*)?(?:Error|Exception|Fault))(?:\(["']([^"']*)["']\))?`/;
const ZERO    = /(?:^|is\s+)(?:zero|0)$/i;
const BOOL    = /^(?:is\s+)?(true|false)$/i;
const NULL_V  = /^(?:is\s+)?null$/i;
const UNDEF_V = /^(?:is\s+)?undefined$/i;
const SHAPE   = /^`(\{[^`]+\})`/;
const RESOLVES = /^(?:resolves?|returns?)(?:\s+`(\{[^`]+\})`)?/i;
const NO_ERROR = /^no\s+error$/i;

// ── Side-effect / spy patterns ────────────────────────────────────────

const CALLED      = /^(?:(\w+)\s+)?called(?:\s+(once|twice|\d+\s+times?))?$/i;
const CALLED_WITH = /^(?:(\w+)\s+)?called\s+with\s+(.+)$/i;
const NOT_CALLED  = /^(?:(\w+)\s+)?not\s+called$/i;
const ALL_CALLED  = /^all\s+(?:\w+\s+)?called$/i;

// ── Binding `Subject` in scenario code ────────────────────────────────

/**
 * Points bare `Subject` at the module's default export.
 *
 * A generated suite imports the module twice: `Subject` as the namespace (so a claim can reach a
 * named export as `Subject.parse(...)`) and `_SubjectCtor` as the default. Scenario steps are
 * emitted verbatim, so whichever name they use is the one they get -- and a namespace object is not
 * a constructor. Rewriting only `new Subject` left every other position wrong: `class extends
 * Subject` produced a suite where the class definition itself threw, which surfaced as an ordinary
 * failing claim rather than as the setup error it was.
 *
 * The rule is positional: `Subject` followed by `.` is namespace access and stays; anywhere else it
 * is the thing under test and becomes the default export. Quoted spans are skipped, because a claim
 * comparing against the literal string `"Subject"` would otherwise be rewritten into comparing
 * against `"_SubjectCtor"` -- a false failure, and the kind that reads as a real one.
 */
function bindSubject(code: string): string {
  let out = "", quote: string | null = null;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      out += c;
      if (c === quote && code[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "S" && /^Subject\b/.test(code.slice(i))) {
      const before = code[i - 1] ?? "";
      const after = code.slice(i + "Subject".length);
      if (!/[.\w$]/.test(before) && !/^\s*\./.test(after)) {
        out += "_SubjectCtor";
        i += "Subject".length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

// ── Return type patterns ──────────────────────────────────────────────

// "returns a function" / "returns an unsubscribe function"
const RETURNS_FN  = /^(?:returns?\s+a(?:n?\s+)?(?:\w+\s+)?)?function$/i;
const RETURNS_OBJ = /^returns?\s+an?\s+object(?:\s+with\s+(\w+))?$/i;

// ── Full-text patterns (no arrow) ─────────────────────────────────────

// Safety invariants: "X is safe", "X does nothing", "no error ...", "does not throw"
// Also: "X is a valid state" -- asserting that a particular state is permitted (not an error)
const FULL_SAFETY = /\b(?:is\s+safe|does\s+nothing|does\s+not\s+throw|never\s+throws?|no\s+error|does\s+not\s+raise|does\s+not\s+propagate|never\s+propagates?|is\s+a\s+valid\s+state|not\s+an\s+error\s+condition)\b/i;

// Negation invariants: "X does not Y" / "X never Y"
const FULL_DOES_NOT = /\b(?:does\s+not|never)\s+(?:affect|fire|receive|create|store|appear|expose|show|run|execute|consume|increment|trigger|validate|check|verify|stall|block|halt|prevent|interrupt|break)/i;

// Capability claims: "X can create/add/update/..." -- asserts a SOFTWARE OPERATION is permitted
// Restricted to action verbs (including past-tense forms) to avoid matching portability claims
// ("can be committed to version control") or risk warnings ("can produce a dangerous protocol")
const FULL_CAN = /\bcan\s+(?:be\s+)?(?:creat(?:e|ed)?|add(?:ed)?|updat(?:e|ed)?|modif(?:y|ied)|delet(?:e|ed)?|remov(?:e|ed)?|read|write|written|import(?:ed)?|export(?:ed)?|chang(?:e|ed)?|set|get|use[sd]?|call(?:ed)?|subscri(?:be|bed)|connect(?:ed)?|register(?:ed)?|send|receiv(?:e|ed)?|configur(?:e|ed)?|access(?:ed)?|build|run|execut(?:e|ed)?|trigger(?:ed)?|emit(?:ted)?|fire[sd]?|stor(?:e|ed)?|load(?:ed)?|generat(?:e|ed)?|extend(?:ed)?|overrid(?:e|den)?|replac(?:e|ed)?|reset|clear(?:ed)?|clos(?:e|ed)|open(?:ed)?|enabl(?:e|ed)?|disabl(?:e|ed)?|toggl(?:e|ed)?|push(?:ed)?|pop(?:ped)?|queu(?:e|ed)?|dequeu(?:e|ed)?)\b/i;

// Independence claims: "requires no X", "there is no X required", "do not require X"
const FULL_REQUIRES_NO = /\b(?:requires?\s+no\b|there\s+is\s+no\b.*\brequired|do\s+not\s+require\b)\b/i;

// Architectural invariants: "X is structural" / "structurally impossible" / "affects only that X"
// "affects only that" and "only that X" are isolation invariants -- proven by single-key mutation in AST
const FULL_STRUCTURAL = /\b(?:is\s+structural|structurally\s+(?:impossible|enforced|guaranteed|prevented|sound|correct)|affects\s+only\s+that\b|does\s+not\s+ripple)\b/i;

// Caller independence: "need not know/check/validate/..."
const FULL_NEED_NOT = /\bneed\s+not\b/i;

// Throws assertion: "throws an error", "raises an exception", "fails with an error"
// Placed after FULL_SAFETY so "does not throw" → resolves takes precedence
const FULL_THROWS_ERROR = /\b(?:throws?|raises?)\s+(?:an?\s+)?(?:error|exception|Error)\b/i;

// Fault resilience: "a failed X does not stall/block/crash/..."
// Subject encodes the fault; predicate verifies the system recovered.
// Derives a withFaultInjection test from the claim vocabulary.
const FAULT_RESILIENCE = /\ba\s+failed\s+\w+(?:\s+\w+)?\s+does\s+not\s+(?:stall|block|crash|halt|corrupt|break|prevent|interrupt|stop)/i;

// Schema enforcement: "only declared fields survive", "undeclared fields are dropped", "unknown fields stripped/ignored"
const FULL_SCHEMA_DROP = /\b(?:only\s+declared\s+fields?\s+(?:survive|are\s+kept|are\s+preserved)|undeclared\s+fields?\s+(?:are\s+)?(?:dropped|removed|stripped|ignored)|unknown\s+fields?\s+(?:are\s+)?(?:dropped|removed|stripped|ignored|not\s+stored|silently\s+dropped))\b/i;

// Contains / substring: output contains a sentinel, marker, or substring
// "output contains", "stderr includes", "result contains a marker", "appended to stderr"
const FULL_CONTAINS = /\b(?:contains?|includes?|appended?\s+to)\s+(?:a\s+)?(?:marker|sentinel|string|substring|message|indicator|tag|prefix|suffix)\b/i;

// Absent / conditional field: field is not present, not populated, absent, not set
// "is absent", "is not present", "is not populated", "is not included", "is not set"
const FULL_ABSENT = /\b(?:is\s+(?:not\s+(?:present|populated|included|set|defined|part\s+of)|absent|omitted|excluded|undefined|null)|field\s+is\s+(?:absent|missing|not\s+present)|not\s+included\s+in\s+the\s+(?:response|result|output))\b/i;

// Return type from full text: "subscribe returns a function"
const FULL_RETURNS_FN = /\breturns?\s+a(?:n?\s+)?(?:\w+\s+)?function\b/i;
const FULL_RETURNS_OBJ = /\breturns?\s+an?\s+object\b/i;
// "returns a list of links" / "returns an array" -- collection return type
const FULL_RETURNS_LIST = /\breturns?\s+a\s+(?:list|array)\b/i;

// Numeric return / fire count: "returns 1", "fires once", "fires zero times", "returns 0"
const FULL_RETURNS_N = /\b(?:returns?|fires?|calls?)\s+(?:exactly\s+)?(\d+|once|twice|zero(?:\s+times?)?)\b/i;


export function tryDeterministic(
  assertion: RawAssertion,
  ctx?: { browser?: boolean; modulePath?: string }
): TestCase | null {
  const outcome = assertion.outcome?.trim();

  // ── Scenario: build it, act on it, then assert ─────────────────────
  //
  // The author's own steps, emitted in the order written. Nothing here is derived, and that is the
  // point: what these claims describe -- a priority option applying before another, a cleanup
  // replacing rather than accumulating -- is intent, and intent is not in the source. Derivation
  // reads code faithfully, so it would sooner reproduce a bug than notice one.
  //
  // `Subject` is how the document names the module's default export; it becomes the constructor the
  // generated file already binds.
  if (assertion.scenario && outcome) {
    // A group marked `**browser:** true` sends its steps *into* a real page. The claims that need it
    // are about layout, which happy-dom does not compute -- it reports 0 for every measurement, so
    // running them here would answer the question with a number that means "nobody laid this out".
    //
    // `ctx.browser` is only true when a browser was actually found. On a machine without one the
    // scenario is declined and stays pending.
    if (ctx?.browser && ctx.modulePath) {
      const body = assertion.scenario
        .map(step => (step.captures ? `const ${step.captures} = ${step.expression};` : `${step.expression};`))
        .concat(`return Boolean(${outcome});`)
        .join("\n");
      return {
        description: assertion.raw,
        setup: [],
        action: { args: [], fromClaim: true },
        assertion: {
          type: "inspect",
          code: [
            `const _page = await inBrowser(${JSON.stringify(ctx.modulePath)}, ${JSON.stringify(body)});`,
            `expect(_page).toBe(true);`,
          ].join("\n"),
        },
        source: "deterministic",
      };
    }

    const lines = assertion.scenario.map(step => {
      const expr = bindSubject(step.expression);
      return step.captures ? `const ${step.captures} = ${expr};` : `${expr};`;
    });
    // The outcome is a boolean expression over the captures, so it is asserted as written rather
    // than pattern-matched -- an author who has gone to the trouble of spelling out a sequence has
    // also said exactly what they expect at the end of it.
    lines.push(`expect(${bindSubject(outcome)}).toBe(true);`);
    return {
      description: assertion.raw,
      setup: [],
      action: { args: [], fromClaim: true },
      assertion: { type: "inspect", code: lines.join("\n") },
      source: "deterministic",
    };
  }

  // ── Full-text patterns (no arrow) ──────────────────────────────────
  if (!outcome) {
    const step = matchFullText(assertion.raw);
    if (!step) return null;

    // NO FALSE PASS (see src/ast/index.ts) -- a bare prose claim that only yields `resolves`
    // has not been derived from, it has been substituted for. Two things are missing and both
    // matter: the *predicate* is behavioral ("does not affect the source balance") while
    // no-throw is a stand-in for it, and the *condition* the claim names ("a throwing handler
    // is subscribed") is never established, so even a claim whose predicate genuinely is
    // no-throw gets checked against a call that trivially could not have thrown.
    //
    // Without this gate, gutting `publish()` to an empty body leaves every such claim in
    // examples/eventBus.lld.md green: the exact failure mode this pipeline rejected the
    // model-backed translator for (see the comment at the bottom of translator/index.ts).
    //
    // Two escapes stay open, because in both the author has said something concrete:
    //   - an explicit `-> resolves` / `-> no error` outcome (handled below, not here) -- the
    //     author chose no-throw as the check
    //   - an inline call -- the call establishes the condition the claim describes
    // Everything else is pending: "claim recorded, no test derivable yet". Add a perspective.
    if (step.type === "resolves" && !assertion.callMethod) return null;

    // Don't extract an implied method -- rely on group annotation or auto-inference.
    // Using the first word as a method name produces false positives (e.g. "seeding" → Subject.seeding)
    // No arrow here, so the only thing the author could have named concretely is the call. A bare
    // vocabulary match ("a failed write does not stall the queue") is left overridable on purpose:
    // a family that recognises the module's shape has a better body for it than the generic one.
    const action: ActionStep = assertion.callMethod
      ? { method: assertion.callMethod, args: assertion.callArgs, repeat: assertion.repeat, fromClaim: true }
      : { argDescription: assertion.raw, repeat: assertion.repeat };

    return { description: assertion.raw, setup: [], action, assertion: step, source: "deterministic" };
  }

  // ── Outcome-based patterns ──────────────────────────────────────────

  // Strip trailing " // prose explanation" and any (annotation) or [note] before matching
  const outcomeStripped = outcome
    .replace(/ \/\/ .+$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();

  // Strip ", not X [and not Y]" qualifier before matching primary outcome
  const { primary, negations } = splitNegations(outcomeStripped);

  const step = assertion.captures
    ? matchInspectOutcome(primary) ?? matchChainedOutcome(primary)
    : matchOutcome(primary);

  if (!step) return null;
  if (negations.length > 0) step.negations = negations;

  // Reached only for a claim carrying an outcome arrow, so the author stated what to check. That
  // holds whether or not they also named the call, which is why both branches are marked.
  const action: ActionStep = assertion.callMethod
    ? { method: assertion.callMethod, args: assertion.callArgs, repeat: assertion.repeat, fromClaim: true }
    : { argDescription: assertion.condition, repeat: assertion.repeat, fromClaim: true };

  if (assertion.captures) {
    action.captures = assertion.captures;
    // Only steps that actually parsed as a call can be emitted; a chain step whose condition
    // wasn't a call expression has no method to invoke, and inventing one would be a guess.
    const extraCalls = (assertion.extraCalls ?? [])
      .filter((s): s is typeof s & { method: string } => !!s.method)
      .map(s => ({ method: s.method, args: s.args, captures: s.captures }));
    if (extraCalls.length > 0) action.extraCalls = extraCalls;
  }

  return {
    description: assertion.raw,
    setup: [],
    action,
    assertion: step,
    source: "deterministic",
  };
}

/** Outcomes that are meaningful on a *chained* claim -- one whose condition is a sequence of
 *  calls rather than a single one, e.g.
 *
 *    publish("orders", evt) captures sent then subscribe("orders", spy) captures unsub -> spy not called
 *
 *  The chain exists to establish an ordering that *is* the claim ("subscribing after a publish
 *  receives nothing"), so what gets asserted afterwards is usually a fact about a registered
 *  handler, not about a captured return value -- which is all `matchInspectOutcome` knows how to
 *  express. Tried only after it declines, so no existing inspect claim changes meaning.
 *
 *  Deliberately narrow. `throws` is absent because a claim cannot both capture a call's result
 *  and expect that call to throw; admitting it would generate a test that fails for a reason the
 *  author never wrote. Everything unlisted stays pending. */
function matchChainedOutcome(outcome: string): AssertionStep | null {
  const spy = matchSpyOutcome(outcome);
  if (spy) return spy;

  // An explicit `-> resolves` / `-> no error` after a chain: the author chose no-throw as the
  // check, and the chain established the condition it is a check *of*. Honest on both counts --
  // unlike the bare-prose case, which has neither and stays pending.
  if (NO_ERROR.test(outcome) || RESOLVES.test(outcome)) return { type: "resolves" };

  return null;
}

// ── Negation qualifier extractor ──────────────────────────────────────

function splitNegations(outcome: string): { primary: string; negations: string[] } {
  // Match ", not X" or ", not X and not Y" at end of outcome
  const match = outcome.match(/,\s*not\s+(.+)$/i);
  if (!match) return { primary: outcome, negations: [] };

  const primary = outcome.slice(0, match.index).trim();
  const negPart = match[1];

  const negations = negPart
    .split(/\s+and\s+(?:not\s+)?/i)
    .map(s => s.replace(/^not\s+/i, "").trim())
    .filter(Boolean);

  return { primary, negations };
}

// ── Outcome pattern matching ──────────────────────────────────────────

function matchOutcome(outcome: string): AssertionStep | null {
  // Plain "throws" / "throw" without a class -- most common form in LLD assertions
  if (/^throws?$/i.test(outcome)) return { type: "throws" };

  const throwsMatch = outcome.match(THROWS);
  if (throwsMatch) return { type: "throws", errorClass: throwsMatch[1], errorMessage: throwsMatch[2] };

  if (NO_ERROR.test(outcome))  return { type: "resolves" };
  if (RESOLVES.test(outcome))  { const m = outcome.match(RESOLVES); return { type: "resolves", description: m?.[1] }; }

  // Pure numeric literal first -- before ZERO, to avoid "200" matching ZERO (ends in "0")
  if (/^-?\d+(\.\d+)?$/.test(outcome)) {
    return { type: "equals", expected: Number(outcome) };
  }

  // ZERO matches "zero", "is zero", "total is zero" -- but NOT pure numbers (handled above)
  if (ZERO.test(outcome))  return { type: "equals", expected: 0 };
  if (NULL_V.test(outcome)) return { type: "equals", expected: null };
  if (UNDEF_V.test(outcome)) return { type: "equals", expected: undefined };
  const boolMatch = outcome.match(BOOL);
  if (boolMatch) return { type: "equals", expected: boolMatch[1] === "true" };

  // Quoted string literal: -> "value" or -> 'value'
  // But first check for contains/absent prefix before treating as equality
  const containsMatch = outcome.match(/^contains?\s+(["'])(.*?)\1$/i);
  if (containsMatch) return { type: "contains", expected: containsMatch[2] };

  const notContainsMatch = outcome.match(/^(?:does\s+not\s+contain|not\s+contains?)\s+(["'])(.*?)\1$/i);
  if (notContainsMatch) return { type: "contains", expected: notContainsMatch[2], negations: ["contains"] };

  // "absent", "absent when not provided", "undefined when omitted", etc.
  if (/^(?:absent|undefined|not\s+present|not\s+defined|not\s+set|missing|null\s+or\s+undefined)(?:\s+when\b.*)?$/i.test(outcome))
    return { type: "absent" };

  const strLitMatch = outcome.match(/^(["'])(.*?)\1$/s);
  if (strLitMatch) {
    return { type: "equals", expected: strLitMatch[2] };
  }

  const shapeMatch = outcome.match(SHAPE);
  if (shapeMatch) return { type: "shape", description: shapeMatch[1] };

  // Return type assertions
  if (RETURNS_FN.test(outcome))  return { type: "property", description: "typeof-function" };
  if (RETURNS_OBJ.test(outcome)) return { type: "property", description: "typeof-object" };

  const spy = matchSpyOutcome(outcome);
  if (spy) return spy;

  return null;
}

/** `handler called` / `called once` / `called with X` / `not called` / `all called`.
 *
 *  One definition, used by both the plain and the chained outcome matchers. It was two, written
 *  a few hours apart, and they had already drifted: the orderings differed and one omitted
 *  `callCount`. Nothing failed yet -- the regexes happen not to overlap -- which is the whole
 *  problem with keeping two copies of a decision. */
function matchSpyOutcome(outcome: string): AssertionStep | null {
  const calledWithMatch = outcome.match(CALLED_WITH);
  if (calledWithMatch) return { type: "calledWith", description: calledWithMatch[2]?.trim() };

  if (NOT_CALLED.test(outcome)) return { type: "notCalled" };
  if (ALL_CALLED.test(outcome)) return { type: "called", callCount: undefined, description: "all" };

  const calledMatch = outcome.match(CALLED);
  if (calledMatch) {
    const countStr = calledMatch[2]?.toLowerCase();
    const callCount = countStr === "once" ? 1 : countStr === "twice" ? 2
      : countStr ? parseInt(countStr) || undefined : undefined;
    return { type: "called", callCount };
  }

  return null;
}

// ── Full-text pattern matching (no arrow) ─────────────────────────────

/** Whether the match at `index` sits wholly inside a double-quoted span.
 *
 *  A claim that puts a pattern in quotation marks is naming it, not asserting it. Documentation about
 *  a format does this constantly -- and lldtdd's own document describing the fault-resilience phrasing
 *  quoted it, which was enough for the rule below to match the *description* and derive a
 *  fault-injection test for the parser. The claim then failed for a reason its author never wrote.
 *
 *  Counting quote characters before the match is enough: an odd count means the match opened inside
 *  a quoted span. A claim whose own subject is quoted (`a failed "write" does not stall the queue`)
 *  starts outside one, so it still matches. */
function isInsideQuotes(text: string, index: number): boolean {
  let count = 0;
  for (let i = 0; i < index; i++) if (text[i] === '"') count++;
  return count % 2 === 1;
}

function matchFullText(text: string): AssertionStep | null {
  // Fault resilience: "a failed write does not stall the queue" -- check BEFORE FULL_DOES_NOT
  // More specific (requires "a failed X" subject), so takes priority over the general "does not" pattern
  const fault = text.match(FAULT_RESILIENCE);
  if (fault && fault.index !== undefined && !isInsideQuotes(text, fault.index)) {
    return { type: "fault-resilience" };
  }

  // Absent field: "field is absent", "is not present in the response", "is not populated"
  // Check before FULL_DOES_NOT / FULL_SAFETY to avoid "not included" → resolves
  if (FULL_ABSENT.test(text)) return { type: "absent" };

  // Contains assertion: "output contains a marker", "stderr includes a sentinel"
  if (FULL_CONTAINS.test(text)) return { type: "contains" };

  // Safety / no-error invariants
  if (FULL_SAFETY.test(text)) return { type: "resolves" };

  // "X does not affect/fire/..." -- negative invariant → resolves (asserts no side effect)
  if (FULL_DOES_NOT.test(text)) return { type: "resolves" };

  // Capability claims: "X can create/update/..." -- asserts the operation is permitted
  if (FULL_CAN.test(text)) return { type: "resolves" };

  // Independence claims: "requires no network", "there is no process required", "do not require migration"
  if (FULL_REQUIRES_NO.test(text)) return { type: "resolves" };

  // Architectural invariants: "write ordering is structural, not a mutex"
  if (FULL_STRUCTURAL.test(text)) return { type: "resolves" };

  // Caller independence: "the caller need not know which engine was used"
  if (FULL_NEED_NOT.test(text)) return { type: "resolves" };

  // Throws: "throws an error", "raises an exception"
  if (FULL_THROWS_ERROR.test(text)) return { type: "throws" };

  // Schema enforcement: "only declared fields survive", "undeclared fields dropped"
  if (FULL_SCHEMA_DROP.test(text)) return { type: "schema-drop" };

  // Return type
  if (FULL_RETURNS_FN.test(text))   return { type: "property", description: "typeof-function" };
  if (FULL_RETURNS_OBJ.test(text))  return { type: "property", description: "typeof-object" };
  // "returns a list" -- resolves without crashing; the Array check requires a captures pattern with a method
  if (FULL_RETURNS_LIST.test(text)) return { type: "resolves" };

  // Numeric return count: "fires once", "returns 0", "fires zero times"
  const returnsN = text.match(FULL_RETURNS_N);
  if (returnsN) {
    const word = returnsN[1].toLowerCase();
    const n = word === "once" ? 1 : word === "twice" ? 2 : word.startsWith("zero") ? 0 : parseInt(word);
    if (!isNaN(n)) return { type: "equals", expected: n };
  }

  // Question form: strip leading question word and trailing "?", then re-match
  // "does X succeed?" → "X succeeds" → resolves
  // "does X throw?" → throws
  if (text.endsWith("?")) {
    return matchQuestion(text);
  }

  return null;
}

// ── Question grammar ──────────────────────────────────────────────────
// Called when full-text assertion ends with "?". Strips question framing
// and maps question-ending keywords to assertion types.

const Q_PREFIX  = /^(?:does|do|is|are|can|will|should|would)\s+/i;
const Q_RESOLVES = /\b(?:succeed|work|pass|resolve|complete|valid|accepted|allowed|permitted|remain|persist|continue|function|operate|store|save|create|add|unchanged|unaffected|without\s+(?:error|failing|failure))\s*\??$/i;
const Q_THROWS   = /\b(?:throw|fail|reject|raise|error|thrown|failed|rejected|blocked|refused|denied)\s*\??$/i;
const Q_TRUE     = /\breturn\s+true\s*\??$/i;

function matchQuestion(text: string): AssertionStep | null {
  const body = text.replace(Q_PREFIX, "").replace(/\?$/, "").trim();

  if (Q_TRUE.test(body))     return { type: "equals", expected: true };
  if (Q_THROWS.test(body))   return { type: "throws" };
  if (Q_RESOLVES.test(body)) return { type: "resolves" };

  // Try existing full-text patterns on the stripped question body
  // (e.g. "do all declared fields appear?" → body has "only declared fields" → schema-drop)
  if (FULL_SCHEMA_DROP.test(body))    return { type: "schema-drop" };
  if (FULL_SAFETY.test(body))         return { type: "resolves" };
  if (FULL_CAN.test(body))            return { type: "resolves" };
  if (FULL_REQUIRES_NO.test(body))    return { type: "resolves" };
  if (FULL_STRUCTURAL.test(body))     return { type: "resolves" };
  if (FULL_THROWS_ERROR.test(body))   return { type: "throws" };

  return null;
}

// ── Inspect patterns (when assertion.captures is set) ─────────────────

// Property path: result, result.foo, result[0], result.foo[1].bar
const PATH = /\w+(?:\[\d+\]|\.\w+)*/;
const INSPECT_NOT_CONTAINS = new RegExp(`^(${PATH.source})\\s+does\\s+not\\s+contain\\s+["']([^"']*)["']$`, "i");
const INSPECT_WITHIN_HOURS = new RegExp(`^(${PATH.source})\\s+is\\s+within\\s+(\\d+)\\s+hours?(?:\\s+(?:from|of)\\s+now)?$`, "i");
const INSPECT_WITHIN_MS    = new RegExp(`^(${PATH.source})\\s+is\\s+within\\s+(\\d+)\\s+(?:ms|milliseconds?)(?:\\s+(?:from|of)\\s+now)?$`, "i");
const INSPECT_NOT_EQUAL    = new RegExp(`^(${PATH.source})\\s+!==?\\s+(${PATH.source})$`, "i");
const INSPECT_EQUALS_VAR   = new RegExp(`^(${PATH.source})\\s+===?\\s+(${PATH.source})$`);
const INSPECT_EQUALS_LIT   = new RegExp(`^(${PATH.source})\\s+===?\\s+(.+)$`);
const INSPECT_IS_DEFINED     = new RegExp(`^(${PATH.source})\\s+is\\s+defined$`, "i");
const INSPECT_IS_NOT_DEFINED = new RegExp(`^(${PATH.source})\\s+is\\s+not\\s+defined$`, "i");
const INSPECT_IS_TYPE        = new RegExp(`^(${PATH.source})\\s+is\\s+(?:a\\s+|an\\s+)?(string|number|boolean|function|Date|object)$`, "i");

function matchInspectOutcome(outcome: string): AssertionStep | null {
  // A compound boolean expression -- parts joined by `&&` or `||` -- is asserted exactly as written.
  // The single-comparison patterns below match greedily: `INSPECT_EQUALS_LIT` on
  // `r.status === "error" && r.body.message === "boom"` splits at the first `===` and emits
  // `expect(r.status).toBe("error" && r.body.message === "boom")` -- the `&&` lands *inside* toBe,
  // so the test silently asserts something the author never wrote (a green that checks the wrong
  // thing). Whole-expression assertion is what the author meant, the same as a scenario's outcome.
  if (/\s(?:&&|\|\|)\s/.test(outcome)) {
    return { type: "inspect", code: `expect(${outcome}).toBe(true);` };
  }

  const notContains = outcome.match(INSPECT_NOT_CONTAINS);
  if (notContains) return { type: "inspect", code: `expect(${notContains[1]}).not.toContain(${JSON.stringify(notContains[2])});` };

  const withinHours = outcome.match(INSPECT_WITHIN_HOURS);
  if (withinHours) {
    const ms = parseInt(withinHours[2]) * 3_600_000;
    return { type: "inspect", code: `expect(${withinHours[1]}.getTime() - Date.now()).toBeLessThanOrEqual(${ms});` };
  }

  const withinMs = outcome.match(INSPECT_WITHIN_MS);
  if (withinMs) return { type: "inspect", code: `expect(${withinMs[1]}.getTime() - Date.now()).toBeLessThanOrEqual(${withinMs[2]});` };

  const notEqual = outcome.match(INSPECT_NOT_EQUAL);
  if (notEqual) return { type: "inspect", code: `expect(${notEqual[1]}).not.toBe(${notEqual[2]});` };

  const equalsVar = outcome.match(INSPECT_EQUALS_VAR);
  if (equalsVar) return { type: "inspect", code: `expect(${equalsVar[1]}).toBe(${equalsVar[2]});` };

  const equalsLit = outcome.match(INSPECT_EQUALS_LIT);
  if (equalsLit) {
    const val = equalsLit[2].trim();
    const isNumLiteral = /^-?\d+(\.\d+)?$/.test(val);
    const safe = /^["'\d]/.test(val) || val === "null" || val === "true" || val === "false" || val === "undefined" || isNumLiteral;
    const emitted = safe ? val : JSON.stringify(val);
    return { type: "inspect", code: `expect(${equalsLit[1]}).toBe(${emitted});` };
  }

  const isDefined = outcome.match(INSPECT_IS_DEFINED);
  if (isDefined) return { type: "inspect", code: `expect(${isDefined[1]}).toBeDefined();` };

  const isNotDefined = outcome.match(INSPECT_IS_NOT_DEFINED);
  if (isNotDefined) return { type: "inspect", code: `expect(${isNotDefined[1]}).toBeUndefined();` };

  // "result is not a Type" -- instance check: not an instance of the named constructor
  const NOT_INSTANCE = new RegExp(`^(${PATH.source})\\s+is\\s+not\\s+a(?:n)?\\s+(\\w+)$`, "i");
  const notInst = outcome.match(NOT_INSTANCE);
  if (notInst) {
    return { type: "inspect", code: `expect(${notInst[1]} instanceof ${notInst[2]}).toBe(false);` };
  }

  // "result is an Array" -- Array.isArray check
  const IS_ARRAY = new RegExp(`^(${PATH.source})\\s+is\\s+an?\\s+Array$`, "i");
  const isArr = outcome.match(IS_ARRAY);
  if (isArr) {
    return { type: "inspect", code: `expect(Array.isArray(${isArr[1]})).toBe(true);` };
  }

  // "result starts with 'prefix'" -- string prefix check
  const STARTS_WITH = new RegExp(`^(${PATH.source})\\s+starts?\\s+with\\s+["']([^"']*)["']$`, "i");
  const startsWith = outcome.match(STARTS_WITH);
  if (startsWith) {
    return { type: "inspect", code: `expect(${startsWith[1]}.startsWith(${JSON.stringify(startsWith[2])})).toBe(true);` };
  }

  // Numeric comparisons: result > N, result >= N, result < N, result <= N
  const COMPARE = new RegExp(`^(${PATH.source})\\s*(>|>=|<|<=)\\s*(-?\\d+(?:\\.\\d+)?)$`);
  const cmpMatch = outcome.match(COMPARE);
  if (cmpMatch) {
    const [, prop, op, n] = cmpMatch;
    const matcher = op === ">"  ? `toBeGreaterThan(${n})`
                  : op === ">=" ? `toBeGreaterThanOrEqual(${n})`
                  : op === "<"  ? `toBeLessThan(${n})`
                  :               `toBeLessThanOrEqual(${n})`;
    return { type: "inspect", code: `expect(${prop}).${matcher};` };
  }

  const isType = outcome.match(INSPECT_IS_TYPE);
  if (isType) {
    const [, prop, typeName] = isType;
    const code = typeName === "Date"
      ? `expect(${prop}).toBeInstanceOf(Date);`
      : `expect(typeof ${prop}).toBe(${JSON.stringify(typeName.toLowerCase())});`;
    return { type: "inspect", code };
  }

  return null;
}
