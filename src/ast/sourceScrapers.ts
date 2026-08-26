// Regex-over-raw-source scrapers. Everything in this file reads source text with regular
// expressions and bracket-aware scanning -- no ts-morph, no file I/O. The facts carry AST-sounding
// names downstream, but the substance here is regex; keeping every such site in one file makes
// that split legible instead of scattered through the extraction driver.

import type {
  AllowlistInfo, ValidationLocationInfo, LifecycleHints, EventTargetClassInfo, ComponentClassInfo,
} from "./types.ts";
import { VERB_IMPLIES } from "./types.ts";

// ── Call-argument scanning ───────────────────────────────────────────

// Extracts top-level comma-separated arguments from a call expression.
// `start` is the index just after the opening paren.
// Handles nested brackets and string literals containing commas/braces.
export function extractCallArgs(src: string, start: number): string[] {
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

// ── Export-verb semantics ────────────────────────────────────────────

/** Maps exported const names to the verb semantics their prefix implies (see VERB_IMPLIES). */
export function scrapeExportVerbs(allSource: string): Record<string, { sideEffect: boolean; returns: string }> {
  const exportVerbs: Record<string, { sideEffect: boolean; returns: string }> = {};
  for (const m of allSource.matchAll(/export\s+const\s+(\w+)/g)) {
    const name = m[1];
    const lower = name.toLowerCase();
    for (const [verb, impl] of Object.entries(VERB_IMPLIES)) {
      if (lower.startsWith(verb)) { exportVerbs[name] = impl; break; }
    }
  }
  return exportVerbs;
}

// ── Fault-injection targets ──────────────────────────────────────────

// Detect patchable fault injection targets from:
//   withFaultInjection(target, "method", ...) calls -- the new declarative form
//   const orig = X.Y.method; X.Y.method = async () => {} -- the old manual form
export function scrapeFaultTargets(allSource: string): Record<string, string> {
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
  return faultTargets;
}

// ── Lifecycle options ────────────────────────────────────────────────

/** Extracts lifecycle options from a createDbLifecycle call in the module's own source,
 *  e.g. createDbLifecycle(db, ["bookmarks", "categories"], { prefix: "lld-bm-" }). */
export function scrapeLifecycleOptions(source: string): { collections: string[]; prefix?: string } | undefined {
  const lcCallMatch = source.match(/createDbLifecycle\s*\([^,]+,\s*(\[.*?\])\s*(?:,\s*\{[^}]*prefix\s*:\s*["']([^"']+)["'][^}]*\})?\s*\)/s);
  // The __lld_lifecycle export is optional: the adapter derives collections=[] and a basename
  // prefix automatically for isSelfDatabase modules, so most never declare it.
  const lldLifecycleMatch = source.match(/__lld_lifecycle\s*=\s*\{[^}]*collections\s*:\s*(\[[^\]]*\])[^}]*(?:prefix\s*:\s*["']([^"']+)["'])?[^}]*\}/s);
  return lcCallMatch
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
}

// ── Self-database detection ──────────────────────────────────────────

/** Detects if the module itself IS the database object (has init/write/db pattern, no db import).
 *  Does NOT require __lld_lifecycle -- the annotation was just a workaround. */
export function detectSelfDatabase(source: string, databaseModulePath: string | undefined): boolean {
  return !databaseModulePath
    && /\bwrite\s*\(\s*\)/.test(source)
    && /\binit\s*\(/.test(source)
    && /\bdb\b/.test(source);
}

// ── Default-exported class shapes ────────────────────────────────────

export function detectEventTargetClass(source: string): EventTargetClassInfo | undefined {
  const m = source.match(/^export\s+default\s+class\s+(\w+)\s+extends\s+EventTarget/m);
  if (!m) return undefined;
  return {
    name: m[1],
    hasSubscribe: /\bsubscribe\s*\(/.test(source),
    hasDestroy: /\bdestroy\s*\(\s*\)/.test(source),
    hasIsDestroyed: /\bisDestroyed\b/.test(source),
    hasBatch: /\bbatch\s*\(/.test(source),
  };
}

export function detectComponentClass(source: string): ComponentClassInfo | undefined {
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
}

// ── Allowlist extraction ─────────────────────────────────────────────
// Detects: const ALLOWED_X = ['a', 'b']
//          const VALID_X   = ['a', 'b']

const ALLOWLIST_DECL = /const\s+((?:ALLOWED|VALID|PERMITTED|WHITELIST)\w*)\s*=\s*(\[[^\]]+\])/g;

export function extractAllowlists(source: string): AllowlistInfo[] {
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

export function extractValidationLocations(source: string): ValidationLocationInfo[] {
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

export function inferLifecycleFunctions(source: string): LifecycleHints {
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

// ── Field type extraction ─────────────────────────────────────────────

interface FieldTypeInfo { unionLiterals?: string[] }

/** Scans TypeScript source for union literal types on known field names, e.g. `status: "active" | "inactive"`. */
export function extractFieldTypes(source: string, fields: string[]): Map<string, FieldTypeInfo> {
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
