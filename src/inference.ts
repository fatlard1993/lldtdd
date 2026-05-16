import { existsSync } from "fs";

export interface InferenceResult {
  method: string;
  confidence: "exact" | "camel" | "partial";
}

export interface ModuleInfo {
  exports: string[];
  api?: string;  // from __lld_api export if present
}

// Load a module's function exports. Returns empty if module doesn't exist.
const moduleCache = new Map<string, ModuleInfo>();

export async function getModuleInfo(modulePath: string): Promise<ModuleInfo> {
  if (!existsSync(modulePath)) return { exports: [] };
  if (moduleCache.has(modulePath)) return moduleCache.get(modulePath)!;

  try {
    const mod = await import(modulePath);
    const exports = Object.keys(mod).filter(k =>
      typeof mod[k] === "function" && k !== "default" && !k.startsWith("__")
    );
    const api = typeof mod.__lld_api === "string" ? mod.__lld_api.trim() : undefined;
    const info: ModuleInfo = { exports, api };
    moduleCache.set(modulePath, info);
    return info;
  } catch {
    return { exports: [] };
  }
}

// Convenience: just the export names
export async function getModuleExports(modulePath: string): Promise<string[]> {
  return (await getModuleInfo(modulePath)).exports;
}

// Try to match a group heading to an exported function name.
// Conservative — only matches when confident. Returns null if uncertain.
export function matchGroupToExport(
  groupName: string,
  exports: string[]
): InferenceResult | null {
  if (exports.length === 0) return null;

  const name = groupName.trim();
  const words = name.split(/[\s_]+/).filter(Boolean);
  if (words.length === 0) return null;

  // 1. Exact: "parseBool" -> parseBool, "Login" -> login
  const slug = name.replace(/\s+/g, "").toLowerCase();
  const exact = exports.find(e => e.toLowerCase() === slug);
  if (exact) return { method: exact, confidence: "exact" };

  // 2. Standard camelCase: "Token validation" -> tokenValidation
  const camel =
    words[0].toLowerCase() +
    words.slice(1).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  if (exports.includes(camel)) return { method: camel, confidence: "camel" };

  // 3. Reversed camelCase: "Token validation" -> validateToken
  //    "Publishing" -> publish, "Subscribing" -> subscribe
  if (words.length >= 2) {
    // last word as verb stem + earlier as noun
    for (const verbForm of verbForms(words[words.length - 1])) {
      const noun = words
        .slice(0, -1)
        .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join("");
      const candidate = verbForm + noun;
      if (exports.includes(candidate)) return { method: candidate, confidence: "camel" };
    }

    // first word as verb stem + rest as noun
    for (const verbForm of verbForms(words[0])) {
      const noun = words
        .slice(1)
        .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join("");
      const candidate = verbForm + noun;
      if (exports.includes(candidate)) return { method: candidate, confidence: "camel" };
    }
  }

  // 4. Any single word in the group (exact or de-verbed) matches an export
  for (const word of words) {
    for (const form of verbForms(word)) {
      const match = exports.find(e => e.toLowerCase() === form);
      if (match) return { method: match, confidence: "partial" };
    }
  }

  return null;
}

// Generate candidate verb forms from a word: "publishing" -> ["publishing", "publish", "publishe"]
function verbForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms = [w];

  if (w.endsWith("ing")) {
    forms.push(w.slice(0, -3));        // "publishing" -> "publish"
    forms.push(w.slice(0, -3) + "e");  // "subscribing" -> "subscribe"
  }
  if (w.endsWith("ation")) {
    forms.push(w.slice(0, -5) + "ate"); // "validation" -> "validate"
  }
  if (w.endsWith("tion")) {
    forms.push(w.slice(0, -4) + "te");  // "creation" -> "create"
  }
  if (w.endsWith("al")) {
    forms.push(w.slice(0, -2)); // "removal" -> "remov" — safe only if in exports
  }

  return forms;
}

export function clearModuleCache() {
  moduleCache.clear();
}

// ── __lld_api description matching ───────────────────────────────────
// Matches a group to an __lld_api method by scoring token overlap between
// the method's description and the combined group name + claim vocabulary.
// Uses 5-char stem prefix to bridge write/writes, order/ordering, etc.

const STOP = new Set([
  "a","an","the","is","not","to","of","and","or","in","at","by","for",
  "with","on","that","this","are","be","was","were","it","as","from",
  "has","have","do","does","did","when","if","only","all","any","no",
  "but","can","will","just","one","two","its","their","our","each",
  "after","then","same","new","true","false","null","set","result",
]);

// Dual-stem: emit both 4-char and 5-char prefixes so "read" and "reads",
// "order" and "ordering", "write" and "writes" all collapse to the same key.
function apiTokens(text: string): string[] {
  const raw = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of raw) {
    out.add(w.slice(0, 4));
    if (w.length >= 5) out.add(w.slice(0, 5));
  }
  return [...out];
}

export function matchGroupToApi(
  groupName: string,
  claims: string[],
  api: string,
  threshold = 0.35
): { method: string; description: string; score: number } | null {
  const sourceBag = new Set([
    ...apiTokens(groupName),
    ...claims.flatMap(c => apiTokens(c)),
  ]);
  if (sourceBag.size === 0) return null;

  let best: { method: string; description: string; score: number } | null = null;

  for (const line of api.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pipeIdx = trimmed.indexOf("|");
    if (pipeIdx === -1) continue;

    const methodName = trimmed.slice(0, pipeIdx).trim().split(/[\s(]/)[0];
    const description = trimmed.slice(pipeIdx + 1).trim();
    if (!methodName || !description) continue;

    const descTokens = apiTokens(description);
    if (descTokens.length === 0) continue;

    const overlapCount = descTokens.filter(t => sourceBag.has(t)).length;
    // F1 of precision (overlap/desc) and recall (overlap/source):
    // rewards specificity — a short description that matches all its tokens scores lower
    // than a longer description that matches most of its tokens, because recall penalises
    // the short description's failure to cover the group vocabulary.
    const precision = overlapCount / descTokens.length;
    const recall    = overlapCount / sourceBag.size;
    const score     = precision + recall < 1e-9 ? 0 : 2 * precision * recall / (precision + recall);

    if (score >= threshold && (!best || score > best.score)) {
      best = { method: methodName, description, score };
    }
  }

  return best;
}
