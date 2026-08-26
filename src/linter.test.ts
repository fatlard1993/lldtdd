import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { lintFile } from "./linter.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

const REPO_ROOT = new URL("..", import.meta.url).pathname;

async function lintContent(content: string): Promise<Awaited<ReturnType<typeof lintFile>>> {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-lint-"));
  const file = join(dir, "doc.lld.md");
  await writeFile(file, content);
  return lintFile(file);
}

/**
 * The linter touches a document without loading its module, which makes it the cheapest thing in
 * the pipeline to test directly. These cover the two ends: a real document that must stay clean,
 * and a deliberately malformed one that must not.
 *
 * That first sentence used to be aspiration rather than fact -- the linter resolved exports by
 * importing the module, so `lint` ran the subject's top-level code and called its zero-arg exports
 * in this process. "Executes on lint" is a property nobody reads a linter expecting, and the
 * pre-commit hook made `git commit` enough to trigger it. The execution tests below pin the
 * boundary in both directions, because a fence nobody tests is a fence that quietly reopens.
 */
describe("lintFile", () => {
  it("reports zero errors for a well-formed document", async () => {
    const result = await lintFile(resolve(REPO_ROOT, "examples/eventBus.lld.md"));
    expect(result.errors).toBe(0);
  });

  it("reports errors for a document missing its title and module pointer", async () => {
    // lld/fixtures/missing-structure.lld.md is checked in specifically to be broken. It lives
    // under lld/fixtures/ rather than lld/ so the single-level glob in .githooks/pre-commit and
    // CI ("{lld,examples}/*.lld.md") does not pick it up and fail every commit.
    const result = await lintFile(resolve(REPO_ROOT, "lld/fixtures/missing-structure.lld.md"));
    expect(result.errors).toBeGreaterThan(0);
  });

  it("flags a missing module pointer specifically", async () => {
    const result = await lintContent("# A Title\n\n## A group\n\n- a claim about something\n");
    expect(result.errors).toBeGreaterThan(0);
    expect(result.issues.some(i => /module/i.test(i.message))).toBe(true);
  });

  it("errors when the module pointer resolves to nothing", async () => {
    // Documents the current behavior, which is in tension with the write-the-document-first
    // workflow the README describes: `run` reports an unwritten module as pending, but `lint`
    // calls the same state an error and exits non-zero. Defensible as typo-catching, and left
    // as-is deliberately -- if this is ever softened to a warning, this test is where to say so.
    const result = await lintContent("# A Title\n> src/not-written-yet.ts\n\n## A group\n\n- a claim\n");
    expect(result.errors).toBe(1);
    expect(result.issues[0].message).toMatch(/module not found/i);
  });
});

/**
 * Two opposite outcomes for the same candidate set -- claims with nothing concrete in them, no
 * outcome arrow, no inline call, no perspective.
 *
 * If nothing derives such a claim it can only ever be pending, and the linter has always said so.
 * If something *does* derive it, the anchor is the sentence itself: a pattern recognised that
 * wording. Reword it and the test vanishes back to pending while the document still reads as
 * verified. That is the inverse of a false pass, and it went unreported until the families whose
 * branches read zero capture groups made it worth naming.
 */
