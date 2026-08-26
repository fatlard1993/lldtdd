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
import { join, dirname, extname } from "path";
import { randomUUID } from "crypto";
import { availableParallelism } from "os";
import { trackTempFile, untrackTempFile } from "./tempFiles.ts";
import type { RunResult } from "./types.ts";

export interface Mutation {
  description: string;
}

// ── Mutation catalog ──────────────────────────────────────────────────
// Each mutation transforms the source in one targeted way.
// If tests don't catch it → that behavior is uncovered.

/** Rewrites the condition of the first `if (...)` on a line, walking to the balanced closing
 *  paren rather than matching `[^)]+`. `if (foo(x))` has a nested paren, and a non-balanced match
 *  stops at the inner `)` and emits `if (!(foo(x))` -- a syntax error, which produces a mutant
 *  that cannot load. Returns null when the line has no balanced `if (...)`. */
function rewriteIfCondition(line: string, rewrite: (cond: string) => string): string | null {
  const open = line.search(/\bif\s*\(/);
  if (open < 0) return null;
  const parenStart = line.indexOf("(", open);
  let depth = 0;
  for (let i = parenStart; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) {
        const cond = line.slice(parenStart + 1, i);
        return line.slice(0, parenStart + 1) + rewrite(cond) + line.slice(i);
      }
    }
  }
  return null; // condition continues onto the next line -- not safely rewritable here
}

/** True when the mutated source still parses as TypeScript.
 *
 *  A mutant that does not parse cannot load, and a mutant that cannot load teaches nothing about
 *  the claims -- it is wasted work at best and, before the runner learned to tell "never ran" from
 *  "was caught", it was scored as a kill and actively inflated confidence. The operators below
 *  are written not to emit broken code; this is the backstop that keeps a future operator's edge
 *  case from silently becoming a false green again. */
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

function parses(source: string): boolean {
  try {
    TRANSPILER.transformSync(source);
    return true;
  } catch {
    return false;
  }
}

