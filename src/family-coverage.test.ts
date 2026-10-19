import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "fs/promises";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runAndCheck } from "./run.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

/**
 * Every derivation defect found in this engine has had the same shape.
 *
 * A family gets written for the one project that needed it. Its gate looks structural -- "exports a
 * class extending EventTarget", "exports a const named styled", "assigns this.options" -- while the
 * code it emits quietly requires that project's whole interface. Nothing fails, because nothing else
 * ever runs it. Then a second module trips the gate and the run reports its claims as **failing**:
 * the author reads red for a premise they never wrote, which is the inverse of a false pass and just
 * as wrong.
 *
 * Four families were fixed this way, and in two of them the defect was already described in a
 * comment by whoever wrote it. The knowledge was there. The second consumer was not.
 *
 * So this file makes the second consumer a build requirement. It discovers the derivers the engine
 * actually ships and fails if one is not declared below -- a new family cannot be added without
 * saying how it was probed, or admitting it wasn't.
 */

/** Derivers are the functions a claim can reach. `is*` predicates are their helpers, not entry
 *  points, so they are not the thing needing second-consumer proof. */
const DERIVER_NAME = /^(derive|resolve)[A-Z]/;

async function shippedDerivers(): Promise<string[]> {
  const dir = new URL("./ast/patterns/", import.meta.url).pathname;
  const files = (await readdir(dir)).filter(f => f.endsWith(".ts"));
  const names: string[] = [];
  for (const file of files) {
    const mod = await import(join(dir, file));
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function" && DERIVER_NAME.test(name)) names.push(name);
    }
  }
  return names.sort();
}

/** How a family was shown to work against a module that is not the one it was written for.
 *
 *  `gap` is deliberately not a quiet omission: it records that no second consumer has exercised the
 *  family, which is the state every fixed defect started in. Turning a gap into coverage is the work;
 *  leaving it undeclared is what this file exists to prevent.
 *
 *  A `probedBy` is a checked reference, not prose: it names the file(s) holding the probe, and every
 *  backtick-quoted span in it must occur verbatim in a file it names (dereferenced by a test below).
 *  Anchor the probe's substance -- a fixture line, an emitted identifier -- rather than a test
 *  title, so retitling a live probe stays green while deleting the probe goes red. */
type Coverage =
  | { probedBy: string; gate: string }
  | { gap: string };

const COVERAGE: Record<string, Coverage> = {
  resolveSelfDatabasePatterns: {
    gate: "a module that is its own store: init, write(), a db, no imported database",
    probedBy: "lld/fixtures/selfdb.ts -- its own collection, fields and write `queue`; run.test.ts drives `lld/fixtures/selfdb.lld.md` and asserts 3/3 derive and pass",
  },
  deriveEventTargetInline: {
    gate: "a default-exported class extending EventTarget, plus the reactive-context methods the emitted code calls",
    probedBy: "ast.test.ts -- declines a non-EventTarget module, and declines per missing capability by flipping one flag off a fully capable class (`[missing]: false`)",
  },
  deriveHttpClientInline: {
    gate: "exported HTTP-verb functions AND a result carrying isFetching plus an idle/loading/success/error status",
    probedBy: "ast.test.ts -- a PUT-only client is tested through PUT (`Subject.PUT(`); a plain fetch wrapper and a thin verb wrapper (`makeThinWrapper`) are both declined",
  },
  deriveStyledFactoryInline: {
    gate: "a styled export that returns a class",
    probedBy: "ast.test.ts -- a class-name joiner (`names.join`) named styled is declined instead of deriving a failing test",
  },
  deriveComponentInline: {
    gate: "a default-exported constructor; per-pattern, whatever that pattern's body constructs and reads",
    probedBy: "ast.test.ts -- probes a validated option with its declared enum values (`position_enum`), declines a too-small enum (`enum: ['only']`), and aims interaction probes at a rendered descendant (`firstElementChild`)",
  },
  resolveCliClassPatterns: {
    gate: "a class assigning this.options, and declaring the parse() method every body calls",
    probedBy: "this file -- a settings holder that assigns options, commands (`this.commands = {};`) and tail but has no parse()",
  },
  resolveCliParserPatterns: {
    gate: "same parse() requirement, on top of the exit-code / process.argv signals",
    probedBy: "this file -- shares the settings-holder parse() probe (`this.commands = {};`) with the class patterns",
  },
  deriveDerivationFactoryInline: {
    gate: "a module exporting `function derive(`",
    probedBy: "ast.test.ts -- a namesake math helper (`base ** exp`) named derive stays pending rather than failing",
  },

  resolveStorePatterns: {
    gate: "a collection the module declares with createStore, which reaches its writes through the database module's `db`",
    probedBy: "lld/fixtures/stock/crates.ts -- a createStore collection with typed specs named through a const (`const fields =`), its own queued store; lld/fixtures/loose/createStore.ts is the same shape unqueued (`await db.write();` straight away), whose order claim must fail",
  },
  resolveCrudSearchPatterns: {
    gate: "a createCRUD-detected schema; per pattern, whatever that body imports (_database, _registry) or reads off the module's own afterDelete hook",
    probedBy: "lld/fixtures/store/vessels.ts -- a createCRUD entity whose fields (`hullName`, berth, capacity) look nothing like the one it was written against; run through lld/fixtures/vessels.lld.md below",
  },
  resolveTransformPatterns: {
    gate: "for the four CLI-shaped scenarios, a constructible default export declaring parse(); the rest gate on extracted facts",
    probedBy: "this file -- a value mapper (`this.transforms[kind]`) with a claim about a replaceable transform map, which used to derive a CLI parser test",
  },
};