describe("lintFile -- how a bare claim is anchored", () => {
  const withModule = async (source: string, claims: string) => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-anchor-"));
    await writeFile(join(dir, "subject.ts"), source);
    const file = join(dir, "doc.lld.md");
    await writeFile(file, `# S\n> ./subject.ts\n\n## G\n\n${claims}`);
    return lintFile(file);
  };

  const PLAIN = "export function run(n: number): number { return n * 2; }\n";

  // A component class. Its patterns read their capture groups, so a bare claim here survives being
  // reworded within the vocabulary -- "disabled" or "readonly", same derivation.
  const COMPONENT = [
    "export default class Widget extends HTMLElement {",
    "  elem?: HTMLElement;",
    "  constructor(options: Record<string, unknown> = {}) { super(); this.options = options; }",
    "  options: Record<string, unknown>;",
    "}",
  ].join("\n");

  // A reactive context. Its patterns match near-whole sentences and read nothing out of them, so a
  // bare claim here is anchored to that exact wording and nothing else.
  const REACTIVE = [
    "export default class Ctx extends EventTarget {",
    "  subscribe(opts: { key: string; callback: (v: unknown) => void }) { return () => {}; }",
    "  batch(fn: () => void) { fn(); }",
    "  destroy() {}",
    "  get isDestroyed() { return false; }",
    "}",
  ].join("\n");

  it("warns when the pattern that claimed it reads nothing out of it", async () => {
    const r = await withModule(REACTIVE, "- does a subscriber fire before the next line of code executes\n");
    const messages = r.issues.map(i => i.message).join("\n");
    expect(messages).toContain("only from its wording");
    expect(messages).not.toContain("can only ever be pending");
  });

  it("stays quiet when the pattern reads its own match", async () => {
    // `the (\w+) attribute is set on the element` captures the option name and builds around it, so
    // rewording within the vocabulary keeps deriving. Warning here would be a false alarm, and a
    // warning nobody can act on is one people learn to ignore.
    const r = await withModule(COMPONENT, "- the disabled attribute is set on the element\n");
    expect(r.issues.map(i => i.message).join("\n")).not.toContain("only from its wording");
  });

  it("still reports a bare claim nothing derives as permanently pending", async () => {
    const r = await withModule(PLAIN, "- the implementation is tasteful and well factored\n");
    const messages = r.issues.map(i => i.message).join("\n");
    expect(messages).toContain("can only ever be pending");
    expect(messages).not.toContain("only from its wording");
  });

  it("says nothing when the claim carries its own concrete check", async () => {
    // A perspective moves the anchor into the document, which is exactly what the warning asks for,
    // so asking again would be noise.
    const r = await withModule(COMPONENT,
      "- the disabled attribute is set on the element\n  - run(2) → 4\n");
    expect(r.issues.map(i => i.message).join("\n")).not.toContain("only from its wording");
  });

  it("keeps both diagnostics as warnings, never errors", async () => {
    // These are judgement calls about how a document is written, not defects -- they must not fail
    // a build. `lldtdd lint` exits non-zero on errors only.
    const r = await withModule(REACTIVE, "- does a subscriber fire before the next line of code executes\n");
    expect(r.errors).toBe(0);
    expect(r.warnings).toBeGreaterThan(0);
  });

  it("warns on a claim that derives only a no-throw check", async () => {
    // `run(2) → resolves` runs the call and asserts nothing about what it returned, so it is green
    // against any `run` that doesn't crash -- the run-time `◐ shallow` state, caught at authoring.
    const r = await withModule(PLAIN, "- run(2) → resolves\n");
    const messages = r.issues.map(i => i.message).join("\n");
    expect(messages).toContain("passes on no-throw only");
    expect(r.errors).toBe(0); // a judgement call, not a defect
  });

  it("stays quiet when the claim pins a value", async () => {
    const r = await withModule(PLAIN, "- run(2) → 4\n");
    expect(r.issues.map(i => i.message).join("\n")).not.toContain("no-throw only");
  });
});

/**
 * The attachment hazard, as a diagnostic.
 *
 * A perspective binds to the bullet directly above it, so a reason written as a bullet between a
 * claim and its check silently takes the check -- the claim reads pending, the reason reads verified,
 * and nothing fails. It cost four documents in one corpus and was invisible in every run; only
 * reading the structure directly turned it up. The claim above is already reported as underivable,
 * which makes it the right place to say what the fix usually is: move a sentence out of the list.
 */
describe("mis-attached perspectives", () => {
  const subject = "export default class Widget { elem = { className: \"\" }; }";
  const doc = (body: string) => ["# Widget", "", "> ./subject.ts", "", "## Position is exclusive", "", body].join("\n");

  const claim = "- only one position class is active at a time; switching position replaces";
  const reason = "- callers can safely reassign position without manual cleanup";
  const check = "  - does changing position leave only the new class active?";

  it("points at the bullet below when it carries the perspectives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-attach-"));
    await writeFile(join(dir, "subject.ts"), subject);
    const file = join(dir, "d.lld.md");
    await writeFile(file, doc([claim, reason, check].join("\n")));
    const { issues } = await lintFile(file);
    const warning = issues.find(i => i.message.includes("only one position class"));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("the bullet below carries perspectives");
  });

  it("says nothing once the reason moves into the prose", async () => {
    // The negative control: without it this diagnostic could fire on every bare claim and nobody
    // would be able to tell the difference between the hazard and ordinary pending work.
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-attach-ok-"));
    await writeFile(join(dir, "subject.ts"), subject);
    const file = join(dir, "d.lld.md");
    await writeFile(file, doc(["Callers can reassign position freely.", "", claim, check].join("\n")));
    const { issues } = await lintFile(file);
    expect(issues).toEqual([]);
  });
});

