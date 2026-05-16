import type { AssertionStep } from "../types.ts";

// Matches: "string", 'string', number, null, true, false at start of text
const QUOTED  = /^(['"])((?:\\.|[^\\])*?)\1/;
const NUMBER  = /^(-?\d+(?:\.\d+)?)\b/;
const KEYWORD = /^(null|true|false)\b/i;

export interface LiteralExtraction {
  value: unknown;
  rest: string;
}

export function extractLeadingLiteral(text: string): LiteralExtraction | null {
  const t = text.trimStart();

  const q = t.match(QUOTED);
  if (q) return { value: q[2], rest: t.slice(q[0].length).trimStart() };

  const n = t.match(NUMBER);
  if (n) return { value: Number(n[1]), rest: t.slice(n[0].length).trimStart() };

  const k = t.match(KEYWORD);
  if (k) {
    const v = k[1].toLowerCase();
    return { value: v === "null" ? null : v === "true", rest: t.slice(k[0].length).trimStart() };
  }

  return null;
}

// Extract the meaningful primitive value from a negation phrase.
// "parsed as 42" → "42"   "null" → "null"   "an empty object" → "{}"
function extractNegValue(phrase: string): string {
  const t = phrase.trim();
  const trailNum = t.match(/\b(-?\d+(?:\.\d+)?)\s*$/);
  if (trailNum) return trailNum[1];
  if (/\bnull\b/i.test(t))      return "null";
  if (/\bundefined\b/i.test(t)) return "undefined";
  if (/\btrue\b/i.test(t))      return "true";
  if (/\bfalse\b/i.test(t))     return "false";
  if (/\bempty\s+array\b/i.test(t))  return "[]";
  if (/\bempty\s+string\b/i.test(t)) return `""`;
  if (/\bempty\s+object\b/i.test(t)) return "{}";
  return t;
}

// Infer an assertion step from the text that follows a leading literal.
// Returns null when the rest of the text doesn't imply a clear assertion.
export function inferAssertionFromRemainder(
  rest: string,
  literal: unknown
): { step: AssertionStep; negations: string[] } | null {
  // Strip trailing " // prose explanation"
  const stripped = rest
    .replace(/ \/\/ .+$/, "")
    .trim()
    .toLowerCase();

  // Parse ", not X [and not Y]" qualifier
  const notIdx = stripped.search(/,\s*not\s+/i);
  const primary = notIdx >= 0 ? stripped.slice(0, notIdx).trim() : stripped;
  const negations = notIdx >= 0
    ? stripped
        .slice(notIdx)
        .replace(/^,\s*not\s+/i, "")
        .split(/\s+and\s+(?:not\s+)?/i)
        .map(s => extractNegValue(s.replace(/^not\s+/i, "").trim()))
        .filter(Boolean)
    : [];

  // "is rejected" / "passes through" / "unchanged" / "returns itself"
  // → the function returns the input unchanged
  if (/\b(?:is\s+rejected|passes?\s+through(?:\s+unchanged)?|returns?\s+itself|unchanged)\b/.test(primary)) {
    return { step: { type: "equals", expected: literal }, negations };
  }

  // "is valid" / "is accepted" / "is safe" → the call succeeds without throwing
  if (/\b(?:is\s+valid|is\s+accepted|is\s+safe|is\s+allowed|does\s+not\s+throw)\b/.test(primary)) {
    return { step: { type: "resolves" }, negations };
  }

  // "is truthy" → true
  if (/\bis\s+truthy\b/.test(primary)) {
    return { step: { type: "equals", expected: true }, negations };
  }

  // "is falsy" → false
  if (/\bis\s+falsy\b/.test(primary)) {
    return { step: { type: "equals", expected: false }, negations };
  }

  // "produces N elements" → length check
  const lengthMatch = primary.match(/\bproduces?\s+(?:(\w+)|(a\s+one))?\s+(\d+)?\s*elements?/i);
  if (lengthMatch) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const n = lengthMatch[3]
      ? parseInt(lengthMatch[3])
      : words[lengthMatch[1]?.toLowerCase()] ?? null;
    if (n !== null) {
      return { step: { type: "inspect", code: `expect(_result.length).toBe(${n});` }, negations };
    }
  }

  // If there are negations but no clear primary → assert defined + negations
  if (negations.length > 0) {
    return { step: { type: "property", description: "defined" }, negations };
  }

  return null;
}
