import { describe, it, expect } from "bun:test";
import { parse, parseArgList } from "./parser.ts";
import { resolve } from "path";

/**
 * The parser is the front of the pipeline and had no direct tests -- every other module's tests
 * were implicitly asserting its behavior through whatever document they happened to load. These
 * cover the grammar surface in GRAMMAR.md directly, so a change to the format fails here rather
 * than somewhere three stages downstream.
 *
 * `parse` takes content plus the path the document would have lived at; module pointers resolve
 * relative to that path, so nothing needs to exist on disk.
 */

const AT = resolve(process.cwd(), "doc.lld.md");
const parseDoc = (content: string) => parse(content, AT);

describe("document structure", () => {
  it("reads the title and resolves the module pointer to an absolute path", () => {
    const doc = parseDoc("# Auth Service\n> src/auth.ts\n\n## Login\n\n- a claim\n");
    expect(doc.title).toBe("Auth Service");
    expect(doc.module).toBe(resolve(process.cwd(), "src/auth.ts"));
  });

  it("keeps prose between the pointer and the first group as the description", () => {
    const doc = parseDoc("# T\n> src/a.ts\n\nPasswords are never returned.\n\n## G\n\n- a claim\n");
    expect(doc.description).toContain("Passwords are never returned");
  });

  it("turns each heading into a named group", () => {
    const doc = parseDoc("# T\n> src/a.ts\n\n## Login\n\n- one\n\n## Logout\n\n- two\n");
    expect(doc.groups.map(g => g.name)).toEqual(["Login", "Logout"]);
  });
});

describe("group annotations", () => {
  it("reads method, setup, beforeEach and beforeAll", () => {
    const doc = parseDoc([
      "# T", "> src/a.ts", "", "## G",
      "**method:** `login`",
      "**setup:** `createThing()`",
      "**beforeEach:** `_reset()`",
      "**beforeAll:** `initDb()`",
      "", "- a claim", "",
    ].join("\n"));
    const g = doc.groups[0];
    expect(g.method).toBe("login");
    expect(g.setup).toBe("createThing()");
    expect(g.beforeEach).toBe("_reset()");
    expect(g.beforeAll).toBe("initDb()");
  });

  it("resolves a group-level module override to an absolute path", () => {
    const doc = parseDoc("# T\n> src/a.ts\n\n## G\n**module:** `src/b.ts`\n\n- a claim\n");
    expect(doc.groups[0].moduleOverride).toBe(resolve(process.cwd(), "src/b.ts"));
  });

  it("applies document-level lifecycle to groups that do not override it", () => {
    const doc = parseDoc([
      "# T", "> src/a.ts", "",
      "**beforeAll:** `initDb()`", "",
      "## G", "", "- a claim", "",
      "## H", "**beforeAll:** `other()`", "", "- a claim", "",
    ].join("\n"));
    expect(doc.defaultBeforeAll).toBe("initDb()");
    expect(doc.groups[1].beforeAll).toBe("other()");
  });
});