/**
 * The parser giving up must be named, not swallowed: a stage ts-morph choked on falls back to
 * empty facts, so a "can only ever be pending" below it may be the parser's doing rather than
 * the claim's. The subject is the proven trigger from src/ast.test.ts's "degraded extraction".
 */
describe("degraded extraction", () => {
  const DEPTH = 30_000;
  const UNPARSEABLE =
    'export const parse = (s: string) => s.startsWith("# ");\n' +
    "const deep = " + "(".repeat(DEPTH) + "0" + ")".repeat(DEPTH) + ";\n";

  it("warns once per degraded stage, and the document still lints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-degraded-"));
    await writeFile(join(dir, "subject.ts"), UNPARSEABLE);
    const file = join(dir, "doc.lld.md");
    await writeFile(file,
      "# S\n> ./subject.ts\n\n## Quality\n\n- the implementation is tasteful and well factored\n");
    const r = await lintFile(file);

    const degraded = r.issues.filter(i => i.message.includes("AST extraction degraded"));
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.every(i => i.level === "warning")).toBe(true);
    expect(degraded.map(i => i.message).join("\n")).toContain("functionTypeChains");

    // Degradation is reported, not fatal: no errors, and the claim itself still gets its own
    // diagnostic alongside.
    expect(r.errors).toBe(0);
    expect(r.issues.some(i => i.message.includes("can only ever be pending"))).toBe(true);
  }, 60_000);
});

/**
 * A command named `lint` must not run the code it is reading. The subject below records its own
 * execution on disk, so the assertion is about observed side effects rather than about which
 * function the linter happened to call.
 */
describe("execution boundary", () => {
  const witness = (marker: string) => [
    `import { writeFileSync } from "fs";`,
    `import { dirname } from "path";`,
    `const here = dirname(new URL(import.meta.url).pathname);`,
    `writeFileSync(\`\${here}/${marker}-import.txt\`, "imported");`,
    `export const ran = () => writeFileSync(\`\${here}/${marker}-call.txt\`, "called");`,
    `export function greet(name: string) { return \`hi \${name}\`; }`,
  ].join("\n");

  const document = "# W\n> ./subject.ts\n\n## Greeting\n\n**method:** `greet`\n\n- greet(\"x\") -> returns \"hi x\"\n";

  async function lintWitness(opts?: { execute: boolean }) {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-exec-"));
    await writeFile(join(dir, "subject.ts"), witness("w"));
    const file = join(dir, "d.lld.md");
    await writeFile(file, document);
    await lintFile(file, opts);
    return {
      imported: existsSync(join(dir, "w-import.txt")),
      called: existsSync(join(dir, "w-call.txt")),
    };
  }

  it("does not import or call the module under test", async () => {
    expect(await lintWitness()).toEqual({ imported: false, called: false });
  });

  it("imports it only when the caller explicitly asks to execute", async () => {
    // The opt-in has to keep working, or the escape hatch is decoration and the sharper
    // inference it buys is unreachable.
    expect((await lintWitness({ execute: true })).imported).toBe(true);
  });

  it("still resolves exports from source, so the fence costs no accuracy", async () => {
    // If the static path saw nothing, every export-related diagnostic would go quiet and the
    // tests above would pass for the wrong reason.
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-exec-x-"));
    await writeFile(join(dir, "subject.ts"), witness("z"));
    const file = join(dir, "d.lld.md");
    await writeFile(file, "# W\n> ./subject.ts\n\n## Greeting\n\n**method:** `nosuchexport`\n\n- greet(\"x\") -> returns \"hi x\"\n");
    const { issues } = await lintFile(file);
    expect(issues.some(i => i.message.includes("nosuchexport"))).toBe(true);
    expect(existsSync(join(dir, "z-import.txt"))).toBe(false);
  });
});
