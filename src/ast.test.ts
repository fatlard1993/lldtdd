import { describe, it, expect } from "bun:test";
import {
  deriveComponentInline, deriveEventTargetInline, deriveInline,
  deriveHttpClientInline, isCachingFetchClient, resetHttpClientUrls,
  extractFactsFromSource,
} from "./ast/index.ts";
import { deriveStyledFactoryInline, isComponentClassFactory } from "./ast/patterns/factory.ts";
import { declaredConstructorOptions } from "./ast/declaredOptions.ts";

/**
 * Regression matrix for the claim-text → inline-code pattern catalogs.
 *
 * These catalogs bit two silent regressions in one session before this file existed:
 * merging two exclusive-class patterns broke against a real validated-enum option (a
 * generic placeholder value threw instead of testing the class switch), and two
 * "setting X: ..." patterns collided via JS's leftmost-match regex semantics, silently
 * producing wrong-but-still-passing generated code. Both were only caught by testing
 * every existing claim's *exact* output, not just whether something matched.
 *
 * Snapshot testing on purpose: hand-writing the expected code blocks would be its own
 * source of transcription bugs. Run `bun test --update-snapshots` after a deliberate
 * pattern change and diff the snapshot file -- an unreviewed diff there is the signal
 * something drifted.
 *
 * This matrix used to carry ~40 component claims, most of them example-anchored against one
 * private component library via a project catalog. That mechanism is gone (see the header of
 * src/ast/patterns/component.ts for why), so the matrix now covers exactly what ships: the
 * structural patterns, each of which reads its capture groups out of the claim and generalizes to
 * a component it has never seen. Every claim below is here because a built-in pattern derives from
 * it -- if a change drops one to null, that is a real regression in shipped behavior, not a corpus
 * that wandered off.
 */

describe("deriveComponentInline", () => {
  const claims = [
    "the disabled attribute is set on the element",
    "changing position from top leaves only bottom class",
    "changing variant from a to b leaves only new class",
    "an invalid variant value throws",
    // Interaction-to-callback claims are absent here because they need the module: a callback the
    // component does not declare produces a spy that never fires, and a component built without its
    // declared options renders nothing to interact with. They are covered in "driven-DOM patterns"
    // below, where a source is supplied.
    "does a Whiteboard with lineWidth 10 have a higher blur than one with lineWidth 2",
    "does a Link with variant 'button' remain an anchor element",
    "does a readOnly Select contain no input element",
    "element had icon 'star' and was updated to 'heart' have only heart icon",
    "setting collapsed: true hides the panel",
    "setting collapsed: false shows the panel",
    "does setting openOnRender: false prevent the dialog from opening on its own",
    "does a popover with autoOpen not open synchronously on construction",
    "constructing an Elem with an `id` option set the underlying element's `id` property to that value",
    "completely unrelated claim with no match at all",
  ];

  for (const claim of claims) {
    it(`matches: ${claim}`, () => {
      expect(deriveComponentInline(claim)).toMatchSnapshot();
    });
  }
});

describe("deriveEventTargetInline", () => {
  // A class with the whole reactive-context API. Passing it explicitly is the point: the family is
  // gated on these, so a matrix that omitted them would be asserting against the gate rather than
  // against the patterns.
  const fullyCapable = {
    name: "Context", hasSubscribe: true, hasDestroy: true, hasIsDestroyed: true, hasBatch: true,
  };

  const claims = [
    "does a subscriber fire before the next line of code executes",
    "does a subscriber for one key not fire when a different key changes",
    "does the subscriber receive the new value as its argument",
    "does addEventListener work as a subscription path",
    "do subscriptions stop firing after destroy()",
    "does assigning the same value as the current one not call subscribers",
    "does a listener added with `{ once: true }` fire only once",
    "does a listener added with `{ signal }` stop when the signal aborts",
    "does the subscriber receive the parser's output rather than the raw value",
    "does a throwing parser not crash the application",
    "does the subscription continue receiving updates after a parser error",
    "does the callback fire when any listed key changes",
    "does it receive a snapshot of all listed key values",
    "does it fire once when multiple listed keys change inside a batch",
    "is isDestroyed true after destroy",
    "does calling destroy a second time not reactivate",
    "does constructing with null throw",
    "does constructing with an array throw",
    "does constructing with a plain object succeed",
    "completely unrelated claim with no match at all",
  ];

  for (const claim of claims) {
    it(`matches: ${claim}`, () => {
      expect(deriveEventTargetInline(claim, fullyCapable)).toMatchSnapshot();
    });
  }

  /**
   * The gate, which was accepted as an argument and then ignored. Every pattern above emits calls
   * into a reactive-context API that `extends EventTarget` does not imply, so without this a plain
   * `class Counter { increment() {} }` with a claim mentioning "subscriber" derived
   * `_ctx.subscribe({ key, callback })` and reported the claim as **failing**. Pending is the
   * truthful state for a claim no family can reach.
   */
  it("declines a module that is not an EventTarget subclass", () => {
    expect(deriveEventTargetInline("does a subscriber fire before the next line of code executes", undefined)).toBeNull();
  });

  it.each([
    ["hasSubscribe", "does a subscriber fire before the next line of code executes"],
    ["hasDestroy", "do subscriptions stop firing after destroy()"],
    ["hasIsDestroyed", "is isDestroyed true after destroy"],
    ["hasBatch", "does it fire once when multiple listed keys change inside a batch"],
  ] as const)("declines when the class lacks %s", (missing, claim) => {
    // Sanity: the claim resolves for a fully capable class, so a null below is the gate and not a
    // pattern that simply never matched.
    expect(deriveEventTargetInline(claim, fullyCapable)).not.toBeNull();
    expect(deriveEventTargetInline(claim, { ...fullyCapable, [missing]: false })).toBeNull();
  });
});