describe("assertion forms", () => {
  it("splits a claim on the arrow into condition and outcome", () => {
    const a = parseDoc("# T\n> src/a.ts\n\n## G\n\n- wrong password → `AuthError`\n").groups[0].assertions[0];
    expect(a.condition).toBe("wrong password");
    expect(a.outcome).toBe("`AuthError`");
  });

  it("extracts an inline call expression with its arguments", () => {
    const a = parseDoc('# T\n> src/a.ts\n\n## G\n\n- check(3, "x") → true\n').groups[0].assertions[0];
    expect(a.callMethod).toBe("check");
    expect(a.callArgs).toEqual([3, "x"]);
  });

  it("reads an N× prefix as a repeat count", () => {
    const a = parseDoc("# T\n> src/a.ts\n\n## G\n\n- 5 x login(\"a\", \"b\") → locked\n").groups[0].assertions[0];
    expect(a.repeat).toBe(5);
    expect(a.callMethod).toBe("login");
  });

  it("reads a captures chain as two calls", () => {
    const a = parseDoc([
      "# T", "> src/a.ts", "", "## G", "",
      "- create(1) captures r then update(2) captures result → result.id === 1", "",
    ].join("\n")).groups[0].assertions[0];
    expect(a.callMethod).toBe("create");
    expect(a.captures).toBe("r");
    expect(a.extraCalls).toHaveLength(1);
    expect(a.extraCalls?.[0].method).toBe("update");
    expect(a.extraCalls?.[0].captures).toBe("result");
  });

  it("reads a captures chain of more than two calls, in written order", () => {
    const a = parseDoc([
      "# T", "> src/a.ts", "", "## G", "",
      "- subscribe(\"t\", thrower) captures u1 then subscribe(\"t\", spy) captures u2 then publish(\"t\", 1) captures sent → spy called", "",
    ].join("\n")).groups[0].assertions[0];
    expect(a.callMethod).toBe("subscribe");
    expect(a.captures).toBe("u1");
    expect(a.extraCalls?.map(s => [s.method, s.captures])).toEqual([
      ["subscribe", "u2"],
      ["publish", "sent"],
    ]);
  });

  it("mixes `and` and `then` joiners in one chain", () => {
    const a = parseDoc([
      "# T", "> src/a.ts", "", "## G", "",
      "- a(1) captures x and b(2) captures y then c(3) captures z → z === 1", "",
    ].join("\n")).groups[0].assertions[0];
    expect(a.extraCalls?.map(s => s.captures)).toEqual(["y", "z"]);
  });

  // A half-parsed chain would derive a test from the readable prefix and silently check
  // something narrower than the claim states, so the whole condition falls back to non-chain
  // handling instead.
  it("rejects a chain whose trailing step has no captures", () => {
    const a = parseDoc([
      "# T", "> src/a.ts", "", "## G", "",
      "- a(1) captures x then b(2) → x === 1", "",
    ].join("\n")).groups[0].assertions[0];
    expect(a.extraCalls).toBeUndefined();
    expect(a.captures).toBeUndefined();
  });

  it("attaches an indented perspective to the claim above it", () => {
    const doc = parseDoc([
      "# T", "> src/a.ts", "", "## G", "",
      "- tokens expire; they are not valid indefinitely",
      "  - login(\"a\") captures r → r.expiresAt is defined", "",
    ].join("\n"));
    const a = doc.groups[0].assertions[0];
    expect(doc.groups[0].assertions).toHaveLength(1);
    expect(a.perspectives).toHaveLength(1);
    expect(a.perspectives![0].callMethod).toBe("login");
  });

  it("keeps a plain-language claim with no code syntax", () => {
    const a = parseDoc("# T\n> src/a.ts\n\n## G\n\n- discounts apply at checkout, not at add-time\n")
      .groups[0].assertions[0];
    expect(a.raw).toBe("discounts apply at checkout, not at add-time");
    expect(a.callMethod).toBeUndefined();
  });
});

describe("resilience", () => {
  it("parses a document whose module does not exist yet", () => {
    // Writing the document before the code is the intended workflow, so the parser must not
    // require the module to be on disk.
    const doc = parseDoc("# T\n> src/not-written-yet.ts\n\n## G\n\n- a claim\n");
    expect(doc.groups[0].assertions).toHaveLength(1);
  });

  it("returns an empty group list for a document with no headings", () => {
    expect(parseDoc("# T\n> src/a.ts\n\njust prose\n").groups).toEqual([]);
  });
});

/**
 * An argument that has to be computed had nowhere to go in a positional slot.
 *
 * The passthroughs cover an object literal, a `new`, and a bare identifier, so an expression
 * smuggled in as one property of an options object emitted verbatim and worked, while the identical
 * expression written as the first argument fell to the string fallback and was emitted quoted. The
 * claim passed a piece of source text where it meant to pass a value -- and a quoted expression
 * reads, at a glance, as though it had been evaluated.
 *
 * The leading `(` is what keeps this away from the fallback's real job, which is prose.
 */
