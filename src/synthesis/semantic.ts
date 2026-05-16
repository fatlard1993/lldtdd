export interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
}

// Each rule: if the assertion description matches the pattern, generate a value for the param
const SEMANTIC_RULES: Array<{
  pattern: RegExp;
  generate: (param: ParamInfo, description: string) => unknown;
}> = [
  // Empty string / blank / no value
  {
    pattern: /\bempty\b/i,
    generate: (p) => {
      const t = p.type.toLowerCase();
      if (t.includes("[]") || t.includes("array")) return [];
      if (t.includes("record") || t.includes("{}") || t.includes("object")) return {};
      return "";
    },
  },

  // Null / nil
  { pattern: /\bnull\b/i, generate: () => null },

  // Unknown / nonexistent / missing / ghost
  {
    pattern: /\b(?:unknown|nonexistent|missing|ghost)\b/i,
    generate: (p, desc) => {
      const idInDesc = /\bid\b/i.test(desc);
      if (p.name === "id" || p.name.toLowerCase().endsWith("id")) {
        return p.type.includes("{") ? { id: "nonexistent-xyz" } : "nonexistent-xyz";
      }
      // opts/options param with "id" in description → use object form
      if ((p.name === "opts" || p.name === "options") && idInDesc) {
        return { id: "nonexistent-xyz" };
      }
      if (idInDesc) return { id: "nonexistent-xyz" };
      return "nonexistent-xyz";
    },
  },

  // Wrong / incorrect / bad — typically for passwords or other credentials
  {
    pattern: /\b(?:wrong|incorrect|bad)\b/i,
    generate: (p) => {
      const n = p.name.toLowerCase();
      if (n.includes("password") || n.includes("pass")) return "wrongpassword";
      if (n.includes("email")) return "wrong@notvalid.example";
      return "invalid-value-xyz";
    },
  },

  // Valid / correct / good credentials
  {
    pattern: /\b(?:valid\s+credentials?|correct\s+credentials?|good\s+credentials?)\b/i,
    generate: (p) => {
      const n = p.name.toLowerCase();
      if (n.includes("email")) return "user@example.com";
      if (n.includes("password") || n.includes("pass")) return "password123";
      return "valid-value";
    },
  },

  // Fresh / new key
  {
    pattern: /\bfresh\b/i,
    generate: (p) => {
      const n = p.name.toLowerCase();
      if (n.includes("key")) return "fresh-key-test";
      return "fresh-value-test";
    },
  },
];

// Type-based defaults used when no semantic rule matches
const TYPE_DEFAULTS: Array<[RegExp, unknown]> = [
  [/^string$/i,                     "test-value"],
  [/^number$/i,                     0],
  [/^boolean$/i,                    false],
  [/^string\[\]$/i,                 []],
  [/^number\[\]$/i,                 []],
  [/\{\s*id\s*\?\s*:/i,             { id: "test-id" }],
  [/\{\s*id\s*:/i,                  { id: "test-id" }],
  [/^record</i,                     {}],
  [/object/i,                       {}],
];

export function synthesizeArg(description: string, param: ParamInfo, allParams: ParamInfo[]): unknown {
  for (const rule of SEMANTIC_RULES) {
    if (rule.pattern.test(description)) {
      return rule.generate(param, description);
    }
  }

  const t = param.type.trim();
  for (const [pattern, def] of TYPE_DEFAULTS) {
    if (pattern.test(t)) return def;
  }

  return "test-value";
}

export function hasSemanticSignal(description: string): boolean {
  return SEMANTIC_RULES.some(r => r.pattern.test(description));
}