/**
 * resolveCliClassPatterns checked /zero exit code/i before /non-zero exit code/i -- "zero exit
 * code" is a literal substring of "non-zero exit code", so a real claim about a non-zero exit
 * code was silently resolving through the zero-exit branch and asserting against `-h` (which
 * legitimately exits 0), never exercising the unknown-flag case the claim actually described.
 * Fixed by checking the more specific ("non-zero") condition first. This locks the fix in place.
 *
 * Kept from the deleted collision-audit test file: the bug it pins is in a shipped built-in
 * pattern and has nothing to do with the project-catalog mechanism that file existed to audit.
 */
describe("CLI class-pattern exit-code substring collision (regression)", () => {
  // A parser, not merely a class that assigns `this.options`. The `parse()` method is required now:
  // every body this family emits calls it, and a fixture without one was claiming coverage for a
  // module the family can no longer derive against -- the same under-specification the gate exists
  // to catch, sitting in the test that pins the family.
  const facts = {
    constructorModulePath: "/fake/cli.js",
    source: [
      "class Foo {",
      "  constructor() { this.options = {}; }",
      "  parse(options) { return this.options; }",
      "}",
    ].join("\n"),
    schemas: [],
  } as any;

  it("a non-zero-exit-code claim resolves to the unknown-flag scenario, not the zero-exit scenario", () => {
    const result = deriveInline("does an unknown flag produce a non-zero exit code?", facts);
    expect(result?.inspectCode).toContain("--unknown-xyz");
    expect(result?.inspectCode).toContain("toBe(1)");
  });

  it("a zero-exit-code claim still resolves to its own scenario, unaffected by the reorder", () => {
    const result = deriveInline("does `--help` produce a zero exit code?", facts);
    expect(result?.inspectCode).toContain("--help");
    expect(result?.inspectCode).toContain("toBe(0)");
  });
});

/**
 * The caching-fetch-client family, gated on structure rather than on a project's name.
 *
 * The gate is the whole safety mechanism: this family emits calls to `Subject.GET(...)`, so it must
 * not fire for a module that merely mentions `fetch`. It requires both exported HTTP-verb functions
 * and a result shape carrying network state (`isFetching`) alongside a data-state union -- together
 * the signature of the niche, individually far too common to key on.
 *
 * These are the patterns that replaced 13 example-anchored ones deleted with the project catalogs.
 * The difference is where the identifiers come from: the verb in the emitted call is read off the
 * module's own exports, so a client that exports only `GET` and `PUT` is tested through those.
 */
