// Mock-response shape derivation: reads a module's own declared response-shape keys out of its
// source and builds a matching mock, so the shape comes from the code rather than from a table.

import { FIELD_VALUES } from "./types.ts";


export function normalizeToFixtureValues(obj: unknown): unknown {
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

export function deriveMockShape(source: string): unknown | undefined {
  // Find withMockFetch(OBJECT_LITERAL, ...) calls -- the first arg IS the mock shape
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

/** Builds a mock response for a module that declares where its results live.
 *
 *  Every key comes out of the module's own source, so this adapts to whatever a project named its
 *  response fields. It returns `undefined` when the source declares neither a name nor a URL
 *  property -- the previous fallback guessed the shape from a table of one project's fixtures, which
 *  meant an unrecognized module silently got someone else's response shape instead of nothing. */
export function deriveResponseMockShape(source: string): unknown | undefined {
  if (!/\bfetch\b/.test(source) && !/\bsearchProvider\b/.test(source)) return undefined;

  const resultsKey = source.match(/\bresultsPath\s*:\s*["']([^"']+)["']/)?.[1] ?? "results";
  const nameKey    = source.match(/\bnameProperty\s*:\s*["']([^"']+)["']/)?.[1];
  const urlKey     = source.match(/\burlProperty\s*:\s*["']([^"']+)["']/)?.[1];
  if (!nameKey && !urlKey) return undefined;

  const item: Record<string, string> = { [urlKey ?? "url"]: "https://example.com" };
  if (nameKey && nameKey !== urlKey) item[nameKey] = "Test Result";
  return { [resultsKey]: [item] };
}

