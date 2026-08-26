import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildMutations, runMutations, summarizeMutations } from "./mutate.ts";
import { translate } from "./translator/index.ts";
import { synthesize } from "./synthesis/index.ts";
import { runSuite } from "./bunRunner.ts";
import { parseFile } from "./parser.ts";
import type { RunResult } from "./types.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

/**
 * These tests exist because of a specific bug, and the shape of the bug is worth stating: every
 * mutant of a module with a runtime relative import was reported as killed.
 *
 * Two causes compounded. Mutants were written to the OS temp directory, where `./helper.ts` does
 * not resolve, so the mutant never loaded; and a run that never loaded produced zero passing
 * tests, which the runner could not tell apart from a run where the claims caught the mutant. The
 * failure mode pointed the wrong way -- the tool reported the strongest possible result exactly
 * where it had learned nothing.
 *
 * Nothing in the existing suite could have caught it. The modules this project mutates import
 * only Node builtins and type-only siblings, both of which are erased before runtime, so the
 * dogfooding was structurally blind to the case that describes most real code.
 */

const runResult = (over: Partial<RunResult> = {}): RunResult => ({
  suiteName: "s", modulePath: "m", passed: 0, failed: 0, pending: 0, indirect: 0, shallow: 0, cases: [], duration: 1, ...over,
});

async function moduleWithRelativeImport(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-mut-"));
  await writeFile(join(dir, "helper.ts"), "export const LIMIT = 3;\n");
  const mod = join(dir, "subject.ts");
  await writeFile(mod,
    'import { LIMIT } from "./helper.ts";\n\n' +
    "export function check(n: number): boolean {\n" +
    "  if (n === LIMIT) return true;\n" +
    "  return false;\n" +
    "}\n");
  return mod;
}

describe("runMutations -- outcome classification", () => {
  it("does not report a mutant that never loaded as killed", async () => {
    const mod = await moduleWithRelativeImport();
    const results = await runMutations(mod, async () => runResult({ failed: 3, crashed: true }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.outcome === "errored")).toBe(true);
    // The precise regression: `crashed` presents as failed > 0, which reads as a kill unless the
    // flag is consulted first.
    expect(results.some(r => r.outcome === "killed")).toBe(false);
  });

  it("treats a run where no test executed as errored, not as a kill", async () => {
    const mod = await moduleWithRelativeImport();
    const results = await runMutations(mod, async () => runResult());
    expect(results.every(r => r.outcome === "errored")).toBe(true);
  });

  it("reports a mutant no claim noticed as survived", async () => {
    const mod = await moduleWithRelativeImport();
    const results = await runMutations(mod, async () => runResult({ passed: 2 }));
    expect(results.every(r => r.outcome === "survived")).toBe(true);
  });

  it("reports a mutant some claim caught as killed", async () => {
    const mod = await moduleWithRelativeImport();
    const results = await runMutations(mod, async () => runResult({ passed: 1, failed: 1 }));
    expect(results.every(r => r.outcome === "killed")).toBe(true);
  });

  it("writes each mutant beside the original so relative imports resolve", async () => {
    const mod = await moduleWithRelativeImport();
    const dir = join(mod, "..");
    let sawMutantInSourceDir = false;

    await runMutations(mod, async path => {
      // The mutant must sit in the module's own directory. In the OS temp directory its
      // `./helper.ts` import has nothing to resolve against and it cannot load at all.
      if (path.startsWith(dir)) sawMutantInSourceDir = true;
      return runResult({ passed: 1, failed: 1 });
    });

    expect(sawMutantInSourceDir).toBe(true);
    // ...and every one is cleaned up again, leaving only the two files we created.
    expect((await readdir(dir)).sort()).toEqual(["helper.ts", "subject.ts"]);
  });

  it("returns nothing for a module that does not exist", async () => {
    expect(await runMutations("/nonexistent/module.ts", async () => runResult())).toEqual([]);
  });

  /**
   * The mutant sits in the user's own source directory, so anything that strands one leaves a
   * mutated copy of their code behind. The per-mutant `finally` covers a throwing runner but not
   * a signal, and Ctrl-C during the mutation pass is the ordinary way a user ends a slow run --
   * two orphans from an interrupted run were found in this repo's src/, and both shipped inside a
   * real `bun pm pack` tarball, because .gitignore does not reach an npm `files` allowlist.
   *
   * Run out-of-process because that is the only place a signal means anything. The runner never
   * resolves, which parks the pass with a mutant on disk -- exactly the window `finally` misses.
   */
  it("removes the mutant when the process is interrupted mid-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-sig-"));
    const mod = join(dir, "subject.ts");
    await writeFile(mod, "export const eq = (a: number, b: number) => a === b;\n");

    const driver = join(dir, "driver.ts");
    await writeFile(driver, [
      `import { runMutations } from ${JSON.stringify(new URL("./mutate.ts", import.meta.url).pathname)};`,
      `await runMutations(${JSON.stringify(mod)}, () => new Promise(() => {}));`,
    ].join("\n"));

    const orphans = async () => (await readdir(dir)).filter(f => f.startsWith(".lldtdd-mut-"));
    const proc = Bun.spawn(["bun", "run", driver], { stdout: "ignore", stderr: "ignore" });

    for (let i = 0; i < 200 && (await orphans()).length === 0; i++) await Bun.sleep(25);
    // Assert the window actually opened, so a setup that never wrote a mutant cannot pass by
    // finding nothing to clean up.
    expect((await orphans()).length).toBe(1);

    proc.kill("SIGINT");
    await proc.exited;

    expect(await orphans()).toEqual([]);
  }, 20000);
});