describe("every shipped deriver declares second-consumer coverage", () => {
  it("has no undeclared derivers", async () => {
    const undeclared = (await shippedDerivers()).filter(name => !(name in COVERAGE));
    // A new family reaching this line means it shipped without anyone asking whether it works for
    // a module other than the one it was written against. Add it to COVERAGE with a probe, or with
    // a `gap` stating plainly that it has none.
    expect(undeclared).toEqual([]);
  });

  it("declares nothing that is no longer shipped", async () => {
    const shipped = new Set(await shippedDerivers());
    expect(Object.keys(COVERAGE).filter(name => !shipped.has(name))).toEqual([]);
  });

  it("reports how many families still have no second consumer", async () => {
    const gaps = Object.entries(COVERAGE).filter(([, c]) => "gap" in c).map(([n]) => n);
    // A ratchet, now at zero. Every family this probe was applied to turned up a real defect -- six
    // for six -- so a gap reappearing is a regression in discipline even while the suite is green.
    expect(gaps).toEqual([]);
  });

  /** Declaring a probe is not the same as having one: before this test, a probe deleted from
   *  ast.test.ts left its `probedBy` line -- and this whole registry -- green. */
  it("dereferences every probedBy against the source it names", async () => {
    const srcDir = new URL(".", import.meta.url).pathname;
    const repoRoot = join(srcDir, "..");
    const THIS_FILE = "family-coverage.test.ts";

    // Every string in the registry, to be cut out of any corpus before matching: this file's own
    // source contains the registry, so without the cut a "this file" anchor would match its own
    // declaration and verify nothing.
    const registryText = Object.values(COVERAGE).flatMap(c => Object.values(c));

    const failures: string[] = [];
    for (const [name, cov] of Object.entries(COVERAGE)) {
      if (!("probedBy" in cov)) continue;

      const files = [...cov.probedBy.matchAll(/(?:[\w-]+[/.])*[\w-]+\.(?:ts|md)/g)].map(m => m[0]);
      if (cov.probedBy.startsWith("this file")) files.push(THIS_FILE);
      if (files.length === 0) failures.push(`${name}: probedBy names no file`);

      let corpus = "";
      for (const file of files) {
        const path = file === THIS_FILE ? join(srcDir, THIS_FILE)
          : file.includes("/") ? join(repoRoot, file) : join(srcDir, file);
        try {
          corpus += await readFile(path, "utf-8");
        } catch {
          failures.push(`${name}: probedBy names ${file}, which does not exist at ${path}`);
        }
      }
      for (const declared of registryText) corpus = corpus.split(declared).join("");

      const anchors = [...cov.probedBy.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      if (anchors.length === 0) failures.push(`${name}: probedBy quotes no anchor in backticks`);
      for (const anchor of anchors) {
        if (!corpus.includes(anchor)) {
          failures.push(`${name}: anchor \`${anchor}\` not found in ${files.join(", ")}`);
        }
      }
    }

    expect(failures, [
      "The rule: a probedBy must name at least one real file (this file, a src/ test file, or a",
      "repo-relative fixture path), and every backtick-quoted span in it must occur verbatim in a",
      "file it names, with the registry's own declarations excluded so an anchor cannot match",
      "itself. Anchor the probe's substance -- a fixture line, an emitted identifier -- rather than",
      "a test title, so retitling a live probe stays green while deleting the probe goes red.",
    ].join("\n")).toEqual([]);
  });
});

/**
 * The CLI probe, kept here because it is what this file's registry points at for two derivers.
 *
 * `Widget` satisfies every gate the CLI family checked before this was written -- a class, a
 * constructor, `this.options =`, `this.commands =`, `this.tail =` -- while being a settings holder
 * with no `parse()`, no argv handling and no `command`. Every body the family emits calls
 * `_a.parse()`, so it reported both claims as failing.
 */
describe("CLI family declines a class that only looks like a parser", () => {
  const NOT_A_PARSER = [
    "export default class Widget {",
    "  options: Record<string, unknown>;",
    "  commands: Record<string, unknown>;",
    "  tail: string;",
    "  constructor(opts: Record<string, unknown> = {}) {",
    "    this.options = opts;",
    "    this.commands = {};",
    "    this.tail = '';",
    "  }",
    "}",
  ].join("\n");

  const CLAIMS = [
    "- does a declared command consume the first word before flags are processed?",
    "- does a tail argument capture its slot after all flags are consumed?",
  ].join("\n");

  it("leaves its claims pending instead of failing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-cli-probe-"));
    await writeFile(join(dir, "widget.ts"), NOT_A_PARSER);
    await writeFile(join(dir, "widget.lld.md"), `# Widget\n> widget.ts\n\n## Parsing\n\n${CLAIMS}\n`);

    const r = await runAndCheck("widget.lld.md", dir, { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(2);
  }, 60_000);
});