export function buildMutations(source: string): Array<{ mutation: Mutation; mutated: string }> {
  // Operators push candidates here; the parse filter at the bottom decides what escapes.
  const results: Array<{ mutation: Mutation; mutated: string }> = [];

  const lines = source.split("\n");

  // Track which lines are inside template literals (multi-line strings) -- skip those for mutations
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
        mutation: { description: `line ${i + 1}: === → !==` },
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
    // The return statement has to finish on this line. A multi-line return --
    //   return {
    //     a, b,
    //   };
    // -- has no semicolon here, and rewriting just the first line to `return null` orphans the
    // object body below it, which is a syntax error rather than a mutation.
    if (!/\breturn\s+[^;]*;/.test(line)) return;
    retCount++;
    const mutated = lines.map((l, j) =>
      j === i ? l.replace(/\breturn\s+[^;]+;/, "return null;") : l
    ).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${i + 1}: return value → null` },
        mutated,
      });
    }
  });

  // 3. Flip boolean literals
  if (source.includes("return true")) {
    const mutated = source.replace(/\breturn true\b/g, "return false");
    if (mutated !== source) {
      results.push({
        mutation: { description: "return true → return false" },
        mutated,
      });
    }
  }
  if (source.includes("return false")) {
    const mutated = source.replace(/\breturn false\b/g, "return true");
    if (mutated !== source) {
      results.push({
        mutation: { description: "return false → return true" },
        mutated,
      });
    }
  }

  // 4. Neutralise null / undefined guards (first 3 if statements)
  //
  // This forces the guard's condition to `false` so the guard never fires, rather than deleting
  // the line. Deleting was the original approach and it removed the `{` along with the `if` when
  // the guard opened a block, orphaning the matching `}` -- a syntax error, so the mutant never
  // loaded. Rewriting the condition leaves the block structure exactly as it was.
  let guardCount = 0;
  lines.forEach((line, i) => {
    if (guardCount >= 3) return;
    if (inTemplateLiteral.has(i)) return;
    if (!/\bif\s*\(/.test(line)) return;
    // Only genuine nullish guards. A bare `x === null` in an assignment is not a guard, and an
    // `if` on the same line as one should not be rewritten on that evidence.
    if (!/if\s*\(\s*!|===\s*null|===\s*undefined|!==\s*null|!==\s*undefined/.test(line)) return;
    const mutatedLine = rewriteIfCondition(line, () => "false");
    if (!mutatedLine || mutatedLine === line) return;
    guardCount++;
    const mutated = lines.map((l, j) => (j === i ? mutatedLine : l)).join("\n");
    if (mutated !== source) {
      results.push({
        mutation: { description: `line ${i + 1}: guard removed` },
        mutated,
      });
    }
  });

  // 5. Negate a conditional throw (first occurrence)
  //
  // Use findIndex's real index, not `lines.indexOf(l)`: identical repeated lines (`  }`, a blank, a
  // repeated guard) resolve to the first match, so the lookahead would inspect the wrong neighbour.
  const throwGuardIdx = lines.findIndex((l, i) =>
    !inTemplateLiteral.has(i) && /\bif\s*\(/.test(l) && lines[i + 1]?.includes("throw")
  );
  if (throwGuardIdx >= 0) {
    const negated = rewriteIfCondition(lines[throwGuardIdx], cond =>
      // Negate the condition: if (!x) → if (x), if (x) → if (!(x))
      /^\s*!/.test(cond) ? cond.replace(/^(\s*)!/, "$1") : `!(${cond})`
    );
    if (negated) {
      const mutated = lines.map((l, i) => (i === throwGuardIdx ? negated : l)).join("\n");
      if (mutated !== source) {
        results.push({
          mutation: { description: `line ${throwGuardIdx + 1}: throw guard negated` },
          mutated,
        });
      }
    }
  }

  // Final gate: a mutant that does not parse cannot load, and one that cannot load is not a
  // probe. Drop them here rather than spending a test run discovering it.
  return results.filter(r => parses(r.mutated));
}

// Control-flow keywords structurally match `name(...) {` the same as a function
// declaration would (`if (x) {`, `while (x) {`) -- exclude them so an `if` block
// doesn't get misreported as the enclosing function.
const JS_CONTROL_KEYWORDS = new Set(["if", "while", "for", "switch", "catch", "do", "with"]);

// Scan backwards from a line to find the name of the enclosing function/method.
function detectEnclosingFunction(lines: string[], fromLine: number): string | undefined {
  const fnPattern = /(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?::\s*(?:async\s+)?function|\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))|\b(\w+)\s*\([^)]*\)\s*\{)/;
  for (let i = fromLine; i >= 0; i--) {
    const m = lines[i].match(fnPattern);
    if (!m) continue;
    const name = (m[1] ?? m[2] ?? m[3])?.trim();
    if (name && !JS_CONTROL_KEYWORDS.has(name)) return name;
  }
  return undefined;
}

// ── Runner ────────────────────────────────────────────────────────────

/** What happened when the claims were run against one mutant.
 *
 *  `errored` is the load-bearing one. A mutant that never ran produces the same zero passing
 *  tests as a mutant every claim caught, and treating those as one outcome means an unloadable
 *  mutant is scored as a success. That is the worst possible direction for the error to run: the
 *  tool reports strong claims exactly where it has learned nothing. */
export type MutationOutcome = "killed" | "survived" | "errored";

export interface MutationResult {
  description: string;
  outcome: MutationOutcome;
  /** The actual source line that was mutated -- gives context for what behavior is uncovered. */
  sourceLine?: string;
  /** The name of the function/method containing the mutated line. */
  functionName?: string;
  /** Descriptions of tests that still passed with this mutation applied -- the weak claims. */
  uncoveredBy: string[];
}

/** Counts by outcome, plus the survivors themselves for the "add a perspective to..." hint.
 *
 *  Both reporting sites -- the inline pass in `run` and the standalone `mutate` command -- need the
 *  same split and format it differently. Deriving the counts in each place is how the two drift:
 *  one of them starts treating errored as caught again and the number silently lies. The tally is
 *  computed once here; only the presentation is duplicated, and that part is meant to differ. */
export function summarizeMutations(results: MutationResult[]) {
  const survived = results.filter(r => r.outcome === "survived");
  const errored  = results.filter(r => r.outcome === "errored");
  return {
    survived,
    errored,
    killed: results.length - survived.length - errored.length,
    total: results.length,
    /** Every mutant ran and every one was caught. An errored mutant is not evidence of anything,
     *  so it must not earn the green tick. */
    clean: survived.length === 0 && errored.length === 0,
  };
}

/** A mutant has to be able to `import` whatever the original imported, so it is written beside
 *  the original rather than into the OS temp directory.
 *
 *  Writing to tmpdir was the original approach and it silently broke every module with a runtime
 *  relative import: `./helper.ts` does not resolve from /tmp, so the mutant failed to load, the
 *  run produced no passing tests, and the mutation was scored as caught. Every mutant. The bug
 *  was invisible to this project's own suite because the modules it mutates import only Node
 *  builtins and type-only siblings, which are erased before runtime.
 *
 *  The name is dotted and prefixed so a leaked file after a hard kill is recognisable and is
 *  covered by .gitignore. */
function mutantPathFor(implementationPath: string): string {
  return join(
    dirname(implementationPath),
    `.lldtdd-mut-${randomUUID()}${extname(implementationPath)}`
  );
}

/** How many mutants are probed at once.
 *
 *  Each probe is a `bun test` subprocess, so the pass is bound by process throughput rather than
 *  by anything in this file -- measured on this repo, the two slowest documents spent 65s and 107s
 *  almost entirely waiting on sequential suite runs. Bailing early would only help mutants that
 *  get killed, and most mutants survive (11 of 14 on the slowest document), so a survivor runs the
 *  whole suite no matter what. Overlapping the waiting is the win that applies to every outcome.
 *
 *  Half the cores, not all of them, because each probe is a `bun test` process that is itself
 *  multi-threaded -- and a suite may spawn further processes, since lldtdd's own documents run
 *  lldtdd. Measured on this repo's slowest document (4 cores, 14 mutants): 93s sequential, 72s at
 *  two probes, 95s at three. Oversubscription is not free; past the sweet spot the probes contend
 *  and it gets slower than running them one at a time.
 *
 *  `LLDTDD_MUTATION_CONCURRENCY=1` restores the sequential pass. */
const MUTATION_CONCURRENCY = (() => {
  const override = Number(process.env.LLDTDD_MUTATION_CONCURRENCY);
  if (Number.isInteger(override) && override >= 1) return override;
  const cores = availableParallelism?.() ?? 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
})();

export async function runMutations(
  implementationPath: string,
  testRunner: (path: string) => Promise<RunResult>
): Promise<MutationResult[]> {
  if (!existsSync(implementationPath)) return [];

  const source = await readFile(implementationPath, "utf-8");
  const mutations = buildMutations(source);
  const sourceLines = source.split("\n");

  /** Probes one mutant. Independent of every other mutant: its own file, its own subprocess. */
  const probe = async ({ mutation, mutated }: typeof mutations[number]): Promise<MutationResult> => {
    const lineMatch = mutation.description.match(/^line (\d+):/);
    const lineIdx = lineMatch ? parseInt(lineMatch[1]) - 1 : -1;
    const sourceLine = lineIdx >= 0 ? sourceLines[lineIdx]?.trim() : undefined;
    const functionName = lineIdx >= 0 ? detectEnclosingFunction(sourceLines, lineIdx) : undefined;

    // A fresh path per mutant means Bun's cross-process transpilation cache has no prior entry,
    // so the subprocess always compiles and runs the mutated content. It also makes concurrent
    // probes independent -- no two mutants ever contend for the same file.
    const mutantPath = mutantPathFor(implementationPath);
    trackTempFile(mutantPath);
    await writeFile(mutantPath, mutated);

    let outcome: MutationOutcome;
    let uncoveredBy: string[] = [];
    try {
      const result = await testRunner(mutantPath);

      if (result.crashed || (result.passed === 0 && result.failed === 0)) {
        // The mutant never ran. We have learned nothing about the claims, and saying otherwise
        // in either direction would be a guess.
        outcome = "errored";
      } else if (result.failed === 0) {
        outcome = "survived";
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
      } else {
        outcome = "killed";
      }
    } catch {
      // The runner itself threw -- same epistemic position as a crashed mutant.
      outcome = "errored";
    } finally {
      await unlink(mutantPath).catch(() => {});
      untrackTempFile(mutantPath);
    }

    return { description: mutation.description, outcome, sourceLine, functionName, uncoveredBy };
  };

  // Written by index rather than pushed, so the reported order stays source order regardless of
  // which probe finishes first. Callers key advisory output off this order.
  const results: MutationResult[] = new Array(mutations.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < mutations.length; i = next++) {
      results[i] = await probe(mutations[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MUTATION_CONCURRENCY, mutations.length) }, worker)
  );

  return results;
}