describe("deriveHttpClientInline", () => {
  const CLIENT_SOURCE = [
    "const makeResult = () => ({ status: 'idle', isFetching: false, body: null });",
    "// states: 'idle' | 'loading' | 'success' | 'error'",
    "export const { GET, POST, PUT } = createClient();",
  ].join("\n");

  const facts = (source: string) => ({ source, schemas: [] }) as any;

  it("recognizes a module with HTTP verbs and a fetch-result shape", () => {
    expect(isCachingFetchClient(facts(CLIENT_SOURCE))).toBe(true);
  });

  it("does not fire for a module that merely uses fetch", () => {
    // No verb exports and no result shape -- emitting `Subject.GET(...)` here would be a
    // generated-code error, so the gate has to reject it rather than derive optimistically.
    const plain = "export async function load(url) { return (await fetch(url)).json(); }";
    expect(isCachingFetchClient(facts(plain))).toBe(false);
    expect(deriveHttpClientInline("does a 2xx response produce a status of success?", facts(plain))).toBeNull();
  });

  it("does not fire for verb exports without the result shape", () => {
    // A thin request wrapper exports the same verbs but promises none of this vocabulary.
    const thin = "export const { GET, POST } = makeThinWrapper();";
    expect(isCachingFetchClient(facts(thin))).toBe(false);
  });

  it("reads the verb from the module rather than assuming GET", () => {
    // A client exposing only PUT must be tested through PUT -- the whole point of gating on
    // structure is that the emitted identifiers come from the module.
    const putOnly = [
      "const r = { status: 'idle', isFetching: false };",
      "// 'loading' 'success' 'error'",
      "export const PUT = (url, options = {}) => request(url, { method: 'PUT', ...options });",
    ].join("\n");
    const derived = deriveHttpClientInline("does a request with enabled: false report an idle status?", facts(putOnly));
    expect(derived?.inspectCode).toContain("Subject.PUT(");
    expect(derived?.inspectCode).not.toContain("Subject.GET(");
  });

  it("gives each derived test its own URL so cache entries cannot collide", () => {
    resetHttpClientUrls();
    const a = deriveHttpClientInline("does enabled: false report an idle status?", facts(CLIENT_SOURCE));
    const b = deriveHttpClientInline("does enabled: false report an idle status?", facts(CLIENT_SOURCE));
    const urlOf = (code?: string) => code?.match(/https:\/\/[^"]+/)?.[0];
    expect(urlOf(a?.inspectCode)).not.toBe(urlOf(b?.inspectCode));
  });

  it.each([
    ["does a request with enabled: false report an idle status?", 'toBe("idle")'],
    ["does a request with enabled: false leave the response empty, having never fetched?", "_fetchCount).toBe(0)"],
    ["does a 2xx response end with a status of success?", 'toBe("success")'],
    ["does isFetching settle back to false once a request completes?", "isFetching).toBe(false)"],
    ["A GET request hits the network once; subsequent identical calls serve from cache", "_fetchCount).toBe(1)"],
    ["A POST request is never served from cache; each call hits the network", "_fetchCount).toBe(2)"],
  ])("derives a checkable assertion for: %s", (claim, expected) => {
    expect(deriveHttpClientInline(claim, facts(CLIENT_SOURCE))?.inspectCode).toContain(expected);
  });

  it("returns null for a claim outside the family's vocabulary", () => {
    expect(deriveHttpClientInline("the module is well factored", facts(CLIENT_SOURCE))).toBeNull();
  });
});

/**
 * The factory families are gated on a source regex naming an export -- `export const styled =`,
 * `export function derive(` -- but every pattern in them constructs the result and reads instance
 * properties off it. Exporting the name does not make a module that kind of factory.
 *
 * A one-line class-name joiner called `styled` matched the old gate and reported its claim
 * **failing**, which is the mirror of a false pass: the run said the implementation disagreed with
 * its design document when this family never applied. Pending is the truthful state.
 */
describe("factory family gates", () => {
  const COMPONENT_FACTORY = [
    "export const styled = function (BaseComponent, styles = () => '') {",
    "  return class ConfiguredComponent extends BaseComponent {}",
    "};",
  ].join("\n");

  const NOT_A_FACTORY = `export const styled = (...names) => names.join(" ");`;
  const claim = "two separate calls to styled() with the same base class produce different scope classes";

  it("recognizes a styled export that returns a class", () => {
    expect(isComponentClassFactory(COMPONENT_FACTORY)).toBe(true);
  });

  it("rejects a styled export that returns something else", () => {
    expect(isComponentClassFactory(NOT_A_FACTORY)).toBe(false);
  });

  it("derives for a real component factory and declines for a namesake", () => {
    expect(deriveStyledFactoryInline(claim, COMPONENT_FACTORY)).not.toBeNull();
    expect(deriveStyledFactoryInline(claim, NOT_A_FACTORY)).toBeNull();
  });

  /**
   * The `derive()` family is safe here for an incidental reason rather than a checked one: its
   * emitted code needs a constructible `_SubjectCtor`, which a plain function module has no default
   * export for, so the case cannot run and lands on pending. This pins that outcome -- if the family
   * ever gains a pattern that does not need the constructor, this is where the false failure shows
   * up instead of in someone's build.
   */
  it("leaves a namesake derive() export pending rather than failing it", async () => {
    const { runAndCheck } = await import("./run.ts");
    const { mkdtemp, writeFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = await mkdtemp(join(tmpdir(), "lldtdd-derive-"));
    await writeFile(join(dir, "m.ts"), "export function derive(base: number, exp: number) { return base ** exp; }\n");
    await writeFile(join(dir, "m.lld.md"),
      "# M\n> m.ts\n\n## Recomputation\n\n- does a derived value recompute only when a value its selector reads changes?\n");

    const r = await runAndCheck("m.lld.md", dir, { silent: true, mutate: false });
    expect(r.failed).toBe(0);
    expect(r.pending).toBe(1);
  }, 60_000);
});

/**
 * Two built-in component patterns were producing false *failures* -- a claim reported as disagreeing
 * with its implementation when the derived test was not a test of that claim.
 *
 * Both were masked until the project catalogs were deleted: a higher-priority example-anchored
 * pattern used to win for the two components involved, so the generic fallbacks never ran against
 * them. Removing the catalog is what exposed the fallbacks, and in one case the header comment in
 * component.ts had predicted the exact failure years before it could happen.
 */
describe("component patterns decline rather than derive a test of something else", () => {
  const TOOLTIP_LIKE = [
    "const position_enum = Object.freeze(['center', 'top', 'bottom', 'left', 'right']);",
    "static schema = { position: { default: 'topRight', enum: position_enum, set() {} } };",
  ].join("\n");

  const claim = "changing position from one value to another leaves only the new position class active";

  it("probes a validated option with values it actually accepts", () => {
    // "from one value to another" is generic wording. Handing the literal strings
    // "valueA"/"valueB" to an option that throws on anything outside its enum tests the
    // validator instead of the class switch, and fails against a correct implementation.
    const code = deriveComponentInline(claim, TOOLTIP_LIKE)?.inspectCode ?? "";
    expect(code).toContain('"center"');
    expect(code).toContain('"top"');
    expect(code).not.toContain("valueA");
  });

  it("still uses a placeholder when the option declares no allowed set", () => {
    // Nothing will reject an arbitrary value here, so the generic probe is fine and the claim
    // stays derivable.
    const code = deriveComponentInline(claim, "static schema = { position: { default: 'x' } };")?.inspectCode ?? "";
    expect(code).toContain("valueA");
  });

  it("declines when a declared set is too small to switch between", () => {
    const oneValue = "static schema = { position: { enum: ['only'] } };";
    expect(deriveComponentInline(claim, oneValue)).toBeNull();
  });

  it("declines an interaction claim when the module is not available to read", () => {
    // Without the module there is no way to know the component declares this callback, and no way to
    // build it the way its author intended. Both were guessed at once, and the guess is what let a
    // claim about clicking a menu item pass against a Menu with no items in it.
    expect(deriveComponentInline("does pressing Enter on a focused menu item invoke onSelect?")).toBeNull();
    expect(deriveComponentInline("does pressing Enter invoke onSubmit")).toBeNull();
  });
});

/**
 * Inline creation: "adding a bookmark can create a new category in the same operation".
 *
 * The whole content of such a claim is that a `beforeCreate` hook consumed the nested spec and put a
 * reference to the created record in its place. The derived assertion was `expect(r.X).toBeDefined()`,
 * which cannot fail for that: a write path that ignores the hook copies the spec straight through,
 * and an object is defined. The one thing the claim was about was the one thing unchecked -- and it
 * was the only derivation the sole consumer of this family relied on.
 */
describe("inline-creation derivation asserts the hook actually ran", () => {
  const facts = {
    source: "createCRUD('bookmarks', ['name','url','category'], { async beforeCreate(entry, data) {} })",
    schemas: [{
      collection: "bookmarks",
      fields: ["name", "url", "category"],
      hooks: [{ kind: "beforeCreate", trigger: "data.category?.create" }],
    }],
  } as any;

  const derived = () => deriveInline("adding a bookmark can create a new category in the same operation", facts);

  it("checks that the nested spec was replaced, not merely that the field exists", () => {
    const code = derived()?.inspectCode ?? "";
    expect(code).toContain("not.toEqual");
    // The spec it passes in is the thing the result must no longer equal.
    expect(code).toContain('{"create":{"name":"Test"}}');
  });

  it("still passes the inline spec as the argument, so the hook has something to consume", () => {
    expect(derived()?.callArgs?.[0]).toMatchObject({ category: { create: { name: "Test" } } });
  });

  it("declines when the module declares no matching beforeCreate hook", () => {
    // Without the hook there is no inline creation to describe, so deriving anything would be a
    // guess about behaviour the module does not have.
    const noHook = { ...facts, schemas: [{ ...facts.schemas[0], hooks: [] }] };
    expect(deriveInline("adding a bookmark can create a new category in the same operation", noHook)).toBeNull();
  });
});

/**
 * Instance-state patterns: the claim supplies the expectation, the module supplies the mechanism.
 *
 * That split is what makes these derivable at all. Reading an expectation *out of* an implementation
 * is tautological -- derive "render() appends" from a render() that appends and it passes against a
 * double-append bug. Here the author has already said what the answer must be, so the derivation only
 * has to know how to ask, and the test can still be wrong about the code.
 */
describe("instance-state patterns", () => {
  const GETTER = "export default class W { get isDirty() { return false; } }";
  const METHOD = "export default class W {\n  hasErrors(options) { return false; }\n}";

  it("reads a getter as a property and a method as a call", () => {
    // A claim names the member, not its shape. Guessing wrong reads a method as a property, yields
    // the function, and `expect(fn).toBe(false)` fails against perfectly correct code -- a failure
    // the author cannot act on because nothing is actually broken.
    expect(deriveComponentInline("does isDirty return false when the value matches the initial value?", GETTER)?.inspectCode)
      .toContain("_inst.isDirty)");
    expect(deriveComponentInline("does hasErrors return false when all inputs are valid?", METHOD)?.inspectCode)
      .toContain("_inst.hasErrors())");
  });

  it("only derives a condition a fresh construction can produce", () => {
    // "false when the value matches the initial value" describes an instance straight from the
    // constructor. "true after the value has been changed" does not, and deriving it anyway would
    // assert the opposite of the truth against a correct implementation.
    expect(deriveComponentInline("does isDirty return false when the value matches the initial value?", GETTER)).not.toBeNull();
    expect(deriveComponentInline("does isDirty return true after the value has been changed?", GETTER)).toBeNull();
    expect(deriveComponentInline("does hasErrors return true when an input's validation fails?", METHOD)).toBeNull();
  });

  it("checks a member exists when that is all the claim says", () => {
    const code = deriveComponentInline("does a Select have isDirty?", GETTER)?.inspectCode ?? "";
    expect(code).toContain('toHaveProperty("isDirty")');
  });

  it("compares a repeated call against the first, not against a hardcoded count", () => {
    // "exactly one copy" is about the second call adding nothing, which holds for a component whose
    // build produces any number of children -- so the assertion must not bake in a number.
    const code = deriveComponentInline("does calling render() twice leave exactly one copy of the built structure, not two?")?.inspectCode ?? "";
    expect(code).toContain("_inst.render();");
    expect(code).toContain("_afterFirst");
    expect(code).not.toMatch(/toBe\(1\)/);
  });
});

/**
 * Driven-DOM patterns: claims about what an interaction or a delay makes a component do.
 *
 * These were unreachable until the runner could mount a component and drive it. The blocker turned
 * out not to be the clock but the mount -- and specifically one missing tick, since connection is
 * commonly detected with a `MutationObserver` whose callbacks arrive as microtasks. Reading state
 * straight after `appendChild` sees a component that has not yet noticed it is in the document,
 * which is why an earlier attempt concluded, wrongly, that connection lifecycles could not be
 * triggered at all.
 */
describe("driven-DOM patterns", () => {
  const SCHEDULES = [
    "/** @param {boolean} [options.autoOpen=true] - open on render */",
    "export default class P {",
    "  static schema = { autoOpen: { default: true } };",
    "  build() { const id = setTimeout(() => this.show(), 200); }",
    "  show() {}",
    "}",
  ].join("\n");

  it("derives a scheduling probe that watches the method the claim names", () => {
    const code = deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", SCHEDULES)?.inspectCode ?? "";
    expect(code).toContain("withMountedComponent");
    expect(code).toContain("autoOpen: true");
    // Both halves of "after 200ms": still not called one tick short, called once the tick lands.
    expect(code).toContain("d.advance(199)");
    expect(code).toContain("d.advance(1)");
    expect(code).toContain('_proto["show"]');
  });

  it("counts calls against a baseline rather than against zero", () => {
    // A component may legitimately call the same method while starting up. Asserting the deferred
    // call happened means asserting it happened *in addition*, so a method that also runs during
    // construction does not read as the scheduled one.
    const code = deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", SCHEDULES)?.inspectCode ?? "";
    expect(code).toContain("expect(_sched.after).toBeGreaterThan(_sched.justBefore)");
  });

  it("declines when the module never defines the method the claim names", () => {
    // The probe watches that method, and a name the module does not define cannot be watched -- it
    // would reach codegen as an undefined spy target and die with a TypeError, which reads as a
    // broken tool rather than as the claim/code disagreement it is.
    const noMethod = SCHEDULES.replace("  show() {}\n", "");
    expect(deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", noMethod)).toBeNull();
  });

  it("derives, rather than declining, when the module schedules some other delay", () => {
    // Gating derivation on finding `setTimeout(…, 200)` in the source would leave a component
    // that waits the wrong amount of time as pending: the disagreement the claim exists to
    // catch, hidden. Watching the method instead makes the wait itself observable, so the
    // mismatch can be derived and then honestly fail.
    const slow = SCHEDULES.replace("200);", "500);");
    expect(deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", slow)).not.toBeNull();
  });

  it("builds the probe from the component's whole declared surface", () => {
    // An option-driven component left half-configured behaves differently from one a caller would
    // create, so the claim's own option goes on top of everything the declaration provides.
    const code = deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", SCHEDULES)?.inspectCode ?? "";
    expect(code).toMatch(/\{ \.\.\.\{.*\}, autoOpen: true \}/);
  });

  const CALLBACK = [
    "/** @param {Function} [options.onSelect] - fired when an item is chosen",
    "  * @param {Array<string>} [options.items] - the items */",
    "export default class M {",
    "  static schema = { items: { set() {} }, onSelect: {} };",
    "}",
  ].join("\n");

  it("derives a callback probe from the interaction and the callback the claim names", () => {
    const code = deriveComponentInline("does clicking a menu item invoke onSelect?", CALLBACK)?.inspectCode ?? "";
    expect(code).toContain("onSelect: () => { _fired++; }");
    expect(code).toContain("await d.click(_t);");
    expect(code).toContain("expect(_cb.after).toBeGreaterThan(_cb.before)");
  });

  it("puts focus on the target only when the claim asks for a focused one", () => {
    // "on a focused menu item" is not decoration -- Menu ignores Enter unless activeElement is one of
    // its items. A claim that does not mention focus gets no focus call, because moving focus is
    // itself an interaction and doing it uninvited tests something the claim did not describe.
    const focused = deriveComponentInline("does pressing Enter on a focused menu item invoke onSelect?", CALLBACK)?.inspectCode ?? "";
    expect(focused).toContain("_t.focus?.()");
    expect(focused).toContain('await d.press("Enter", _t);');

    const plain = deriveComponentInline("does clicking a menu item invoke onSelect?", CALLBACK)?.inspectCode ?? "";
    expect(plain).not.toContain("focus");
  });

  it("aims at a rendered child rather than the component's own element", () => {
    // Events bubble, so a child exercises its own handler and every handler on the root; the root
    // exercises only the root's. Aiming at the root let "clicking a menu item" pass against a Menu
    // that had rendered no items at all.
    const code = deriveComponentInline("does clicking a menu item invoke onSelect?", CALLBACK)?.inspectCode ?? "";
    expect(code).toContain("firstElementChild");
  });

  it("derives the negative claim with the same probe and the opposite expectation", () => {
    // A component that fires its callback unconditionally satisfies every positive claim anyone can
    // write about it, so the negative half is the half that pins the contract.
    const CB = [
      "/** @param {Function} [options.onClose] - dismissed */",
      "export default class S {",
      "  static schema = { onClose: {} };",
      "  show() {}",
      "  hide() {}",
      "}",
    ].join("\n");
    const positive = deriveComponentInline("does calling show() then hide() invoke the onClose callback?", CB)?.inspectCode ?? "";
    const negative = deriveComponentInline("does calling hide() on an already-closed sheet leave onClose uninvoked?", CB)?.inspectCode ?? "";

    expect(positive).toContain("expect(_cb.after).toBeGreaterThan(_cb.before)");
    expect(negative).toContain("expect(_cb.after).toBe(_cb.before)");
    // A claim naming the call that establishes the state runs both, in order.
    expect(positive.indexOf(".show()")).toBeLessThan(positive.indexOf(".hide()"));
    // And the negative names only one, so only one runs.
    expect(negative).not.toContain(".show()");
  });

  it("declines when the module never declares the callback the claim names", () => {
    // Passing an option a component ignores means a spy that never fires, which reads as a broken
    // implementation rather than as the pattern reaching for something the module never offered.
    const noCb = [
      "/** @param {Array<string>} [options.items] - the items */",
      "export default class M {",
      "  static schema = { items: { set() {} } };",
      "}",
    ].join("\n");
    expect(deriveComponentInline("does clicking a menu item invoke onSelect?", noCb)).toBeNull();
  });

  it("builds a list option with an element in it, not an empty list", () => {
    // An empty array is well-typed and still wrong: it is the one state where a list-rendering
    // component renders nothing, so a claim about what it renders gets answered by the empty case.
    const code = deriveComponentInline("does clicking a menu item invoke onSelect?", CALLBACK)?.inspectCode ?? "";
    expect(code).toContain('items: ["lld"]');
  });

  it("declines when the module does not declare enough to construct it", () => {
    // An option with no default, no enum and no JSDoc type cannot be valued. Probing a
    // half-built instance would report the claim false against a correct implementation.
    const untyped = SCHEDULES.replace("/** @param {boolean} [options.autoOpen=true] - open on render */", "")
      .replace("static schema = { autoOpen: { default: true } };", "static schema = { autoOpen: { set(v) {} }, mystery: { set(v) {} } };");
    expect(deriveComponentInline("`autoOpen: true` queues `show()` after 200ms", untyped)).toBeNull();
  });
});

/**
 * Reading a component's own declaration of its options.
 *
 * A probe that needs to drive a component needs it built the way its author intended, and the module
 * is the only trustworthy account of that. Three conventions carry it -- a runtime `static schema`,
 * JSDoc `@param` lines, and a TypeScript type -- and a component has no reason to use more than one.
 */
describe("declaredConstructorOptions", () => {
  it("reads a TypeScript component's options type", () => {
    // Reading only JSDoc and `static schema` made every TS component look undeclared, which left
    // this project's own example component unable to derive its interaction claim.
    const ts = [
      "export default class Toggle {",
      "  options: { label?: string; count?: number; onPress?: (v: boolean) => void };",
      "}",
    ].join("\n");
    const { optionsCode, unresolved } = declaredConstructorOptions(ts);
    expect(unresolved).toEqual([]);
    expect(optionsCode).toContain('label: "lld"');
    expect(optionsCode).toContain("count: 1");
    // A function type has to survive as code -- serialising it would drop it silently.
    expect(optionsCode).toContain("onPress: () => {}");
  });

  it("leaves a boolean alone unless the module states its default", () => {
    // Both of a boolean's values are meaningful, so picking one picks a behaviour mode. Building a
    // Toggle with `disabled: true` because its type said boolean produced a component that correctly
    // ignored every interaction, and the claim about interacting with it failed against working code.
    const ts = "export default class T { options: { disabled?: boolean }; }";
    expect(declaredConstructorOptions(ts).optionsCode).not.toContain("disabled");

    const stated = "/** @param {boolean} [options.disabled=true] - off */\nstatic schema = { disabled: {} };";
    expect(declaredConstructorOptions(stated).optionsCode).toContain("disabled: true");
  });

  it("treats an option the module marks optional as omittable, not as a blocker", () => {
    // One optional slot naming a class nothing can invent must not disqualify the whole
    // component; that sends a claim about a fully declared callback to pending over an option
    // the test never needed.
    const src = [
      "/** @param {Component} [options.ItemComponent] - custom renderer",
      "  * @param {Function} [options.onSelect] - chosen */",
      "static schema = { ItemComponent: {}, onSelect: {} };",
    ].join("\n");
    const { optionsCode, unresolved } = declaredConstructorOptions(src);
    expect(unresolved).toEqual([]);
    expect(optionsCode).not.toContain("ItemComponent");
    expect(optionsCode).toContain("onSelect: () => {}");
  });

  it("keeps a union inside a generic together", () => {
    // `Array<string|object>` is one list type. Splitting on every `|` yields `Array<string` and
    // `object>`, neither of which is a type, so the option resolved to nothing and took its whole
    // component out of reach -- Table stopped being constructible the moment lists started carrying
    // an element.
    const src = "/** @param {Array<string|object>} options.columns - column defs */\nstatic schema = { columns: {} };";
    const { optionsCode, unresolved } = declaredConstructorOptions(src);
    expect(unresolved).toEqual([]);
    expect(optionsCode).toContain('columns: ["lld"]');
  });

  it("still blocks on a required option it cannot type", () => {
    // No brackets means required, and omitting it is a guess about what the component tolerates.
    const src = "/** @param {Component} options.renderer - required */\nstatic schema = { renderer: {} };";
    expect(declaredConstructorOptions(src).unresolved).toEqual(["renderer"]);
  });
});

/**
 * Deferred visibility driven by an interaction, rather than by an option.
 *
 * Probed against a synthetic component that shares nothing with the one these were written for --
 * different option names, a different threshold, a different interaction -- because a pattern that
 * only ever runs against its originating module is a lookup table wearing a regex.
 */
describe("interaction-held-past-a-threshold patterns", () => {
  const PANEL = [
    "/** @param {string} [options.hint] - hint text */",
    "export default class Panel {",
    "  static schema = { hint: {} };",
    "  build() { this.on({ targetEvent: 'pointerover', callback: () => setTimeout(() => this.reveal(), 250) }); }",
    "  reveal() {}",
    "}",
  ].join("\n");

  it("reads the threshold and the interaction out of the claim", () => {
    const code = deriveComponentInline("does hovering for longer than 250ms show the hint?", PANEL)?.inspectCode ?? "";
    expect(code).toContain("await d.hover()");
    // Both halves of "longer than": nothing yet one tick short, something once the tick lands.
    expect(code).toContain("d.advance(249)");
    expect(code).toContain("d.advance(1)");
    expect(code).toContain("expect(_hold.after).not.toBe(_hold.before)");
  });

  it("compares a cancelled run against an allowed one on the same instance", () => {
    // Two separate instances never render identical markup, because components generate unique ids
    // per instance -- so a cross-instance differential passes no matter what the component does.
    // Driving one instance twice holds the ids fixed, leaving appearance as the only difference.
    const code = deriveComponentInline("does leaving before 250ms prevent the hint from appearing?", PANEL)?.inspectCode ?? "";
    expect(code).toContain("expect(_cancel.cancelled).not.toBe(_cancel.allowed)");
    // One withMountedComponent call, therefore one instance.
    expect(code.match(/withMountedComponent/g)).toHaveLength(1);
    // The exit the claim names implies the entry that arms it.
    expect(code.indexOf("await d.hover()")).toBeLessThan(code.indexOf("await d.leave()"));
  });

  it("declines both without the module, and when construction would be a guess", () => {
    expect(deriveComponentInline("does hovering for longer than 250ms show the hint?")).toBeNull();
    const untyped = PANEL.replace("/** @param {string} [options.hint] - hint text */", "")
      .replace("static schema = { hint: {} };", "static schema = { mystery: { set(v) {} } };");
    expect(deriveComponentInline("does hovering for longer than 250ms show the hint?", untyped)).toBeNull();
  });
});

/**
 * Destroying a component leaves nothing of it in the document.
 *
 * Probed against a component with no relation to the ones this was written for: its own option, its
 * own tag, and a claim worded differently from either.
 */
describe("destroy-leaves-nothing pattern", () => {
  const WIDGET = [
    "/** @param {string} [options.caption] - caption text */",
    "export default class Widget {",
    "  static schema = { caption: {} };",
    "}",
  ].join("\n");

  it("asserts nothing rendered stays connected", () => {
    const code = deriveComponentInline("does destroying the Widget remove its caption from the DOM?", WIDGET)?.inspectCode ?? "";
    expect(code).toContain("querySelectorAll");
    expect(code).toContain("expect(_gone.stillConnected).toBe(0)");
  });

  it("requires something to have been connected in the first place", () => {
    // Without this the check passes for a component that rendered nothing at all -- the shape every
    // vacuous assertion in this engine has taken.
    const code = deriveComponentInline("does destroying the Widget remove its caption from the DOM?", WIDGET)?.inspectCode ?? "";
    expect(code).toContain("expect(_gone.connectedBefore).toBeGreaterThan(0)");
  });

  it("checks destroy exists rather than gating on the module defining it", () => {
    // `destroy` is nearly always inherited from a base class the module never mentions, so gating on
    // the module's own source declined both components that motivated the pattern. A claim about
    // destroying, made against a component with no `destroy`, is a real disagreement -- it should read
    // as a failed expectation rather than as a TypeError.
    expect(WIDGET).not.toContain("destroy");
    const code = deriveComponentInline("does destroying the Widget remove its caption from the DOM?", WIDGET)?.inspectCode ?? "";
    expect(code).toContain('expect(typeof (d.instance as { destroy?: unknown }).destroy).toBe("function")');
  });
});

/**
 * A perspective inherits vocabulary from the claim it hangs under.
 *
 * These documents are written so that a perspective reads as a follow-on question -- "does the
 * Tooltip component exist after construction?" under a claim that already said "it exists as
 * `this._tooltip`". Repeating the identifier in both lines would be worse prose, so the deriver has
 * to read the parent to find it. Translating each perspective in isolation threw that away: across
 * one real corpus 42 of 71 pending perspectives had a parent carrying backticked identifiers the
 * perspective never repeats.
 */
describe("parent-claim context", () => {
  const WRAPPER = [
    "/** @param {string} [options.hint] - hint text */",
    "export default class W { static schema = { hint: {} }; }",
  ].join("\n");
  const perspective = "does the Hint component exist after construction with a hint option?";

  it("reads an identifier the perspective refers to but does not name", () => {
    const parent = "the Hint is created during render; after construction it exists as `this._hint`";
    const code = deriveComponentInline(perspective, WRAPPER, parent)?.inspectCode ?? "";
    expect(code).toContain("expect(_inst._hint).toBeDefined()");
  });

  it("declines when no parent is in scope", () => {
    // The same perspective, derived as a standalone claim, has nothing to look at. Guessing which
    // member "the Hint component" refers to would report a component that built its collaborator
    // correctly as having failed to.
    expect(deriveComponentInline(perspective, WRAPPER)).toBeNull();
  });

  it("declines when the parent names no member either", () => {
    const vague = "the Hint is created during render and is available afterwards";
    expect(deriveComponentInline(perspective, WRAPPER, vague)).toBeNull();
  });

  it("takes only context from the parent, never the assertion", () => {
    // The parent mentions a 700ms delay; the perspective asks about existence. What gets asserted
    // has to come from the perspective, or a parent would silently retarget its own children.
    const parent = "shown after 700ms; after construction it exists as `this._hint`";
    const code = deriveComponentInline(perspective, WRAPPER, parent)?.inspectCode ?? "";
    expect(code).toContain("toBeDefined()");
    expect(code).not.toContain("advance");
  });
});

/**
 * What construction renders.
 *
 * The largest family of pending claims in one corpus was a single shape: build the component a
 * particular way, then look at what it rendered. Each pattern below is probed against a synthetic
 * component sharing nothing with the one it was written for -- different option names, different
 * elements, differently worded claims -- because a pattern that only ever runs against its
 * originating module is a lookup table wearing a regex.
 */
describe("rendered-structure patterns", () => {
  const PANEL = [
    "/** @param {Array<string>} [options.entries] - the entries",
    "  * @param {string} [options.body] - body text",
    "  * @param {string} [options.dialect='klingon'] - dialect */",
    "export default class Panel {",
    "  static schema = { entries: {}, body: {}, dialect: { default: 'klingon' } };",
    "}",
  ].join("\n");
  const derive = (claim: string, parent?: string) =>
    deriveComponentInline(claim, PANEL, parent)?.inspectCode ?? "";

  it("asserts a style property the claim names, with the value the claim names", () => {
    const code = derive("does a Panel element have max-width: 40rem applied at construction?");
    // The property arrives hyphenated in prose and has to be read off `style` in camel case.
    expect(code).toContain('expect(_inst.elem?.style?.maxWidth).toBe("40rem")');
  });

  it("requires a real group before asserting a shared attribute", () => {
    // Built from the usual declaration this renders one element, and "they all share a name" is then
    // true of any component at all -- including one assigning a fresh value per element, which is the
    // bug the claim exists to prevent.
    const code = derive("does each entry field in the group share the same form attribute?");
    expect(code).toContain('entries: ["lld-a", "lld-b"]');
    expect(code).toContain("expect(_els.length).toBeGreaterThan(1)");
    // Non-empty as well as equal, or a component setting nothing would pass.
    expect(code).toContain("_vals.every(v => v && v === _vals[0])");
  });

  it("fills the module's own list option to test mixed input", () => {
    const code = derive("does a Panel render a mix of string and object entries without failing?");
    expect(code).toContain('entries: ["lld", { label: "lld", value: "lld" }]');
    expect(code).toContain("not.toThrow()");
  });

  it("declines mixed-input claims when more than one list could be meant", () => {
    const two = PANEL.replace("static schema = { entries: {},", "static schema = { entries: {}, tags: {},")
      .replace("  * @param {string} [options.body]", "  * @param {Array<string>} [options.tags] - tags\n  * @param {string} [options.body]");
    expect(deriveComponentInline("does a Panel render a mix of string and object entries without failing?", two)).toBeNull();
  });

  it("promotes to the tag the claim names in parentheses", () => {
    const code = derive("does body with newlines render as a block (section) rather than inline?");
    expect(code).toContain('body: "line one\\nline two"');
    expect(code).toContain('expect(_inst.elem?.tagName).toBe("SECTION")');
  });

  it("builds the asserted class from the template its parent states", () => {
    // "an identifiable class" names no class -- the claim above it carries the template, and the
    // braces stand for the option's own value.
    const code = derive(
      "does the dialect option add an identifiable class to the panel element?",
      "the `dialect` option adds a `dialect-{name}` class; tooling targets it by convention",
    );
    expect(code).toContain('classList?.contains("dialect-klingon")');
  });

  it("declines a class claim whose parent spells out no template", () => {
    expect(deriveComponentInline(
      "does the dialect option add an identifiable class to the panel element?",
      PANEL,
      "the dialect option is reflected onto the element somehow",
    )).toBeNull();
  });
});

/**
 * Degraded extraction is recorded as data, not swallowed.
 *
 * The ts-morph stages deliberately fall back to empty results when the compiler chokes on a
 * module -- extraction must survive any source. But those catch sites used to be pure silence,
 * so a user could not distinguish "your claim is vague" (nothing derives, honestly) from "our
 * parser gave up" (nothing derives, and nobody was told why). This pins the record: a source
 * ts-morph cannot parse still extracts, and says which stages degraded.
 */
describe("degraded extraction", () => {
  // Nesting deep enough to overflow the TypeScript parser's recursion, plus a `.startsWith("# ")`
  // format token so the text-transformer stage reaches its ts-morph call instead of gating out.
  const DEPTH = 30_000;
  const UNPARSEABLE =
    'export const parse = (s: string) => s.startsWith("# ");\n' +
    "const deep = " + "(".repeat(DEPTH) + "0" + ")".repeat(DEPTH) + ";\n";

  it("still returns facts, with a non-empty degraded record", async () => {
    const facts = await extractFactsFromSource(UNPARSEABLE);
    // Extraction survived: the regex-derived facts are all present.
    expect(facts.schemas).toEqual([]);
    expect(facts.source).toContain("startsWith");
    // And the fallback is on the record, per stage, with a reason.
    expect(facts.degraded.length).toBeGreaterThan(0);
    for (const entry of facts.degraded) {
      expect(typeof entry.stage).toBe("string");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    const stages = facts.degraded.map(d => d.stage);
    expect(stages).toContain("functionTypeChains");
    expect(stages).toContain("textTransformerFunctions");
  });

  it("stays empty when every stage runs clean", async () => {
    const facts = await extractFactsFromSource("export const add = (a: number, b: number) => a + b;\n");
    expect(facts.degraded).toEqual([]);
  });
});