/**
 * The transform probe.
 *
 * Four of that family's scenarios construct the module's default export with argi's option bag and
 * call `.parse()`. Reached through `deriveInline`'s raw-claim path they had no CLI gate at all -- the
 * file's own header asserted both sides of the match were framework-generated, which was not true --
 * so a value mapper with a claim about a replaceable transform map derived a CLI parser test and
 * reported the claim as failing.
 */
describe("transform family declines a module that is not a CLI parser", () => {
  const MAPPER = [
    "export default class Mapper {",
    "  transforms: Record<string, (s: string) => string>;",
    "  constructor(transforms: Record<string, (s: string) => string> = {}) { this.transforms = transforms; }",
    "  apply(kind: string, value: string) { return (this.transforms[kind] ?? ((s: string) => s))(value); }",
    "}",
  ].join("\n");

  it("leaves transform-vocabulary claims pending instead of failing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lldtdd-transform-probe-"));
    await writeFile(join(dir, "mapper.ts"), MAPPER);
    await writeFile(join(dir, "mapper.lld.md"), [
      "# Mapper", "> mapper.ts", "", "## Replaceable transforms", "",
      "- the transform map is replaceable: callers swap the table rather than subclassing",
      "- a rest tail captures whatever the caller did not name",
      "",
    ].join("\n"));

    const r = await runAndCheck("mapper.lld.md", dir, { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(2);
  }, 60_000);
});

/**
 * The CRUD probe.
 *
 * `lld/fixtures/store/` is a `createCRUD` entity sharing only the convention with the one it was
 * written against: its own store, its own collection, and field names (`hullName`, `berth`,
 * `capacity`) that look nothing like a bookmark. The names are the point -- the empty-string-default
 * derivation silently required a url-ish field *and* a name-ish field to be present, so a schema
 * describing identical behaviour under different names derived nothing at all.
 */
