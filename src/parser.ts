import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import type { LLDDocument, LLDGroup, RawAssertion } from "./types.ts";

const ARROW = "→";
const REPEAT_PREFIX = /^(\d+)\s*[×x]\s*/i;
// "then" signals temporal chaining: second call's args may reference the first capture by name
// e.g. "create(A) captures r then update({ id: r.id }) captures result → result.field === X"
const DOUBLE_CAPTURE = /^(.+?)\s+captures\s+(\w+)\s+(?:and|then)\s+(.+?)\s+captures\s+(\w+)$/i;
const SINGLE_CAPTURE = /^(.+?)\s+captures\s+(\w+)$/i;

export async function parseFile(filePath: string): Promise<LLDDocument> {
  const raw = await readFile(filePath, "utf-8");
  // Normalize ASCII arrow -> to unicode arrow for consistent parsing
  const content = raw.replace(/ *-> */g, " → ");
  return parse(content, filePath);
}

export function parse(content: string, sourcePath: string): LLDDocument {
  const lines = content.split("\n");

  let title = "";
  let moduleRaw = "";
  let docBeforeAll = "";
  let docBeforeEach = "";
  const descLines: string[] = [];
  const groups: LLDGroup[] = [];
  let currentGroup: LLDGroup | null = null;
  let bodyStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!title) {
      if (trimmed.startsWith("# ")) title = trimmed.slice(2).trim();
      continue;
    }

    if (!moduleRaw && trimmed.startsWith("> ")) {
      moduleRaw = trimmed.slice(2).trim();
      continue;
    }

    // Document-level lifecycle defaults (before any ## group heading)
    if (!currentGroup && !bodyStarted) {
      const dba = trimmed.match(/^\*\*beforeall:\*\*\s*`(.+?)`/i);
      if (dba) { docBeforeAll = dba[1].trim(); continue; }
      const dbe = trimmed.match(/^\*\*beforeeach:\*\*\s*`(.+?)`/i);
      if (dbe) { docBeforeEach = dbe[1].trim(); continue; }
    }

    if (trimmed.startsWith("## ")) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { name: trimmed.slice(3).trim(), assertions: [] };
      bodyStarted = true;
      continue;
    }

    if (currentGroup) {
      const ctxMatch = trimmed.match(/^\*\*context:\*\*\s*(.+)/i);
      if (ctxMatch) { currentGroup.context = ctxMatch[1].trim(); continue; }

      const setupMatch = trimmed.match(/^\*\*setup:\*\*\s*`(.+?)`/i);
      if (setupMatch) { currentGroup.setup = setupMatch[1].trim(); continue; }

      const methodMatch = trimmed.match(/^\*\*method:\*\*\s*`(.+?)`/i);
      if (methodMatch) { currentGroup.method = methodMatch[1].trim(); continue; }

      const moduleOverrideMatch = trimmed.match(/^\*\*module:\*\*\s*`(.+?)`/i);
      if (moduleOverrideMatch) {
        const raw = moduleOverrideMatch[1].trim();
        const base = resolve(sourcePath);
        currentGroup.moduleOverride = raw.startsWith("./") || raw.startsWith("../")
          ? resolve(dirname(base), raw)
          : resolve(process.cwd(), raw);
        continue;
      }

      const beforeEachMatch = trimmed.match(/^\*\*beforeeach:\*\*\s*`(.+?)`/i);
      if (beforeEachMatch) { currentGroup.beforeEach = beforeEachMatch[1].trim(); continue; }

      const beforeAllMatch = trimmed.match(/^\*\*beforeall:\*\*\s*`(.+?)`/i);
      if (beforeAllMatch) { currentGroup.beforeAll = beforeAllMatch[1].trim(); continue; }

      const mockHttpMatch = trimmed.match(/^\*\*mock-http:\*\*\s*`(.+?)`/i);
      if (mockHttpMatch) {
        try { currentGroup.mockHttp = JSON.parse(mockHttpMatch[1].trim()); } catch {}
        continue;
      }

      // Indented sub-bullet: "  - question?" is a perspective on the preceding assertion
      if (/^\s{2,}-\s/.test(line)) {
        const text = line.replace(/^\s+-\s/, "").trim();
        const last = currentGroup.assertions[currentGroup.assertions.length - 1];
        if (last) {
          last.perspectives = last.perspectives ?? [];
          last.perspectives.push(parseAssertion(text));
        }
        continue;
      }

      if (trimmed.startsWith("- ")) {
        currentGroup.assertions.push(parseAssertion(trimmed.slice(2).trim()));
      }
      continue;
    }

    if (!bodyStarted && trimmed && !trimmed.startsWith("#")) {
      descLines.push(trimmed);
    }
  }

  if (currentGroup) groups.push(currentGroup);

  // Resolve absolute source path early for module resolution
  const absSource = resolve(sourcePath);
  const module = moduleRaw
    ? moduleRaw.startsWith("./") || moduleRaw.startsWith("../")
      ? resolve(dirname(absSource), moduleRaw)
      : resolve(process.cwd(), moduleRaw)
    : "";

  return {
    title,
    module,
    description: descLines.join(" ").trim() || undefined,
    defaultBeforeAll: docBeforeAll || undefined,
    defaultBeforeEach: docBeforeEach || undefined,
    groups,
    sourcePath: absSource,
  };
}

