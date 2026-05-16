import type { RawAssertion, TestCase, ActionStep, AssertionStep } from "../types.ts";

// ── Value patterns ────────────────────────────────────────────────────

const THROWS = /^(?:throws?\s+)?`([A-Z]\w*(?:Error|Exception|Fault))(?:\(["']([^"']*)["']\))?`/;
const ZERO    = /(?:^|is\s+)(?:zero|0)$/i;
const BOOL    = /^(?:is\s+)?(true|false)$/i;
const NULL_V  = /^(?:is\s+)?null$/i;
const UNDEF_V = /^(?:is\s+)?undefined$/i;
const SHAPE   = /^`(\{[^`]+\})`/;
const RESOLVES = /^(?:resolves?|returns?)(?:\s+`(\{[^`]+\})`)?/i;
const NO_ERROR = /^no\s+error$/i;

// ── Property shorthand ────────────────────────────────────────────────

const ALLOWED  = /^allowed(?:\s+again)?$/i;
const DENIED   = /^denied$/i;
const REJECTED = /^(?:account\s+locked|rate\s+limited|locked(?:\s+out)?)$/i;

// ── Side-effect / spy patterns ────────────────────────────────────────

const CALLED      = /^(?:(\w+)\s+)?called(?:\s+(once|twice|\d+\s+times?))?$/i;
const CALLED_WITH = /^(?:(\w+)\s+)?called\s+with\s+(.+)$/i;
const NOT_CALLED  = /^(?:(\w+)\s+)?not\s+called$/i;
const ALL_CALLED  = /^all\s+(?:\w+\s+)?called$/i;

// ── Return type patterns ──────────────────────────────────────────────

// "returns a function" / "returns an unsubscribe function"
const RETURNS_FN  = /^(?:returns?\s+a(?:n?\s+)?(?:\w+\s+)?)?function$/i;
const RETURNS_OBJ = /^returns?\s+an?\s+object(?:\s+with\s+(\w+))?$/i;

// ── Full-text patterns (no arrow) ─────────────────────────────────────

// Safety invariants: "X is safe", "X does nothing", "no error ...", "does not throw"
// Also: "X is a valid state" — asserting that a particular state is permitted (not an error)
const FULL_SAFETY = /\b(?:is\s+safe|does\s+nothing|does\s+not\s+throw|never\s+throws?|no\s+error|does\s+not\s+raise|does\s+not\s+propagate|never\s+propagates?|is\s+a\s+valid\s+state|not\s+an\s+error\s+condition)\b/i;

// Negation invariants: "X does not Y" / "X never Y"
const FULL_DOES_NOT = /\b(?:does\s+not|never)\s+(?:affect|fire|receive|create|store|appear|expose|show|run|execute|consume|increment|trigger|validate|check|verify|stall|block|halt|prevent|interrupt|break)/i;

// Capability claims: "X can create/add/update/..." — asserts a SOFTWARE OPERATION is permitted
// Restricted to action verbs (including past-tense forms) to avoid matching portability claims
// ("can be committed to version control") or risk warnings ("can produce a dangerous protocol")
const FULL_CAN = /\bcan\s+(?:be\s+)?(?:creat(?:e|ed)?|add(?:ed)?|updat(?:e|ed)?|modif(?:y|ied)|delet(?:e|ed)?|remov(?:e|ed)?|read|write|written|import(?:ed)?|export(?:ed)?|chang(?:e|ed)?|set|get|use[sd]?|call(?:ed)?|subscri(?:be|bed)|connect(?:ed)?|register(?:ed)?|send|receiv(?:e|ed)?|configur(?:e|ed)?|access(?:ed)?|build|run|execut(?:e|ed)?|trigger(?:ed)?|emit(?:ted)?|fire[sd]?|stor(?:e|ed)?|load(?:ed)?|generat(?:e|ed)?|extend(?:ed)?|overrid(?:e|den)?|replac(?:e|ed)?|reset|clear(?:ed)?|clos(?:e|ed)|open(?:ed)?|enabl(?:e|ed)?|disabl(?:e|ed)?|toggl(?:e|ed)?|push(?:ed)?|pop(?:ped)?|queu(?:e|ed)?|dequeu(?:e|ed)?)\b/i;

// Independence claims: "requires no X", "there is no X required", "do not require X"
const FULL_REQUIRES_NO = /\b(?:requires?\s+no\b|there\s+is\s+no\b.*\brequired|do\s+not\s+require\b)\b/i;

// Architectural invariants: "X is structural" / "structurally impossible" / "affects only that X"
// "affects only that" and "only that X" are isolation invariants — proven by single-key mutation in AST
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
// "returns a list of links" / "returns an array" — collection return type
const FULL_RETURNS_LIST = /\breturns?\s+a\s+(?:list|array)\b/i;

// Numeric return / fire count: "returns 1", "fires once", "fires zero times", "returns 0"
const FULL_RETURNS_N = /\b(?:returns?|fires?|calls?)\s+(?:exactly\s+)?(\d+|once|twice|zero(?:\s+times?)?)\b/i;

// Leading method word for full-text assertions like "subscribe returns..."
const LEADING_METHOD = /^(\w+)\s+/;

export function tryDeterministic(assertion: RawAssertion): TestCase | null {
  const outcome = assertion.outcome?.trim();

  // ── Full-text patterns (no arrow) ──────────────────────────────────
  if (!outcome) {
    const step = matchFullText(assertion.raw);
    if (!step) return null;

    // Don't extract an implied method — rely on group annotation or auto-inference.
    // Using the first word as a method name produces false positives (e.g. "seeding" → Subject.seeding)
    const action: ActionStep = assertion.callMethod
      ? { method: assertion.callMethod, args: assertion.callArgs, repeat: assertion.repeat }
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
    ? matchInspectOutcome(primary)
    : matchOutcome(primary);

  if (!step) return null;
  if (negations.length > 0) step.negations = negations;

  const action: ActionStep = assertion.callMethod
    ? { method: assertion.callMethod, args: assertion.callArgs, repeat: assertion.repeat }
    : { argDescription: assertion.condition, repeat: assertion.repeat };

  if (assertion.captures) {
    action.captures = assertion.captures;
    if (assertion.captures2 && assertion.callMethod2) {
      action.extraCall = {
        method: assertion.callMethod2,
        args: assertion.callArgs2,
        captures: assertion.captures2,
      };
    }
  }

  return {
    description: assertion.raw,
    setup: [],
    action,
    assertion: step,
    source: "deterministic",
  };
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
  // Plain "throws" / "throw" without a class — most common form in LLD assertions
  if (/^throws?$/i.test(outcome)) return { type: "throws" };

  const throwsMatch = outcome.match(THROWS);
  if (throwsMatch) return { type: "throws", errorClass: throwsMatch[1], errorMessage: throwsMatch[2] };

  if (NO_ERROR.test(outcome))  return { type: "resolves" };
  if (RESOLVES.test(outcome))  { const m = outcome.match(RESOLVES); return { type: "resolves", description: m?.[1] }; }

  // Pure numeric literal first — before ZERO, to avoid "200" matching ZERO (ends in "0")
  if (/^-?\d+(\.\d+)?$/.test(outcome)) {
    return { type: "equals", expected: Number(outcome) };
  }

  // ZERO matches "zero", "is zero", "total is zero" — but NOT pure numbers (handled above)
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

  if (ALLOWED.test(outcome))  return { type: "property", description: "allowed", expected: true };
  if (DENIED.test(outcome))   return { type: "property", description: "allowed", expected: false };
  if (REJECTED.test(outcome)) return { type: "throws" };

  // Return type assertions
  if (RETURNS_FN.test(outcome))  return { type: "property", description: "typeof-function" };
  if (RETURNS_OBJ.test(outcome)) return { type: "property", description: "typeof-object" };

  // Spy patterns
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

function matchFullText(text: string): AssertionStep | null {
  // Fault resilience: "a failed write does not stall the queue" — check BEFORE FULL_DOES_NOT
  // More specific (requires "a failed X" subject), so takes priority over the general "does not" pattern
  if (FAULT_RESILIENCE.test(text)) return { type: "fault-resilience" };

  // Absent field: "field is absent", "is not present in the response", "is not populated"
  // Check before FULL_DOES_NOT / FULL_SAFETY to avoid "not included" → resolves
  if (FULL_ABSENT.test(text)) return { type: "absent" };

  // Contains assertion: "output contains a marker", "stderr includes a sentinel"
  if (FULL_CONTAINS.test(text)) return { type: "contains" };

  // Safety / no-error invariants
  if (FULL_SAFETY.test(text)) return { type: "resolves" };

  // "X does not affect/fire/..." — negative invariant → resolves (asserts no side effect)
  if (FULL_DOES_NOT.test(text)) return { type: "resolves" };

  // Capability claims: "X can create/update/..." — asserts the operation is permitted
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
  // "returns a list" — resolves without crashing; the Array check requires a captures pattern with a method
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

  // "result is not a Type" — instance check: not an instance of the named constructor
  const NOT_INSTANCE = new RegExp(`^(${PATH.source})\\s+is\\s+not\\s+a(?:n)?\\s+(\\w+)$`, "i");
  const notInst = outcome.match(NOT_INSTANCE);
  if (notInst) {
    return { type: "inspect", code: `expect(${notInst[1]} instanceof ${notInst[2]}).toBe(false);` };
  }

  // "result is an Array" — Array.isArray check
  const IS_ARRAY = new RegExp(`^(${PATH.source})\\s+is\\s+an?\\s+Array$`, "i");
  const isArr = outcome.match(IS_ARRAY);
  if (isArr) {
    return { type: "inspect", code: `expect(Array.isArray(${isArr[1]})).toBe(true);` };
  }

  // "result starts with 'prefix'" — string prefix check
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