describe("CRUD family derives against a second createCRUD consumer", () => {
  it("derives and passes every claim in the fixture", async () => {
    const r = await runAndCheck("lld/fixtures/vessels.lld.md", process.cwd(), { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.passed).toBe(2);
  }, 60_000);
});

/**
 * A createStore collection is a CRUD entity whose store queues its own changes. The first fixture is a
 * store whose changes take turns, declared with typed field specs through a const, so the schema read
 * covers the shape real apps write. The second is the same shape with no queue: its order claim has to
 * fail, which is what shows the check slows a write down rather than passing on timing.
 */
describe("createStore collections derive the CRUD and write-order families", () => {
  it("derives and passes every claim against a queued store", async () => {
    const r = await runAndCheck("lld/fixtures/stock.lld.md", process.cwd(), { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.passed).toBe(4);
  }, 60_000);

  it("fails the write-order claim against a store whose changes don't take turns", async () => {
    const r = await runAndCheck("lld/fixtures/loose.lld.md", process.cwd(), { silent: true, mutate: false });
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(1);
  }, 60_000);
});

/**
 * The membership rule for COMPONENT_PATTERNS, enforced.
 *
 * That file's header states the rule and calls it mechanically checkable -- "if `build` ignores its
 * match argument, the pattern is keyed to one sentence in one codebase and does not belong here" --
 * but nothing checked it, and the ratchet above does not reach inside: it tracks exported deriver
 * *functions*, so a new entry in the COMPONENT_PATTERNS array adds a family without tripping
 * anything. A pattern was added this way that read its match and still shipped a false pass; the rule
 * would not have caught that one, but an example-anchored entry is the failure mode the header names
 * and it is worth the ten lines to make it impossible.
 */
describe("component patterns build from the claim, not from a remembered sentence", () => {
  /** A `build` has two inputs -- the regex match and the module source -- and must consult at least
   *  one. A body that reads neither emits the same lines for every claim and every module, which is
   *  a remembered constant with a regex for a key.
   *
   *  This started as the stricter "must read its match", which is how the COMPONENT_PATTERNS header
   *  words it, and a legitimate pattern broke it within the hour. "Does destroying the TagList remove
   *  its editing interface from the DOM" has nothing to capture: no option name, no delay, no method
   *  -- the claim's whole content is its shape. That pattern reads the module instead, gating and
   *  building its construction from the declaration, and it fires on two unrelated components whose
   *  claims are worded differently. Deriving from the other input is still deriving.
   *
   *  Be clear about what was given up: this no longer catches a pattern that reads the module but
   *  bakes in one project's internals. Nothing mechanical here does. What still backs that is the
   *  second-consumer requirement this file exists for -- every pattern above was probed against a
   *  module it was not written for. */
  const buildsFromAnInput = (build: (...args: never[]) => unknown): boolean => {
    const src = build.toString();
    const arrow = src.indexOf("=>");
    const params = src.slice(0, arrow).replace(/^\s*\(|\)\s*$/g, "")
      .split(",").map(s => s.trim().split(/[:=]/)[0].trim()).filter(Boolean);
    const body = src.slice(arrow + 2);
    // A parameter named with a leading underscore is explicitly declared unused, so it does not count.
    return params.some(p => !p.startsWith("_") && new RegExp(`\\b${p}\\b`).test(body));
  };

  it("holds for every shipped pattern", async () => {
    const { COMPONENT_PATTERNS } = await import("./ast/index.ts");
    const offenders = COMPONENT_PATTERNS
      .map((p, i) => ({ i, test: String(p.test).slice(0, 60), ok: buildsFromAnInput(p.build) }))
      .filter(p => !p.ok);
    expect(offenders).toEqual([]);
  });

  it("and the check has teeth", () => {
    // Without this, the assertion above could be vacuously true forever.
    expect(buildsFromAnInput(((m: string[]) => [m[1]]) as never)).toBe(true);
    expect(buildsFromAnInput(((_m: string[], source: string) => [source]) as never)).toBe(true);
    expect(buildsFromAnInput((() => ["a fixed body"]) as never)).toBe(false);
    expect(buildsFromAnInput(((_m: string[], _source: string) => ["reads neither"]) as never)).toBe(false);
  });
});

/**
 * GRAMMAR.md tells authors which claim vocabularies derive, and it was wrong in both directions.
 *
 * It described a per-project catalog of "named fixtures" -- a mechanism that had been removed -- and
 * listed eight families that do not exist (`hasErrors` against a Form's inputs shape, boolean value
 * to checkbox, newlines to `pre`, a `language-` class, `height: 100%`, "renders without error",
 * `isDirty` after a change). Six of those appear in one real corpus as *pending claims*: the author
 * wrote what the documentation promised would work, and it did not. It also omitted seven families
 * that do ship.
 *
 * A claim vocabulary listed in that file is a promise to whoever writes the next document, so it is
 * checked here rather than trusted. Verifying my own rewrite of that section is what turned up the
 * inline-enum bug fixed in `declaredOptionValues`.
 */
describe("GRAMMAR.md's component vocabularies actually derive", () => {
  const SRC = [
    "/** @param {boolean} [options.disabled] - off",
    "  * @param {boolean} [options.readOnly] - ro",
    "  * @param {string} [options.variant] - v",
    "  * @param {string} [options.label] - l",
    "  * @param {number} [options.lineWidth] - w",
    "  * @param {string} [options.position] - pos",
    "  * @param {boolean} [options.collapsed] - c",
    "  * @param {boolean} [options.autoOpen=true] - open",
    "  * @param {string} [options.tooltip] - tip",
    "  * @param {Function} [options.onSelect] - sel",
    "  * @param {Function} [options.onClose] - close",
    "  * @param {Array<string>} [options.items] - items",
    "  * @param {string} [options.label] - label text */",
    "export default class X extends Y {",
    "  static schema = { disabled:{}, readOnly:{}, variant:{ enum:['a','b'] }, label:{}, lineWidth:{},",
    "    position:{ enum:['top','bottom'] }, collapsed:{}, autoOpen:{default:true}, tooltip:{}, onSelect:{}, onClose:{}, items:{}, label:{} };",
    "  build() { const t = setTimeout(() => this.show(), 200); }",
    "  show() {}",
    "  hide() {}",
    "  render() {}",
    "  isDirty() {}",
    "}",
  ].join("\n");

  /** The "Component UI classes" section, reduced to the first cell of each vocabulary table row.
   *  Parsed out of GRAMMAR.md at test time rather than copied into this file: the hand-copied list
   *  this replaced had already drifted two rows behind the section it claimed to mirror. */
  const GRAMMAR = readFileSync(new URL("../GRAMMAR.md", import.meta.url), "utf-8");
  const HEADING = "\n### Component UI classes\n";
  const headingAt = GRAMMAR.indexOf(HEADING);
  if (headingAt < 0) {
    throw new Error(
      "GRAMMAR.md no longer has a '### Component UI classes' heading. This test derives its " +
      "vocabulary list from that section; if the section was renamed or restructured, update the " +
      "parse here to follow it rather than letting the ratchet go silently green.",
    );
  }
  const afterHeading = GRAMMAR.slice(headingAt + HEADING.length);
  const nextHeading = afterHeading.indexOf("\n### ");
  const section = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading);

  const rows = section.split("\n")
    .filter(line => line.startsWith("|"))
    .filter(line => !/^\|\s*Claim vocabulary\s*\|/i.test(line) && !/^\|[\s|-]+\|?$/.test(line))
    .map(line => line.replace(/^\|/, "").split(/(?<!\\)\|/)[0]!
      .replace(/\\\|/g, "|").replace(/[`"]/g, "").replace(/\s+/g, " ").trim());
  if (rows.length === 0) {
    throw new Error(
      "The 'Component UI classes' section of GRAMMAR.md contains no vocabulary table rows. If its " +
      "tables became something else, update the parse here so this ratchet keeps deriving its " +
      "list from the section instead of going silently green.",
    );
  }

  const KEYING =
    "PROBES is keyed by a row's first cell, normalized: backticks and double quotes stripped, " +
    "escaped pipes unescaped, whitespace collapsed.";

  /** One concrete claim per documented vocabulary row, phrased against SRC's declared options so
   *  the derivation has something real to read. Rewording a row in GRAMMAR.md changes what the
   *  file promises, so it re-keys the row here and the new promise must be re-verified. */
  const PROBES: Record<string, { claim: string; parent?: string }> = {
    "does isDirty return false when the value matches the initial value":
      { claim: "does isDirty return false when the value matches the initial value" },
    "does a X have isReady / reset()":
      { claim: "does a X have isDirty" },
    "the disabled attribute is set on the element":
      { claim: "the disabled attribute is set on the element" },
    "constructing an Elem with an id option sets the element's id property":
      { claim: "constructing a X with a tooltip option sets the element's tooltip property" },
    "an invalid variant value throws / there are N valid variant values; anything else throws":
      { claim: "an invalid variant value throws" },
    "does a Link with variant: 'button' remain an anchor element":
      { claim: "does a Link with variant 'button' remain an anchor element" },
    "does a readOnly Select contain no input element":
      { claim: "does a readOnly Select contain no input element" },
    "does a X with lineWidth 10 have a higher blur than one with lineWidth 2":
      { claim: "does a X with lineWidth 10 have a higher blur than one with lineWidth 2" },
    "does a Page element have height: 100% applied at construction":
      { claim: "does a X element have height: 100% applied at construction?" },
    "does each radio input in the group share the same name attribute":
      { claim: "does each option input in the group share the same name attribute?" },
    "does a List render a mix of string and object items without failing":
      { claim: "does a X render a mix of string and object items without failing?" },
    "does code with newlines render as a block (pre)":
      { claim: "does label with newlines render as a block (pre) rather than inline?" },
    "does the language option add an identifiable class": {
      claim: "does the variant option add an identifiable class to the element?",
      parent: "the `variant` option adds a `variant-{name}` class; tooling targets it by convention",
    },
    "changing position from top leaves only the new class":
      { claim: "changing position from top leaves only bottom class" },
    "setting collapsed: true hides the panel / setting openOnRender: false prevents ...":
      { claim: "setting collapsed: true hides the panel" },
    "does updating the label option change the label's content without replacing its structure":
      { claim: "does updating the label option change the label's content without replacing the label's structure" },
    "does calling render() twice leave exactly one copy":
      { claim: "does calling render() twice leave exactly one copy of the built structure" },
    "autoOpen: true queues show() after 200ms":
      { claim: "`autoOpen: true` queues `show()` after 200ms" },
    "does hovering for longer than 700ms show the tooltip":
      { claim: "does hovering for longer than 700ms show the tooltip?" },
    "does leaving before 700ms prevent the tooltip from appearing":
      { claim: "does leaving before 700ms prevent the tooltip from appearing?" },
    "does clicking a menu item invoke onSelect / pressing Enter on a focused item / hovering / typing":
      { claim: "does clicking a menu item invoke onSelect?" },
    "does calling hide() invoke the onClose callback":
      { claim: "does calling hide() invoke the onClose callback?" },
    "does destroying the wrapper also remove the tooltip from the DOM":
      { claim: "does destroying the wrapper also remove the tooltip from the DOM?" },
  };

  it.each(rows)("%s", async row => {
    const probe = PROBES[row];
    if (!probe) {
      throw new Error(
        `GRAMMAR.md documents a component vocabulary this test does not probe:\n  ${row}\n` +
        `Add a PROBES entry with a claim in that vocabulary that derives against SRC. ${KEYING}`,
      );
    }
    const { deriveComponentInline } = await import("./ast/index.ts");
    expect(deriveComponentInline(probe.claim, SRC, probe.parent)).not.toBeNull();
  });

  it("probes nothing the section no longer documents", () => {
    const documented = new Set(rows);
    const stale = Object.keys(PROBES).filter(key => !documented.has(key));
    expect(stale,
      "Each PROBES key must be a current row of GRAMMAR.md's Component UI classes tables. " + KEYING +
      " A key listed here matches no row: the row was removed or reworded, so drop or re-key its probe.",
    ).toEqual([]);
  });

  it("derives the perspective-context contract the section's prose promises", async () => {
    expect(section.includes("**Reading the claim above**"),
      "The 'Reading the claim above' block is gone from GRAMMAR.md's Component UI classes section. " +
      "It promised that a perspective inherits vocabulary from its parent claim; if the promise " +
      "moved, follow it here, and if it was dropped, drop this probe with it.",
    ).toBe(true);
    const { deriveComponentInline } = await import("./ast/index.ts");
    expect(deriveComponentInline(
      "does the Tooltip component exist after construction with a tooltip option?", SRC,
      "the Tooltip is built during render; after construction it exists as `this._tooltip`",
    )).not.toBeNull();
  });
});
