import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runAndCheck, runContentAndCheck, DEFAULT_GLOB_IGNORE } from "./run.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

/**
 * `run` is the contract everything else is wired into: what exits zero, what does not, and what
 * is reported without changing the answer. `lld/run.lld.md` states the same contract as claims and
 * checks it through the tool itself; these cover it from the other side, and cover the parts a
 * document cannot easily reach -- the default glob's exclusions, and the in-memory entry point.
 *
 * Everything here runs in a temp directory, so no fixture on disk can drift out from under it.
 */

const SUBJECT = "export function double(n: number): number {\n  return n * 2;\n}\n";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-run-"));
  await writeFile(join(dir, "subject.ts"), SUBJECT);
  return dir;
}

const doc = (claim: string) =>
  `# S\n> subject.ts\n\n## Doubling\n**method:** \`double\`\n\n- ${claim}\n`;

describe("exit code", () => {
  it("exits zero when every verified claim holds", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.exitCode).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.passed).toBeGreaterThan(0);
  });

  it("exits non-zero when a claim comes out false", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 5"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.exitCode).toBe(1);
    expect(r.failed).toBe(1);
  });

  it("exits zero for an all-pending document", async () => {
    // Pending is the correct starting state for a document written before its code, so it must
    // not fail a build. This is the case a coverage tool would get wrong.
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"),
      "# S\n> subject.ts\n\n## Doubling\n\n- doubling is stable under repetition\n");
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.exitCode).toBe(0);
    expect(r.pending).toBeGreaterThan(0);
  });

  it("exits zero when the module does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-run-"));
    await writeFile(join(dir, "s.lld.md"),
      "# S\n> not-written-yet.ts\n\n## G\n**method:** `f`\n\n- f(1) → 2\n");
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.exitCode).toBe(0);
  });
});

describe("compound captured assertion", () => {
  // Regression: `r.kind === "pos" && r.value === 5` must be asserted as the whole expression --
  // expect(r.kind === "pos" && r.value === 5).toBe(true) -- not split on the first `===` into
  // expect(r.kind).toBe("pos" && r.value === 5), which lands the `&&` inside toBe and silently
  // asserts the wrong thing. Here the split form would compare "pos" to a boolean and fail, so a
  // green run is proof the whole expression was asserted.
  it("asserts a `&&` outcome whole, not split on the first ===", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-cmp-"));
    await writeFile(join(dir, "subject.ts"),
      "export function classify(n: number) { return { kind: n > 0 ? \"pos\" : \"neg\", value: n }; }\n");
    await writeFile(join(dir, "s.lld.md"),
      "# S\n> subject.ts\n\n## C\n**method:** `classify`\n\n- classify(5) captures r -> r.kind === \"pos\" && r.value === 5\n");
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(1);
  });
});

describe("mock-http descriptor", () => {
  // A plain mock-http value is a 200 success body. A descriptor ({ status, contentType, body })
  // reaches paths a fixed-success stub cannot -- an error result, a non-JSON body -- so a claim about
  // failure handling can actually run. Without the descriptor being honored, `res.ok` here is `true`
  // and the claim goes the other way.
  it("models a failing response so an error-path claim can be checked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-mock-"));
    await writeFile(join(dir, "subject.ts"),
      "export async function getStatus(url: string) { const r = await fetch(url); return { ok: r.ok, status: r.status }; }\n");
    await writeFile(join(dir, "s.lld.md"),
      "# S\n> subject.ts\n\n## Failure\n**method:** `getStatus`\n**mock-http:** `{ \"status\": 503, \"body\": {} }`\n\n- getStatus(\"http://x\") captures r -> r.status === 503\n");
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(1);
  });
});

