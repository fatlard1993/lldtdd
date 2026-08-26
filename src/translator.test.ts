import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parse, parseFile } from "./parser.ts";
import { translate } from "./translator/index.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Translation used to have a fourth path: a claim that matched neither the grammar nor an AST
 * pattern was sent to a model, which guessed a test body. These tests pin the property that
 * replaced it -- a claim is verified by a rule an author can read, or it is pending.
 *
 * The property that matters most is reproducibility. A test runner whose results depend on which
 * machine ran it is not reporting, and the old path made the derived suite a function of network
 * reachability, an API key, and a model version. Nothing below touches any of those.
 */

async function moduleWithDoc(source: string, doc: string) {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-tr-"));
  await writeFile(join(dir, "subject.ts"), source);
  const docPath = join(dir, "subject.lld.md");
  await writeFile(docPath, doc);
  return { docPath, dir };
}

const SUBJECT = [
  "export function check(n: number): boolean {",
  "  if (n === 3) return true;",
  "  return false;",
  "}",
].join("\n");

describe("translate -- derivation sources", () => {
  it("only ever emits the three offline sources", async () => {
    // Enforced by the type, asserted here because the guarantee is the point: every source is
    // something a reader can trace to a rule, and none of them is a guess.
    const allowed = new Set(["deterministic", "ast-derived", "pending"]);
    for (const rel of ["examples/auth.lld.md", "examples/cart.lld.md", "examples/rateLimiter.lld.md"]) {
      const suite = await translate(await parseFile(resolve(REPO_ROOT, rel)));
      for (const g of suite.groups) {
        for (const tc of g.cases) {
          expect(allowed.has(tc.source)).toBe(true);
          for (const p of tc.perspectives ?? []) expect(allowed.has(p.source)).toBe(true);
        }
      }
    }
  }, 30_000); // three full AST extractions; ts-morph dominates the time

  it("derives a case from an inline call the grammar recognises", async () => {
    const { docPath } = await moduleWithDoc(SUBJECT,
      "# S\n> subject.ts\n\n## Check\n**method:** `check`\n\n- check(3) → true\n");
    const tc = (await translate(await parseFile(docPath))).groups[0].cases[0];
    expect(tc.source).not.toBe("pending");
    expect(tc.action.method).toBe("check");
  });

  it("leaves a claim nothing can match as pending rather than inventing a test", async () => {
    // The load-bearing case. This claim is real prose about a real design decision, but no rule
    // maps it to a call, so the honest result is pending -- not a generated body that passes
    // because the function happened not to throw.
    const { docPath } = await moduleWithDoc(SUBJECT, [
      "# S", "> subject.ts", "", "## Check", "**method:** `check`", "",
      "- the threshold was chosen to match the upstream rate limiter, not for any local reason", "",
    ].join("\n"));
    const tc = (await translate(await parseFile(docPath))).groups[0].cases[0];
    expect(tc.source).toBe("pending");
  });

  it("leaves an unanchored claim pending even with a module present", async () => {
    const { docPath } = await moduleWithDoc(SUBJECT,
      "# S\n> subject.ts\n\n## Check\n\n- something entirely unmatchable happens here\n");
    const tc = (await translate(await parseFile(docPath))).groups[0].cases[0];
    expect(tc.source).toBe("pending");
  });

  it("treats a claim carrying perspectives as a heading, not a test", async () => {
    const { docPath } = await moduleWithDoc(SUBJECT, [
      "# S", "> subject.ts", "", "## Check", "**method:** `check`", "",
      "- the threshold behaviour is observable from outside",
      "  - check(3) → true", "",
    ].join("\n"));
    const tc = (await translate(await parseFile(docPath))).groups[0].cases[0];
    expect(tc.source).toBe("pending");
    expect(tc.perspectives?.[0].source).not.toBe("pending");
  });
});

