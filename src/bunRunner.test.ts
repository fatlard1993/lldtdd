import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { RUNTIME_MODULE_PATH, RUNTIME_EXPORTS, hasDirectTest } from "./bunRunner.ts";
import type { TestCase } from "./types.ts";

/**
 * Generated test files import runtime.ts by absolute path, baked in at codegen time. Only the
 * db-lifecycle codegen path emits that import, and no example or self-hosted document exercises
 * it -- so when src/adapters/bun.ts became src/bunRunner.ts the path went one directory too high
 * and every test in the repo still passed. The same blind spot also let the emit name
 * FIELD_VALUES from fixtures.ts, which never exported it. These assertions are the whole safety
 * net for that class of breakage.
 */
describe("generated-code module paths", () => {
  it("resolves runtime.ts to a file that exists", () => {
    expect(existsSync(RUNTIME_MODULE_PATH)).toBe(true);
  });

  it("exports every binding the generated import statement names", async () => {
    // Reads the same RUNTIME_EXPORTS the emitted statement is built from, rather than a copy
    // kept in sync by comment. A rename in runtime.ts now fails here instead of producing a
    // generated file that won't parse, with no signal until someone runs a suite that needs it.
    const runtime = await import(RUNTIME_MODULE_PATH);
    for (const name of RUNTIME_EXPORTS) {
      expect(typeof runtime[name]).toBe("function");
    }
  });
});

/**
 * `hasDirectTest` answers one question for two callers: the generator, deciding between `it` and
 * `it.todo`, and the classifier, deciding whether a missing result means "pending" or "passed".
 * It used to be two inline disjunctions, and they had drifted in two places.
 *
 * The dangerous direction is a claim the generator skipped but the classifier scored: that reports
 * green with no test behind it. The cases below are exactly the shapes where the two used to
 * disagree, pinned to the stricter answer. They were unreachable across 474 real claims when this
 * was written -- which is the point. Nothing was failing; the next edit to one copy is what would
 * have broken it.
 */
describe("hasDirectTest", () => {
  const testCase = (over: Partial<TestCase> = {}): TestCase => ({
    description: "d",
    source: "ast-derived",
    action: {},
    assertion: { type: "resolves" },
    ...over,
  } as TestCase);

  it("is false for captures without a method -- there is nothing to call", () => {
    // The generator emits `it.todo` for `captures` alone; a classifier that scores that shape
    // as a pass is green with nothing behind it.
    expect(hasDirectTest(testCase({ action: { captures: "r" } }), false)).toBe(false);
  });

  it("is false for fault-resilience without a method", () => {
    // The generator keyed off `assertion.faultTarget`; its emit branch needs `action.method`, so
    // faultTarget alone fell through to a generated `Subject.undefined()` call.
    expect(hasDirectTest(
      testCase({ action: {}, assertion: { type: "fault-resilience", faultTarget: "x" } as any }),
      false
    )).toBe(false);
  });

  it("is true for fault-resilience with a method", () => {
    expect(hasDirectTest(
      testCase({ action: { method: "run" }, assertion: { type: "fault-resilience", faultTarget: "x" } as any }),
      false
    )).toBe(true);
  });

  it("is true for a complete inspect body with no method, and false once it needs a captured value", () => {
    const inspect = { type: "inspect", code: "expect(1).toBe(1);" } as any;
    expect(hasDirectTest(testCase({ action: {}, assertion: inspect }), false)).toBe(true);
    expect(hasDirectTest(testCase({ action: { captures: "r" }, assertion: inspect }), false)).toBe(false);
  });

  it("is false for a pending claim regardless of its method", () => {
    expect(hasDirectTest(testCase({ source: "pending", action: { method: "f" } }), false)).toBe(false);
  });

  it("is false for a spy assertion without a setup to inject the spy into", () => {
    expect(hasDirectTest(testCase({ action: { method: "f" }, assertion: { type: "called" } as any }), false)).toBe(false);
    expect(hasDirectTest(testCase({ action: { method: "f" }, assertion: { type: "called" } as any }), true)).toBe(true);
  });
});

/**
 * Mutation testing runs an already-translated suite against a mutant copy of the module. That only
 * measures anything if the generated file actually imports the mutant -- and for a long while it did
 * not. `suite.modulePath` was swapped, but the default import (`_SubjectCtor`, which every
 * `new Subject(...)` is rewritten to) came from AST facts captured at translate time, so every
 * constructor call reached the original, unmutated class.
 *
 * Nothing failed. The suite passed against every mutant, so the report read "0 killed, N survived"
 * for every document in every corpus -- indistinguishable from a document full of weak claims, and
 * the reason it went unnoticed. A mutant that cannot possibly pass is the only honest probe here.
 */