describe("shallow (no-throw-only greens)", () => {
  it("counts a `-> resolves` claim as shallow, not passed", async () => {
    // The call runs and doesn't throw, so it is green -- but nothing about what `double` returned was
    // checked. It would stay green against a `double` that returned anything at all, so it is not the
    // same evidence as `double(2) → 4`, and the count keeps them apart.
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → resolves"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.exitCode).toBe(0);
    expect(r.shallow).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("counts a claim that pins a value as passed, not shallow", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(r.passed).toBe(1);
    expect(r.shallow).toBe(0);
  });

  it("--fail-on-weak makes a shallow-only document exit non-zero", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → resolves"));
    const strict = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false, failOnWeak: true });
    expect(strict.exitCode).toBe(1);
    const lenient = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false });
    expect(lenient.exitCode).toBe(0);
  });

  it("--fail-on-weak leaves a document with no shallow greens exiting zero", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: false, failOnWeak: true });
    expect(r.exitCode).toBe(0);
  });
});

describe("mutation reporting does not change the exit code", () => {
  it("reports a surviving mutation while still exiting zero", async () => {
    const dir = await workspace();
    // `halve` is described by nothing, so mutating it survives.
    await writeFile(join(dir, "subject.ts"),
      SUBJECT + "\nexport function halve(n: number): number {\n  return n / 2;\n}\n");
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: true });
    expect(r.survivingMutations).toBeGreaterThan(0);
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it("counts no errored mutants for a module that loads cleanly", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));
    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: true });
    expect(r.erroredMutations).toBe(0);
  }, 60_000);

  it("mutants resolve relative imports from the project tree", async () => {
    // End to end, through the real runner rather than a stub. A mutant written to the OS temp
    // directory cannot resolve `./limits.ts`: every mutant fails to load, produces zero passing
    // tests, and is scored as caught, so a module like this one reports perfect mutation
    // coverage while nothing has been probed at all. A stubbed runner cannot catch that; the
    // resolution failure only happens when a real subprocess tries to import the file from
    // wherever it was written. `SUBJECT` elsewhere in this file imports nothing, so this is the
    // one fixture that exercises the resolution path.
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-run-"));
    await writeFile(join(dir, "limits.ts"), "export const FACTOR = 2;\n");
    await writeFile(join(dir, "subject.ts"),
      'import { FACTOR } from "./limits.ts";\n\n' +
      "export function double(n: number): number {\n  return n * FACTOR;\n}\n\n" +
      "export function halve(n: number): number {\n  return n / FACTOR;\n}\n");
    await writeFile(join(dir, "s.lld.md"), doc("double(2) → 4"));

    const r = await runAndCheck("s.lld.md", dir, { silent: true, mutate: true });

    expect(r.exitCode).toBe(0);
    expect(r.erroredMutations).toBe(0);          // every mutant actually loaded and ran
    expect(r.survivingMutations).toBeGreaterThan(0); // `halve` is described by nothing
  }, 60_000);

  it("honours a document-level `**mutate:** false`", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "subject.ts"),
      SUBJECT + "\nexport function halve(n: number): number {\n  return n / 2;\n}\n");
    await writeFile(join(dir, "s.lld.md"),
      `# S\n> subject.ts\n\n**mutate:** false\n\n## Doubling\n**method:** \`double\`\n\n- double(2) → 4\n`);
    const r = await runAndCheck("s.lld.md", dir, { silent: true });
    // The same document without the annotation reports a survivor (see above).
    expect(r.survivingMutations).toBe(0);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

describe("default glob", () => {
  it("excludes node_modules and fixtures directories", () => {
    expect(DEFAULT_GLOB_IGNORE).toContain("node_modules/**");
    expect(DEFAULT_GLOB_IGNORE).toContain("**/fixtures/**");
  });

  it("skips a failing document under fixtures/ but runs one beside it", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "fixtures"), { recursive: true });
    await writeFile(join(dir, "fixtures", "subject.ts"), SUBJECT);
    // Deliberately false. If the glob picked this up, the whole run would fail.
    await writeFile(join(dir, "fixtures", "broken.lld.md"), doc("double(2) → 5"));
    await writeFile(join(dir, "ok.lld.md"), doc("double(2) → 4"));

    const swept = await runAndCheck(undefined, dir, { silent: true, mutate: false });
    expect(swept.exitCode).toBe(0);
    expect(swept.failed).toBe(0);

    // ...but naming it explicitly still runs it. The exclusion is about the sweep, not the file.
    const named = await runAndCheck("fixtures/broken.lld.md", dir, { silent: true, mutate: false });
    expect(named.exitCode).toBe(1);
  }, 60_000);
});

