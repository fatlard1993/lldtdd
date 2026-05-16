/**
 * Mutation testing for LLD assertions.
 *
 * Applies targeted mutations to the implementation and runs the LLD-generated
 * tests. A surviving mutation means the corresponding behavior is undocumented
 * or too weakly asserted in the LLD.
 *
 * Logic ported from ctx-mutate (standalone bash/awk script). Kept here so
 * lldtdd doesn't depend on external tooling that may change.
 */

import { readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";

export interface Mutation {
  description: string;
  apply: (source: string) => string;
}

// ── Mutation catalog ──────────────────────────────────────────────────
// Each mutation transforms the source in one targeted way.
// If tests don't catch it → that behavior is uncovered.

export function buildMutations(source: string): Array<{ mutation: Mutation; mutated: string }> {
  const results: Array<{ mutation: Mutation; mutated: string }> = [];

  const lines = source.split("\n");

  // Track which lines are inside template literals (multi-line strings) — skip those for mutations
  // since mutating string content doesn't test code behavior.
  const inTemplateLiteral = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "`") depth = depth === 0 ? 1 : 0;
    }
    if (depth > 0) inTemplateLiteral.add(i);
  }

  // 1. Flip === to !== (first 5 occurrences)
  let eqCount = 0;
  lines.forEach((line, i) => {
    if (eqCount >= 5) return;
    if (inTemplateLiteral.has(i)) return;
    if (!line.includes("===")) return;
    eqCount++;
    const mutated = lines.map((l, j) =>
      j === i ? l.replace(/===/, "!==") : l
    ).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${i + 1}: === → !==`, apply: s => s },
        mutated,
      });
    }
  });

  // 2. Return null instead of meaningful return values (first 3)
  let retCount = 0;
  lines.forEach((line, i) => {
    if (retCount >= 3) return;
    if (inTemplateLiteral.has(i)) return;
    if (!/\breturn\b/.test(line)) return;
    if (/return\s+(null|undefined|false|true|0|void)/.test(line)) return;
    if (/return\s*;/.test(line)) return;
    retCount++;
    // Replace full return statement up to the semicolon (allows { } in expression)
    const mutated = lines.map((l, j) =>
      j === i ? l.replace(/return\s+[^;]+;/, "return null;").replace(/return\s+[^;\n]+$/, "return null") : l
    ).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${i + 1}: return value → null`, apply: s => s },
        mutated,
      });
    }
  });

  // 3. Flip boolean literals
  if (source.includes("return true")) {
    const mutated = source.replace(/\breturn true\b/g, "return false");
    if (mutated !== source) {
      results.push({
        mutation: { description: "return true → return false", apply: s => s },
        mutated,
      });
    }
  }
  if (source.includes("return false")) {
    const mutated = source.replace(/\breturn false\b/g, "return true");
    if (mutated !== source) {
      results.push({
        mutation: { description: "return false → return true", apply: s => s },
        mutated,
      });
    }
  }

  // 4. Remove null / undefined guards (first 3 if statements)
  let guardCount = 0;
  lines.forEach((line, i) => {
    if (guardCount >= 3) return;
    if (!line.match(/if\s*\(!|===\s*null|===\s*undefined|!==\s*null/)) return;
    guardCount++;
    const mutated = lines.filter((_, j) => j !== i).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${i + 1}: guard removed`, apply: s => s },
        mutated,
      });
    }
  });

  // 5. Negate a conditional throw (first occurrence)
  const throwGuardIdx = lines.findIndex(l =>
    /if\s*\(/.test(l) && lines[lines.indexOf(l) + 1]?.includes("throw")
  );
  if (throwGuardIdx >= 0) {
    const mutated = lines.map((l, i) => {
      if (i !== throwGuardIdx) return l;
      // Negate the condition: if (!x) → if (x), if (x) → if (!x)
      if (l.includes("if (!")) return l.replace("if (!", "if (");
      return l.replace(/if\s*\(([^)]+)\)/, (_, cond) => `if (!(${cond}))`);
    }).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${throwGuardIdx + 1}: throw guard negated`, apply: s => s },
        mutated,
      });
    }
  }

  return results;
}

// Scan backwards from a line to find the name of the enclosing function/method.
function detectEnclosingFunction(lines: string[], fromLine: number): string | undefined {
  const fnPattern = /(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?::\s*(?:async\s+)?function|\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))|\b(\w+)\s*\([^)]*\)\s*\{)/;
  for (let i = fromLine; i >= 0; i--) {
    const m = lines[i].match(fnPattern);
    if (m) return (m[1] ?? m[2] ?? m[3])?.trim();
  }
  return undefined;
}

// ── Runner ────────────────────────────────────────────────────────────

export interface MutationResult {
  description: string;
  survived: boolean;
  /** The actual source line that was mutated — gives context for what behavior is uncovered. */
  sourceLine?: string;
  /** The name of the function/method containing the mutated line. */
  functionName?: string;
  /** Descriptions of tests that still passed with this mutation applied — the weak claims. */
  uncoveredBy: string[];
}

export async function runMutations(
  implementationPath: string,
  testRunner: (path: string) => Promise<import("./types.ts").RunResult>
): Promise<MutationResult[]> {
  if (!existsSync(implementationPath)) return [];

  const source = await readFile(implementationPath, "utf-8");
  const mutations = buildMutations(source);
  const results: MutationResult[] = [];

  const sourceLines = source.split("\n");

  // Write each mutation to a unique temp path — never touches the original.
  // A unique path means Bun's cross-process transpilation cache has no prior entry,
  // so the subprocess always compiles and runs the mutated content.
  for (const { mutation, mutated } of mutations) {
      const lineMatch = mutation.description.match(/^line (\d+):/);
      const lineIdx = lineMatch ? parseInt(lineMatch[1]) - 1 : -1;
      const sourceLine = lineIdx >= 0 ? sourceLines[lineIdx]?.trim() : undefined;
      const functionName = lineIdx >= 0 ? detectEnclosingFunction(sourceLines, lineIdx) : undefined;

      const ext = extname(implementationPath);
      const tempMutPath = join(tmpdir(), `lldtdd-mut-${Date.now()}${ext}`);
      await writeFile(tempMutPath, mutated);

      let survived = false;
      let uncoveredBy: string[] = [];
      try {
        const result = await testRunner(tempMutPath);
        survived = result.failed === 0 && result.passed > 0;
        if (survived) {
          const keywords = sourceLine
            ? sourceLine.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3)
            : [];
          const allClaims = result.cases.flatMap(c => [
            ...(c.status === "pass" ? [c.description] : []),
            ...(c.perspectives ?? []).filter(p => p.status === "pass").map(p => p.description),
          ]);
          const fnKeywords = functionName
            ? functionName.toLowerCase().replace(/([A-Z])/g, " $1").trim().split(/\s+/).filter(w => w.length > 2)
            : keywords;
          uncoveredBy = fnKeywords.length > 0
            ? allClaims.filter(d => fnKeywords.some(kw => d.toLowerCase().includes(kw)))
            : [];
        }
      } catch {
        survived = false;
      }

      results.push({ description: mutation.description, survived, sourceLine, functionName, uncoveredBy });
      await unlink(tempMutPath).catch(() => {});
    }

  return results;
}

// Zero-arg scenario: demonstrates that a source string with a binary operator produces mutations
export const mutationsFromSource = () =>
  buildMutations("function fn(a: number, b: number) { return a === b; }");