function parseAssertion(text: string): RawAssertion {
  const repeatMatch = text.match(REPEAT_PREFIX);
  let body = text;
  let repeat: number | undefined;

  if (repeatMatch) {
    repeat = parseInt(repeatMatch[1], 10);
    body = text.slice(repeatMatch[0].length).trim();
  }

  const arrowIdx = body.indexOf(ARROW);
  if (arrowIdx >= 0) {
    const conditionRaw = body.slice(0, arrowIdx).trim();
    const outcome = body.slice(arrowIdx + ARROW.length).trim();

    // Double capture
    const doubleMatch = conditionRaw.match(DOUBLE_CAPTURE);
    if (doubleMatch) {
      const [, call1, cap1, call2, cap2] = doubleMatch;
      const m1 = parseCallExpr(call1.trim());
      const m2 = parseCallExpr(call2.trim());
      return {
        raw: text, condition: call1.trim(), outcome, repeat,
        captures: cap1, callMethod: m1?.method, callArgs: m1?.args,
        callMethod2: m2?.method, callArgs2: m2?.args, captures2: cap2,
      };
    }

    // Single capture
    const singleMatch = conditionRaw.match(SINGLE_CAPTURE);
    if (singleMatch) {
      const [, callPart, capName] = singleMatch;
      const m = parseCallExpr(callPart.trim());
      return {
        raw: text, condition: callPart.trim(), outcome, repeat,
        captures: capName, callMethod: m?.method, callArgs: m?.args,
      };
    }

    // Regular call expression
    const m = parseCallExpr(conditionRaw);
    if (m) {
      return { raw: text, condition: conditionRaw, outcome, repeat, callMethod: m.method, callArgs: m.args };
    }

    return { raw: text, condition: conditionRaw, outcome, repeat };
  }

  return { raw: text, repeat };
}

// ── Argument parsing ──────────────────────────────────────────────────

// Handles nested parens, brackets, and braces when extracting method + args
function parseCallExpr(s: string): { method: string; args: unknown[] } | null {
  const parenOpen = s.indexOf("(");
  if (parenOpen < 0) return null;

  const method = s.slice(0, parenOpen).trim();
  if (!/^\w+$/.test(method)) return null;

  // Find the matching close paren, respecting nesting
  let depth = 0;
  let end = -1;
  for (let i = parenOpen; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end !== s.length - 1) return null;

  return { method, args: parseArgList(s.slice(parenOpen + 1, end)) };
}

export function parseArgList(argsStr: string): unknown[] {
  if (!argsStr.trim()) return [];
  return splitArgs(argsStr).map(parseArgValue);
}

// Splits on commas, respecting string literals, (), [], {}
function splitArgs(s: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (const ch of s) {
    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      tokens.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function parseArgValue(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  if (t === "null") return null;
  if (t === "undefined") return undefined;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^["'].*["']$/s.test(t)) return t.slice(1, -1);

  // Array literal
  if (t.startsWith("[") && t.endsWith("]")) {
    return parseArgList(t.slice(1, -1));
  }

  // Object literal
  if (t.startsWith("{") && t.endsWith("}")) {
    // Convert JS-style keys to JSON-style for parsing
    try {
      return JSON.parse(t.replace(/(\w+):/g, '"$1":'));
    } catch {
      return { __expr: t };
    }
  }

  // Constructor / new expression — pass through as raw code
  if (t.startsWith("new ")) return { __expr: t };

  return t;
}