describe("module substitution reaches generated code", () => {
  it("runs the suite against the substituted module, not the original", async () => {
    const { mkdtemp, writeFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { parseFile } = await import("./parser.ts");
    const { translate } = await import("./translator/index.ts");
    const { runSuite } = await import("./bunRunner.ts");

    const dir = await mkdtemp(join(tmpdir(), "lldtdd-sub-"));
    const original = join(dir, "subject.ts");
    await writeFile(original, "export default class Widget { ok() { return true; } }\n");
    const docPath = join(dir, "subject.lld.md");
    await writeFile(docPath,
      "# S\n\n> subject.ts\n\n## G\n\n- a claim\n" +
      "  - new Array() captures seen then new Subject() captures w -> w.ok() === true\n");

    const suite = await translate(await parseFile(docPath, dir));
    const asTranslated = await runSuite(suite);
    expect(asTranslated.passed).toBeGreaterThan(0);
    expect(asTranslated.failed).toBe(0);

    // A stand-in whose constructor always throws: if it is loaded, nothing can pass.
    const standIn = join(dir, "mutant.ts");
    await writeFile(standIn, "export default class Widget { constructor() { throw new Error('stand-in'); } ok() { return true; } }\n");
    const substituted = await runSuite({ ...suite, modulePath: standIn, substitutedFor: suite.modulePath });
    expect(substituted.passed).toBe(0);
    expect(substituted.failed).toBeGreaterThan(0);
  }, 60000);

  it("leaves the substituted token alone inside a claim's own string literals", async () => {
    // The substitution used to be a whole-file split/join, so a claim whose expected string
    // happened to contain the module path had that literal rewritten too -- the assertion then
    // failed against every mutant for a reason the author never wrote, inflating survivors.
    const { mkdtemp, writeFile, copyFile, readFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { parseFile } = await import("./parser.ts");
    const { translate } = await import("./translator/index.ts");
    const { runSuite } = await import("./bunRunner.ts");

    const dir = await mkdtemp(join(tmpdir(), "lldtdd-sub-lit-"));
    const original = join(dir, "subject.ts");
    const marker = `seen ${original} once`;
    await writeFile(original,
      `export default class Widget { where() { return ${JSON.stringify(marker)}; } }\n`);
    const docPath = join(dir, "subject.lld.md");
    await writeFile(docPath,
      "# S\n\n> subject.ts\n\n## G\n\n- a claim\n" +
      `  - new Array() captures seen then new Subject() captures w -> w.where() === ${JSON.stringify(marker)}\n`);

    const suite = await translate(await parseFile(docPath, dir));
    const asTranslated = await runSuite(suite);
    expect(asTranslated.passed).toBeGreaterThan(0);
    expect(asTranslated.failed).toBe(0);

    // An identity mutant: same source, different path. The suite must still pass -- it only can
    // if the claim's literal (which contains the original path) survived substitution untouched.
    const standIn = join(dir, "mutant.ts");
    await copyFile(original, standIn);
    const genPath = join(dir, "generated.txt");
    process.env.LLDTDD_DEBUG_GEN = genPath;
    let substituted;
    try {
      substituted = await runSuite({ ...suite, modulePath: standIn, substitutedFor: suite.modulePath });
    } finally {
      delete process.env.LLDTDD_DEBUG_GEN;
    }
    expect(substituted.failed).toBe(0);
    expect(substituted.passed).toBeGreaterThan(0);

    const gen = await readFile(genPath, "utf8");
    expect(gen).toContain(marker);                            // claim literal untouched
    expect(gen).not.toContain(`from ${JSON.stringify(original)}`); // imports rewritten to the mutant
  }, 60000);
});

/**
 * A spy has to reach the code under test somehow. A group `**setup:**` is one route; the other is
 * a claim that writes `spy` in its own arguments, which needs no setup at all.
 *
 * Only the first was recognized, so `GET(url, { onResponse: spy }) -> spy called` reported pending
 * -- indistinguishable from "no rule reaches this claim". The identifier is normally one property
 * of an options object, and an object holding a bare identifier is not JSON, so the whole literal
 * arrives as a single opaque expression: scanning only top-level arguments never saw it, and the
 * emitted call named a `spy` that was never declared.
 */
describe("a failure whose report is large", () => {
  // bun prints the value a failed assertion received, and under a DOM that's hundreds of kilobytes.
  // Written into a pipe, bun test dropped parts of it, (fail) lines among them, and a claim that
  // simply failed was reported as the module not loading.
  it("reaches the parser with every (fail) line", async () => {
    const { mkdtemp, writeFile, rm } = await import("fs/promises");
    const { join } = await import("path");
    const { runCapturing } = await import("./bunRunner.ts");

    // Inside the repository, to reach happy-dom in node_modules
    const dir = await mkdtemp(join(import.meta.dir, "..", ".lldtdd-large-"));
    try {
      const file = join(dir, "dom.test.ts");
      await writeFile(file, [
        'import { GlobalRegistrator } from "@happy-dom/global-registrator";',
        "GlobalRegistrator.register();",
        'import { it, expect } from "bun:test";',
        'class Widget { elem = document.createElement("div"); constructor() { document.body.append(this.elem); } }',
        ...Array.from({ length: 6 }, (_, i) => `it("widget ${i}", () => { expect(() => new Widget()).toThrow(); });`),
      ].join("\n"));
      const { output } = await runCapturing(["bun", "test", file]);
      expect(output.split("\n").filter(line => /^\(fail\)/.test(line.trim()))).toHaveLength(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("spy supplied by the claim rather than by setup", () => {
  const spyCase = (args: unknown[]): TestCase => ({
    description: "d",
    source: "deterministic",
    action: { method: "GET", args },
    assertion: { type: "called" },
  } as unknown as TestCase);

  it("is directly testable when the claim names the spy at the top level", () => {
    expect(hasDirectTest(spyCase([{ __expr: "spy" }]), false)).toBe(true);
  });

  it("is directly testable when the spy sits inside an options object", () => {
    expect(hasDirectTest(spyCase([{ __expr: `{ enabled: true, onResponse: spy }` }]), false)).toBe(true);
  });

  it("still needs setup when the claim never names a spy", () => {
    // The negative control: without it this would pass for every spy assertion regardless of
    // whether anything could actually inject the handler.
    expect(hasDirectTest(spyCase(["plain"]), false)).toBe(false);
  });

  it("does not mistake a property named spy for the reserved identifier", () => {
    // `spy:` is a key, not a value. Treating it as the handler would declare a mock nothing uses
    // and rewrite the caller's own field name.
    expect(hasDirectTest(spyCase([{ __expr: `{ spy: 1 }` }]), false)).toBe(false);
  });
});