describe("translate -- reproducibility", () => {
  it("produces an identical suite on repeated runs", async () => {
    // No cache, no network, no clock: same document plus same source must give the same suite,
    // on this machine and on anyone else's.
    const doc = await parseFile(resolve(REPO_ROOT, "examples/auth.lld.md"));
    const a = await translate(doc);
    const b = await translate(await parseFile(resolve(REPO_ROOT, "examples/auth.lld.md")));
    expect(JSON.stringify(b.groups)).toBe(JSON.stringify(a.groups));
  }, 30_000); // two parses + two translates; ts-morph extraction dominates and exceeds bun's 5s default cold

  it("carries the document's shape through to the suite", async () => {
    const suite = await translate(parse(
      "# S\n> subject.ts\n\n## One\n\n- a claim\n\n## Two\n\n- another claim\n",
      join(process.cwd(), "subject.lld.md")
    ));
    expect(suite.title).toBe("S");
    expect(suite.groups.map(g => g.name)).toEqual(["One", "Two"]);
  });

  it("points every bare `Subject` in a scenario at the constructor, not the namespace", async () => {
    // A suite imports the module twice: `Subject` as the namespace, `_SubjectCtor` as the default.
    // Rewriting only `new Subject` left `class extends Subject` extending a namespace object, which
    // is not a constructor -- the class definition threw and it reported as a failing claim rather
    // than a broken suite. Every position has to bind, not just the constructor call.
    const { docPath } = await moduleWithDoc(
      "export default class Widget {}\nexport function parse(s: string) { return s; }\n",
      "# S\n\n> subject.ts\n\n## G\n\n- a claim\n" +
      "  - new Array() captures seen then new (class extends Subject { }) captures c -> !!c\n"
    );
    const code = (await translate(await parseFile(docPath))).groups[0].cases[0].perspectives![0].assertion?.code ?? "";
    expect(code).toContain("class extends _SubjectCtor");
    expect(code).not.toContain("extends Subject");
  });

  it("leaves namespace access and quoted text alone when binding `Subject`", async () => {
    // `Subject.parse(...)` is how a claim reaches a named export, and a claim may legitimately
    // compare against the literal string "Subject". Rewriting either produces a false failure.
    const { docPath } = await moduleWithDoc(
      "export default class Widget {}\nexport function parse(s: string) { return s; }\n",
      "# S\n\n> subject.ts\n\n## G\n\n- a claim\n" +
      '  - new Array() captures seen then Subject.parse("Subject") captures c -> c === "Subject"\n'
    );
    const code = (await translate(await parseFile(docPath))).groups[0].cases[0].perspectives![0].assertion?.code ?? "";
    expect(code).toContain('Subject.parse("Subject")');
    expect(code).toContain('c === "Subject"');
    expect(code).not.toContain("_SubjectCtor");
  });

  it("translates a document whose module does not exist yet", async () => {
    // Document-first is the intended workflow; every claim is pending until the code lands.
    const suite = await translate(parse(
      "# S\n> not-written-yet.ts\n\n## G\n**method:** `f`\n\n- f(1) → true\n",
      join(process.cwd(), "s.lld.md")
    ));
    expect(suite.groups[0].cases).toHaveLength(1);
  });
});

/**
 * The THROWS pattern required a prefix before the suffix word, so the three suffix words
 * themselves were the only spellings that never matched: `-> \`Error\`` went silently pending
 * while `-> \`GreetError\`` passed. Silent is the operative word -- nothing in the run output or
 * in `lldtdd lint` pointed at the cause, and `Error` is the first thing most authors write.
 *
 * Both directions are pinned: the bare builtins must derive a throws assertion, and a word that
 * merely ends in "error" without being a class name must still not.
 */
describe("translate -- throws outcome class names", () => {
  // The module has to exist: against a missing module every case degrades to `needs-fixture` and
  // the outcome is discarded, which would make this suite pass for the wrong reason.
  const throwsFor = async (outcome: string) => {
    const { docPath } = await moduleWithDoc(
      "export function f(x: string): string { throw new Error(x); }",
      `# S\n> subject.ts\n\n## G\n**method:** \`f\`\n\n- f("x") -> ${outcome}\n`
    );
    const suite = await translate(await parseFile(docPath));
    return suite.groups[0].cases[0]?.assertion;
  };

  it.each(["Error", "Exception", "Fault", "TypeError", "AuthError", "GreetError"])(
    "derives a throws assertion for `%s`",
    async name => {
      const assertion = await throwsFor(`\`${name}\``);
      expect(assertion?.type).toBe("throws");
      expect(assertion?.errorClass).toBe(name);
    }
  );

  it("carries the message through for `Error(\"boom\")`", async () => {
    const assertion = await throwsFor('`Error("boom")`');
    expect(assertion?.type).toBe("throws");
    expect(assertion?.errorClass).toBe("Error");
    expect(assertion?.errorMessage).toBe("boom");
  });

  it("does not treat a lowercase word ending in `error` as an error class", async () => {
    // Guards the widened regex against matching prose: `notAnError` is not a class name, and an
    // outcome that isn't one must not silently become a throws assertion.
    const assertion = await throwsFor("`notAnError`");
    expect(assertion?.errorClass).toBeUndefined();
  });
});