describe("buildMutations -- every mutant must parse", () => {
  // A mutant that does not parse cannot load, and before the outcome split it was scored as a
  // kill. Two operators were generating invalid code; these pin the shapes that broke them.

  it("keeps the block intact when neutralising a guard that opens one", () => {
    // Deleting the `if` line took the `{` with it and orphaned the closing brace.
    const source = [
      "export function f(x: string | null) {",
      "  if (!x) {",
      "    return 0;",
      "  }",
      "  return x.length;",
      "}",
    ].join("\n");
    const guard = buildMutations(source).filter(m => /guard removed/.test(m.mutation.description));
    expect(guard.length).toBeGreaterThan(0);
    for (const m of guard) expect(m.mutated).toContain("}");
  });

  it("does not mutate a return statement that continues onto the next line", () => {
    // `return {` has no semicolon, so rewriting the line to `return null` orphaned the object
    // body underneath it.
    const source = [
      "export function f() {",
      "  return {",
      "    a: 1,",
      "  };",
      "}",
    ].join("\n");
    expect(buildMutations(source).filter(m => /return value/.test(m.mutation.description))).toEqual([]);
  });

  it("negates a throw guard whose condition contains nested parens", () => {
    // The old `[^)]+` match stopped at the inner paren and produced `if (!(isBad(x))`.
    const source = [
      "export function f(x: string) {",
      "  if (isBad(x)) {",
      "    throw new Error('bad');",
      "  }",
      "  return x;",
      "}",
      "function isBad(s: string) { return s === ''; }",
    ].join("\n");
    const negated = buildMutations(source).find(m => /throw guard negated/.test(m.mutation.description));
    expect(negated).toBeDefined();
    expect(negated!.mutated).toContain("if (!(isBad(x)))");
  });

  it("emits only mutants that parse, across every operator", () => {
    // The backstop. Operators are written not to emit broken code; this is what keeps a future
    // operator's edge case from silently becoming a false green again.
    const source = [
      "export function f(a: number | null, b: string) {",
      "  if (a === null) { return 'none'; }",
      "  if (!b) {",
      "    throw new Error('empty');",
      "  }",
      "  if (a === 0) return true;",
      "  const shape = {",
      "    a,",
      "    b,",
      "  };",
      "  return shape;",
      "}",
    ].join("\n");
    const mutations = buildMutations(source);
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(m.mutated)).not.toThrow();
    }
  });

  it("produces no mutations for source with no mutable patterns", () => {
    expect(buildMutations("export const x = 1;\n")).toEqual([]);
  });
});

/**
 * Every outcome above is classified against a stubbed runner, and run.test.ts covers `survived`
 * and `errored` end to end. `killed` had neither: nothing anywhere asserted that a real mutant,
 * written to disk and executed by the real runner, is actually caught by real claims.
 *
 * That is the outcome the tool reports as good news, so it is the one worth proving. A bug that
 * scored every mutant `killed` is exactly the bug this file was opened for, and a stub cannot
 * distinguish "the claims caught it" from "the classifier said so".
 */
describe("runMutations -- a real mutant, killed by a real claim", () => {
  it("kills every mutant of a function the document fully describes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-killed-"));
    const modulePath = join(dir, "subject.ts");
    await writeFile(modulePath, "export function double(n: number): number {\n  return n * 2;\n}\n");
    const docPath = join(dir, "s.lld.md");
    await writeFile(docPath,
      "# S\n> ./subject.ts\n\n## Doubling\n**method:** `double`\n\n" +
      "- double(2) -> 4\n- double(3) -> 6\n- double(0) -> 0\n");

    const suite = await synthesize(await translate(await parseFile(docPath, dir), { execute: true }));
    const results = await runMutations(modulePath, mutatedPath =>
      runSuite({ ...suite, modulePath: mutatedPath, substitutedFor: suite.modulePath }));
    const summary = summarizeMutations(results);

    expect(summary.total).toBeGreaterThan(0);   // mutants were actually generated
    expect(summary.errored.length).toBe(0);     // every one of them loaded and ran
    expect(summary.survived.length).toBe(0);    // and the claims caught all of them
    expect(summary.killed).toBe(summary.total);
    expect(summary.clean).toBe(true);
  }, 120_000);
});