/**
 * The self-database family gates on structure -- a module with an `init`, a `write()`, and a `db`,
 * and no imported database -- but its individual patterns used to require the *identifier names* of
 * the one real module they were written against: a queue property literally called `_writeQueue`,
 * and a literal `db.data` access path. A module with the same architecture under different names
 * derived one test of four; renaming its queue to `_writeQueue` took it to four of four, which is a
 * name check wearing a structural gate's clothes.
 *
 * `lld/fixtures/selfdb.ts` is deliberately not that module: its own collection, its own field
 * names, its own queue property, an in-memory store instead of a file. If a pattern regains a
 * dependency on someone's naming, this drops back toward one.
 */
describe("self-database family generalizes past one module's naming", () => {
  it("derives and passes every claim against a module that shares only the structure", async () => {
    const r = await runAndCheck("lld/fixtures/selfdb.lld.md", process.cwd(), { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(0); // nothing pending -- every claim in the fixture resolved
    expect(r.passed).toBe(3);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

describe("runContentAndCheck", () => {
  it("runs a document held in memory, with no .lld.md on disk", async () => {
    const dir = await workspace();
    const r = await runContentAndCheck(doc("double(2) → 4"), dir, { silent: true });
    expect(r.exitCode).toBe(0);
    expect(r.passed).toBeGreaterThan(0);
  });

  it("skips mutation for an in-memory document", async () => {
    // Mutation needs a source document on disk to attribute survivors back to; an in-memory run
    // has no such file, so the pass is skipped rather than half-reported.
    const dir = await workspace();
    const r = await runContentAndCheck(doc("double(2) → 4"), dir, { silent: true, mutate: true });
    expect(r.survivingMutations).toBe(0);
  });

  /**
   * Every document in this repo is written with the ASCII `->`, and every test here was written
   * with the unicode `→`. Normalization lived in `parseFile`, so content handed straight to the
   * parser kept its ASCII arrows, matched no outcome pattern, and demoted every claim to a bare
   * invariant: all pending, exit 0, on a document whose claims were in fact false. The tests
   * agreed because they were the only documents in the project not written the shipped way.
   */
  it("reads the ASCII arrow, which is how every shipped document is written", async () => {
    const dir = await workspace();
    const r = await runContentAndCheck(doc("double(2) -> 4"), dir, { silent: true });
    expect(r.passed).toBeGreaterThan(0);
    expect(r.pending).toBe(0);
  });

  it("derives the same suite from either arrow, including when the claim is false", async () => {
    const dir = await workspace();
    const ascii = await runContentAndCheck(doc("double(2) -> 5"), dir, { silent: true });
    const unicode = await runContentAndCheck(doc("double(2) → 5"), dir, { silent: true });
    expect(ascii.failed).toBe(1);
    expect({ passed: ascii.passed, failed: ascii.failed, pending: ascii.pending })
      .toEqual({ passed: unicode.passed, failed: unicode.failed, pending: unicode.pending });
  });
});

/**
 * Both of these used to be indistinguishable from success or from a crash.
 *
 * A named path that did not exist reached `parseFile` and surfaced as a raw ENOENT stack trace,
 * which names this tool's internals to someone who mistyped a filename. An empty glob printed
 * nothing at all and exited 0, which is what a clean run also looks like.
 */
/**
 * A claim can be verified two ways, and the difference is worth reporting.
 *
 * A bare prose parent with a concrete perspective under it has no test of its own -- every check
 * belongs to the perspective. That is a legitimate verification, because the perspective is the
 * author's own operationalization of the claim, so it is a success and must not change the exit
 * code. But it is weaker evidence than a test of the claim itself, and folding it into `passed`
 * let this project's own suite report "112 passed, 0 pending" while 25 of those claims had nothing
 * of their own behind them. `indirect` keeps the two distinguishable.
 */
describe("perspective-verified claims", () => {
  const parentWithPerspective =
    "# S\n> subject.ts\n\n## Doubling\n**method:** `double`\n\n" +
    "- doubling is a pure arithmetic transform, not a mutation\n" +
    "  - double(2) → 4\n";

  it("counts a parent with no direct test as indirect, not passed", async () => {
    const dir = await workspace();
    const r = await runContentAndCheck(parentWithPerspective, dir, { silent: true });
    expect(r.indirect).toBe(1);   // the prose parent
    expect(r.passed).toBe(1);     // the perspective's own test
    expect(r.pending).toBe(0);
  });

  it("treats indirect as success, not as a failure or a pending", async () => {
    const dir = await workspace();
    const r = await runContentAndCheck(parentWithPerspective, dir, { silent: true });
    expect(r.exitCode).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("does not count a claim with its own test as indirect", async () => {
    const dir = await workspace();
    const r = await runContentAndCheck(doc("double(2) → 4"), dir, { silent: true });
    expect(r.indirect).toBe(0);
    expect(r.passed).toBeGreaterThan(0);
  });

  it("fails the parent when a perspective fails, rather than reporting it indirect", async () => {
    const dir = await workspace();
    const wrong =
      "# S\n> subject.ts\n\n## Doubling\n**method:** `double`\n\n" +
      "- doubling is a pure arithmetic transform\n" +
      "  - double(2) → 5\n";
    const r = await runContentAndCheck(wrong, dir, { silent: true });
    expect(r.exitCode).toBe(1);
    expect(r.indirect).toBe(0);
  });
});

/**
 * The pending list has to say when the machine owns a pending, and degraded extraction is the
 * machine's: a stage ts-morph gave up on fell back to empty facts, so a claim that might have
 * derived reads exactly like one nothing could ever derive. The subject below is the proven
 * trigger from src/ast.test.ts's "degraded extraction" -- nesting deep enough to overflow the
 * TypeScript parser's recursion, plus a format token so the text-transformer stage reaches its
 * ts-morph call instead of gating out.
 */
describe("degraded extraction is named in the pending list", () => {
  const DEPTH = 30_000;
  const UNPARSEABLE =
    'export const parse = (s: string) => s.startsWith("# ");\n' +
    "const deep = " + "(".repeat(DEPTH) + "0" + ")".repeat(DEPTH) + ";\n";

  it("prints the degraded module and stages, and still processes the claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-degraded-"));
    await writeFile(join(dir, "subject.ts"), UNPARSEABLE);
    await writeFile(join(dir, "s.lld.md"),
      "# S\n> subject.ts\n\n## Quality\n\n- the implementation is tasteful and well factored\n");

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const r = await runAndCheck("s.lld.md", dir, { mutate: false })
      .finally(() => { console.log = orig; });

    // Degradation is reported, not fatal: the claim still lands as an honest pending, exit 0.
    expect(r.exitCode).toBe(0);
    expect(r.pending).toBeGreaterThan(0);
    const out = lines.join("\n");
    expect(out).toContain("extraction degraded in subject.ts");
    expect(out).toContain("functionTypeChains");
  }, 60_000);
});

describe("nothing to run", () => {
  it("names a document that does not exist instead of throwing ENOENT", async () => {
    const dir = await workspace();
    expect(runAndCheck("nope.lld.md", dir, { silent: true }))
      .rejects.toThrow("no such document: nope.lld.md");
  });

  it("reports an empty match rather than exiting zero in silence", async () => {
    // An empty glob is not a failure -- a repo may have no documents yet -- but it has to be
    // distinguishable from a run where everything passed.
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-empty-"));
    const r = await runAndCheck(undefined, dir, { silent: true });
    expect(r).toMatchObject({ exitCode: 0, passed: 0, failed: 0, pending: 0 });
  });
});