/**
 * A claim that names its own call and its own assertion must be run as written.
 *
 * `__lld_api` resolution exists to fill in a claim nothing else could read. It used to decide that
 * with `!tc.action.method || tc.action.method === group.method`, which cannot tell an inherited
 * method from an authored one: a claim written as `parse("…") captures r -> r.title === "T"` inside a
 * group annotated `**method:** parse` looked like an empty slot. Its arguments and its assertion were
 * both replaced by the description-derived call, and the generated test kept the claim's own text as
 * its *name* while checking something else -- reported as verified.
 *
 * Every claim in `lld/document.lld.md` had been flattened to the same synthetic-document check that
 * way, which is why no mutation of `src/parser.ts` was ever caught by any of them: 13 mutants, 0
 * killed. Writing the call out is the one unambiguous thing an author can do, so it is the last
 * thing that should be second-guessed.
 */
describe("translate -- an authored claim is not rewritten", () => {
  const authored = async (claim: string) => {
    const { docPath } = await moduleWithDoc(
      "export function f(x: string): string { return x.toUpperCase(); }",
      `# S\n> subject.ts\n\n## G\n**method:** \`f\`\n\n- ${claim}\n`
    );
    const suite = await translate(await parseFile(docPath));
    return suite.groups[0].cases[0];
  };

  it("keeps the arguments the claim passed", async () => {
    const tc = await authored(`f("written-by-hand") captures r -> r === "WRITTEN-BY-HAND"`);
    expect(tc.action.args).toEqual(["written-by-hand"]);
    expect(tc.action.method).toBe("f");
  });

  it("marks a claim that named its own call", async () => {
    const tc = await authored(`f("x") captures r -> r === "X"`);
    expect(tc.action.fromClaim).toBe(true);
  });

  it("marks a claim that named an outcome without naming a call", async () => {
    // The author still said what to check, so the shape is theirs even though the method is
    // inherited from the group annotation.
    const tc = await authored("a bad input -> `TypeError`");
    expect(tc.action.fromClaim).toBe(true);
  });

  it("leaves a bare prose claim unmarked, so a family that knows the module can still fill it in", async () => {
    // The counterpart to the above: a vocabulary match is not an authored shape, and a resolver that
    // recognises the module's structure has a better body for it than the generic one.
    const tc = await authored("the transformation is total and never returns nothing");
    expect(tc.action.fromClaim).toBeUndefined();
  });
});

/**
 * `\n` in a quoted argument used to survive into the generated code as a literal backslash and an
 * `n`, so a claim describing a multi-line document tested a one-line one. It was invisible because
 * the claims that would have caught it were themselves being rewritten by the bug above.
 */
describe("translate -- escape sequences in a claim's arguments", () => {
  it("passes a real newline, not a backslash and an n", async () => {
    const { docPath } = await moduleWithDoc(
      "export function lineCount(s: string): number { return s.split('\\n').length; }",
      '# S\n> subject.ts\n\n## G\n**method:** `lineCount`\n\n- lineCount("a\\nb\\nc") captures r -> r === 3\n'
    );
    const suite = await translate(await parseFile(docPath));
    expect(suite.groups[0].cases[0].action.args).toEqual(["a\nb\nc"]);
  });

  it("leaves an escaped backslash as one backslash", async () => {
    const { docPath } = await moduleWithDoc(
      "export function id(s: string): string { return s; }",
      '# S\n> subject.ts\n\n## G\n**method:** `id`\n\n- id("a\\\\b") captures r -> r === "a\\\\b"\n'
    );
    const suite = await translate(await parseFile(docPath));
    expect(suite.groups[0].cases[0].action.args).toEqual(["a\\b"]);
  });
});