describe("a parenthesized expression as an argument", () => {
  const args = (claim: string) =>
    parseDoc(`# T\n> src/a.ts\n\n## G\n\n- ${claim}\n`).groups[0].assertions[0].callArgs;

  it("passes a computed value through as code, not as text", () => {
    expect(args(`f((await create({ a: 1 })).id, "t") -> resolves`))
      .toEqual([{ __expr: "(await create({ a: 1 })).id" }, "t"]);
  });

  it("keeps prose a string, which is what the fallback is for", () => {
    // The negative control. Without it this rule could swallow the natural-language argument
    // form that lets a claim name a condition it has not made concrete yet.
    expect(args(`addItem(a valid session) -> resolves`)).toEqual(["a valid session"]);
  });

  it("leaves an unbalanced fragment as a string rather than emitting code that cannot compile", () => {
    // Checked against parseArgList rather than through a claim: an unbalanced call never parses as
    // a call in the first place, so this guard is only reachable by a direct caller of the
    // argument parser. It still has to hold there -- the alternative is emitting a fragment.
    expect(parseArgList(`(unclosed, "t"`)).toEqual([`(unclosed, "t"`]);
  });

  it("does not treat parentheses inside a quoted string as an expression", () => {
    expect(args(`f("(not code)") -> resolves`)).toEqual(["(not code)"]);
  });
});

/**
 * The module pointer is a path the pipeline later reads -- lint and suggest open it, and the
 * pre-commit hook runs lint on its own. Before this boundary existed, an absolute pointer
 * discarded the project root entirely (resolve keeps nothing before an absolute segment) and a
 * relative one climbed out with enough `..`, so "lint does not leave the project" was true only
 * because the corpus happened to be polite.
 *
 * Containment is lexical: inside the root, or inside the document's own directory. The second
 * base is what lets a document that itself lives outside the root -- the linter's temp-dir
 * fixtures -- keep pointing at the module beside it.
 */
describe("module pointer containment", () => {
  it("rejects an absolute pointer, naming the pointer and the root", () => {
    expect(() => parseDoc("# T\n> /etc/passwd\n\n## G\n\n- a claim\n"))
      .toThrow(`module pointer \`/etc/passwd\``);
    expect(() => parseDoc("# T\n> /etc/passwd\n\n## G\n\n- a claim\n"))
      .toThrow(`outside the project root ${process.cwd()}`);
  });

  it("rejects a relative pointer that climbs out of the root", () => {
    expect(() => parseDoc("# T\n> ../outside.ts\n\n## G\n\n- a claim\n"))
      .toThrow("outside the project root");
  });

  it("rejects an escaping group-level module override", () => {
    // The override resolves through the same code path now, but the claim is about the boundary,
    // not the plumbing: every place a document can name a module must be behind it.
    expect(() => parseDoc("# T\n> src/a.ts\n\n## G\n**module:** `/etc/passwd`\n\n- a claim\n"))
      .toThrow("outside the project root");
  });

  it("rejects an escaping companion pointer", () => {
    expect(() => parseDoc("# T\n> src/a.ts\n\n**companion:** `../../elsewhere.ts`\n\n## G\n\n- a claim\n"))
      .toThrow("outside the project root");
  });

  it("accepts a normal relative pointer, bare or ./-prefixed", () => {
    expect(parseDoc("# T\n> src/a.ts\n\n## G\n\n- a claim\n").module)
      .toBe(resolve(process.cwd(), "src/a.ts"));
    expect(parseDoc("# T\n> ./src/a.ts\n\n## G\n\n- a claim\n").module)
      .toBe(resolve(process.cwd(), "src/a.ts"));
  });

  it("accepts a pointer that climbs but lands back inside the root", () => {
    // A document one level down pointing at a sibling directory: the `..` is real, the escape
    // is not. Rejecting on the spelling instead of the destination would break lld/'s own docs.
    const doc = parse("# T\n> ../src/a.ts\n\n## G\n\n- a claim\n", resolve(process.cwd(), "lld/doc.lld.md"));
    expect(doc.module).toBe(resolve(process.cwd(), "src/a.ts"));
  });

  it("accepts a sibling pointer from a document living outside the root", () => {
    // What the linter's temp-dir fixtures do: the document is the subject the caller chose, and
    // reading the module beside it is the operation itself, not an escape from it.
    const doc = parse("# T\n> ./subject.ts\n\n## G\n\n- a claim\n", "/tmp/elsewhere/doc.lld.md");
    expect(doc.module).toBe("/tmp/elsewhere/subject.ts");
  });
});
