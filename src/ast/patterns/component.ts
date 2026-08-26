// Structural component patterns: claim-text patterns that generalize across codebases.
//
// Every entry here reads its capture groups out of the claim text and builds a test around
// whatever it captured, so it fires for a component and an option name it has never seen. That
// is the whole membership rule, and it is mechanically checkable: if `build` ignores its match
// argument, the pattern is keyed to one sentence in one codebase and does not belong here.
//
// Priority-then-array-order resolution is still load-bearing here (two built-ins declare an
// explicit priority) -- see `deriveComponentInline` below.

import type { InlineDerived, ComponentPattern } from "../types.ts";
import { declaredConstructorOptions, declaresOption, arrayOptionNames } from "../declaredOptions.ts";

/** Two values a declared option will accept, or a verdict that no probe is safe.
 *
 *  Returns `undefined` when the option declares no allowed set, in which case an arbitrary probe
 *  value is fine -- nothing will reject it. Returns `"unusable"` when a set *is* declared but is too
 *  small to switch between, because then there is no test to derive, only a guess to make.
 *
 *  Reads the module's own declaration, following one level of indirection: an `enum:` is commonly a
 *  reference to a frozen const rather than an inline array. */
function declaredOptionValues(source: string | undefined, option: string): [string, string] | "unusable" | undefined {
  if (!source) return undefined;

  // The option's own declaration block, e.g. `position: { default: 'topRight', enum: position_enum,`
  const block = source.match(new RegExp(`\\b${option}\\s*:\\s*\\{([\\s\\S]{0,400}?)\\}`))?.[1];
  // A bracketed array is captured whole. Reading it as `[^,\n]+` stopped at the first comma, and an
  // enum with two or more values always has one -- so an inline `enum: ['top','bottom']` yielded a
  // single value, was judged "too small to switch between", and the claim went pending. Only enums
  // written as a reference to a named const ever worked, which is why this went unnoticed.
  const enumRef = block?.match(/\benum\s*:\s*(\[[^\]]*\]|[^,\n]+)/)?.[1]?.trim();
  if (!enumRef) return undefined;

  const literals = (text: string): string[] =>
    [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map(x => x[1]);

  // Inline array, or a named const to resolve.
  let values = enumRef.startsWith("[") ? literals(enumRef) : [];
  if (values.length === 0 && /^[A-Za-z_$][\w$]*$/.test(enumRef)) {
    const decl = source.match(new RegExp(`\\b${enumRef}\\s*=\\s*(?:Object\\.freeze\\()?\\s*\\[([\\s\\S]*?)\\]`))?.[1];
    if (decl) values = literals(decl);
  }

  if (values.length < 2) return "unusable";
  return [values[0], values[1]];
}

/** How to read a named member off an instance: `x` for a getter or field, `x()` for a method.
 *
 *  A claim names the member, not its shape -- `isDirty` is a getter and `hasErrors()` is a method,
 *  and both read naturally in prose. Guessing one form gets the other wrong in a way that looks like
 *  a failing implementation: reading a method as a property yields the function, and
 *  `expect(fn).toBe(false)` fails against code that is perfectly correct.
 *
 *  The module already says which it is, so ask it. Defaults to a property, since a claim about state
 *  usually means state and an unrecognised member is more likely a field than a method. */
function memberAccess(source: string | undefined, member: string): string {
  if (!source) return member;
  if (new RegExp(`\\bget\\s+${member}\\s*\\(`).test(source)) return member;
  if (new RegExp(`^\\s*(?:async\\s+)?${member}\\s*\\([^)]*\\)\\s*\\{`, "m").test(source)) return `${member}()`;
  return member;
}

/** The body for a claim of the form "<trigger> invokes <onCallback>", in either polarity.
 *
 *  Shared because the negative case is not a different test -- it is the same probe with the opposite
 *  expectation, and the gating (does the module define this method, does it declare this option, can
 *  it be constructed) is identical. Keeping one implementation is what stops the two drifting into
 *  disagreeing about which components they will fire for. */
function callbackProbe(
  parts: { verb: string; keyArg?: string; middle: string; callback: string; negated: boolean },
  source: string
): string[] {
  const { verb, keyArg, middle, callback, negated } = parts;

  // A method trigger has to name a method that exists. Unlike `destroy`, which is inherited from a
  // base class the module never mentions, a method a claim says to *call* is the component's own
  // behaviour and belongs in its source. An unrecognised name here means the claim and the
  // module disagree about the API, so the pattern declines and the claim stays pending.
  const defined = (name: string) => new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, "m").test(source);
  if (verb === "calling" && !(keyArg && defined(keyArg))) return [];

  // "calling `show()` then `hide()` invokes `onClose`" -- a claim may name the call that puts the
  // component into the state the trigger acts on. That is not ceremony: a sheet that was never
  // opened is not dismissed by hiding it, so `onClose` correctly does not fire, and a claim that
  // omits the first call is asking about a state the component is not in.
  const thenMethod = /\bthen\s+`?(\w+)`?\(\)/i.exec(middle)?.[1];
  if (thenMethod && !defined(thenMethod)) return [];

  // The component has to actually accept this callback. Passing an option a component ignores means
  // a spy that never fires, which reads as a broken implementation rather than as the pattern
  // reaching for something the module never offered.
  if (!declaresOption(source, callback)) return [];

  const { optionsCode, unresolved } = declaredConstructorOptions(source);
  if (unresolved.length) return [];

  // Where the event lands. A rendered child is preferred over the component's own element because
  // events bubble: dispatching on a child exercises the child's handler *and* every handler on the
  // root, while dispatching on the root exercises only the root's. It is never the weaker choice,
  // and it is often the only correct one -- "clicking a menu item" passed against a Menu with no
  // items at all, because the root's handler fired regardless.
  //
  // A claim that says "focused" is additionally asking for the event to land somewhere focus can be,
  // so it looks for something focusable first. Menu ignores Enter unless `document.activeElement` is
  // one of its items, and it is right to: that is what the key means.
  const wantsFocus = /\bfocus/i.test(middle);
  const call = (name: string) => `(d.instance as Record<string, () => void>).${name}();`;
  const action = verb === "calling"
    ? `${call(keyArg as string)}${thenMethod ? ` await d.settle(); ${call(thenMethod)}` : ""} await d.settle();`
    : verb === "pressing" ? `await d.press(${JSON.stringify(keyArg || "Enter")}, _t);`
    : verb === "clicking" ? `await d.click(_t);`
    : verb === "hovering" ? `await d.hover(_t);`
    : `await d.type("lld", _t);`;

  return [
    `let _fired = 0;`,
    `const _cb = await withMountedComponent(`,
    `  () => new _SubjectCtor({ ...${optionsCode}, ${callback}: () => { _fired++; } }),`,
    `  async d => {`,
    wantsFocus
      ? `    const _t = d.el.querySelector("[tabindex], button, a[href], input, select, textarea") ?? d.el.firstElementChild ?? d.el;`
      : `    const _t = d.el.firstElementChild ?? d.el;`,
    ...(wantsFocus ? [`    _t.focus?.(); await d.settle();`] : []),
    `    const before = _fired;`,
    `    ${action}`,
    `    return { before, after: _fired };`,
    `  });`,
    // Against a baseline, so a component that calls the same handler while starting up neither makes
    // the trigger look successful on its own nor makes a claim of silence look violated by it.
    negated
      ? `expect(_cb.after).toBe(_cb.before);`
      : `expect(_cb.after).toBeGreaterThan(_cb.before);`,
  ];
}

export const COMPONENT_PATTERNS: ComponentPattern[] = [
  // ══ Instance state a claim already states the expectation for ═════
  //
  // These three exist because the claim supplies the half the module cannot. "Does calling render()
  // twice leave exactly one copy" already says what the answer must be; all the module has to
  // provide is a way to call it. That is a different thing from reading an expectation *out of* the
  // implementation, which is tautological -- derive "render() appends" from a render() that appends
  // and it passes against a double-append bug. Here the expectation is the author's and only the
  // mechanism is the module's, so the test can still be wrong about the code.

  // ── A named state accessor, on an instance fresh from the constructor ──
  // The condition has to be one construction can actually produce. "returns false when the value
  // matches the initial value" describes a fresh instance; "returns true after the value has been
  // changed" does not, and deriving it anyway would assert the opposite of the truth.
  { test: /\b(\w*(?:is|has)[A-Z]\w*)\s+return\s+(true|false)\b(.*)$/i, build: (m, source) => {
    const [accessor, expected, condition] = [m[1], m[2].toLowerCase(), m[3] ?? ""];
    if (/\bafter\b|\bchang|\bfail|\binvalid\b|\bonce\b|\bsubsequent\b/i.test(condition)) return [];
    return [
      `const _inst = new _SubjectCtor({});`,
      `expect(_inst.${memberAccess(source, accessor)}).toBe(${expected});`,
    ];
  } },

  // ── An option defers a named call by a stated delay ──
  // "`autoOpen: true` queues `show()` after 200ms" names every part of its own test: the option that
  // arms the work, the method that eventually runs, and how long the wait is. So watch that method.
  // A counter on it answers both halves of the claim directly -- not called yet one tick short of the
  // delay, called once the delay elapses -- and it needs no knowledge of what `show()` does, which is
  // what lets this fire for a component the pattern has never seen.
  //
  // Counting calls rather than reading rendered output is the difference between testing the claim
  // and testing whatever the claim happens to leave visible. Deferred work that updates internal
  // state or notifies a caller changes no markup, and a DOM diff reports that correct component as
  // broken.
  //
  // An earlier version counted queued timers, and it was a false pass: `jest.getTimerCount()` reports
  // nothing under happy-dom, so `queued > 0` was reading an ambient timer. Disabling the scheduling
  // in a real component left the claim green. Compared against a baseline rather than against zero,
  // so a method the component also calls while starting up does not read as the deferred call.
  { test: /`?(\w+):\s*(true|false|\d+)`?\s+queues?\s+`?(\w+)\(\)`?\s+after\s+(\d+)\s*ms/i,
    build: (m, source) => {
      const [option, value, method, delay] = [m[1], m[2], m[3], m[4]];
      // The method has to exist to be watched. Without this a mismatched name reaches codegen as an
      // undefined spy target and dies with a TypeError, which reads as a broken tool rather than as
      // the claim/code disagreement it is.
      if (!source || !new RegExp(`^\\s*(?:async\\s+)?${method}\\s*\\(`, "m").test(source)) return [];

      // Built from the component's whole declared surface, with the claim's own option on top. An
      // option-driven component left half-configured behaves differently from one a caller would
      // actually create, and the declaration is the only trustworthy account of what "configured"
      // means. If the module does not declare enough to construct it, decline rather than guess.
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];

      const q = JSON.stringify(method);
      return [
        `let _calls = 0;`,
        `const _proto = _SubjectCtor.prototype;`,
        `const _own = Object.prototype.hasOwnProperty.call(_proto, ${q});`,
        `const _orig = _proto[${q}];`,
        `_proto[${q}] = function (...a) { _calls++; return _orig.apply(this, a); };`,
        `let _sched;`,
        `try {`,
        `  _sched = await withMountedComponent(() => new _SubjectCtor({ ...${optionsCode}, ${option}: ${value} }), async d => {`,
        `    const armed = _calls;`,
        `    d.advance(${Math.max(0, Number(delay) - 1)}); await d.settle();`,
        `    const justBefore = _calls;`,
        `    d.advance(1); await d.settle();`,
        `    return { armed, justBefore, after: _calls };`,
        `  });`,
        `} finally {`,
        `  if (_own) _proto[${q}] = _orig; else delete _proto[${q}];`,
        `}`,
        `expect(_sched.justBefore).toBe(_sched.armed);`,
        `expect(_sched.after).toBeGreaterThan(_sched.justBefore);`,
      ];
    } },

  // ══ What construction renders ═══════════════════════════════════════
  //
  // The largest family of pending claims in one real corpus was a single shape: build the component
  // a particular way, then look at what it rendered. Nineteen claims across ten components asked it --
  // about a class, an attribute, a tag, a style, a child element -- and the engine answered a handful
  // of specific phrasings rather than the shape.
  //
  // What holds them together is that the claim states its own target. "have height: 100% applied at
  // construction" names the property *and* the value; "share the same name attribute" names the
  // element and the attribute. Where a claim leaves the target to the reader -- "an identifiable
  // class", "renders inline" -- the pattern declines, because the alternative is guessing which of a
  // component's classes was meant and reporting a correct component as broken.

  // ── A style property applied at construction ──
  { test: /\bhave\s+([a-z][a-z-]*)\s*:\s*([^\s?;]+)\s+applied\s+at\s+construction/i,
    build: (m, source) => {
      const [property, value] = [m[1].toLowerCase(), m[2]];
      if (!source) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      const camel = property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return [
        `const _inst = new _SubjectCtor(${optionsCode});`,
        `expect(_inst.elem?.style?.${camel}).toBe(${JSON.stringify(value)});`,
      ];
    } },

  // ── Every element of a kind carries the same attribute ──
  // "the browser enforces that only one radio in the group can be checked" is a real guarantee that
  // rests entirely on the elements agreeing about `name`, so the value has to be shared *and*
  // non-empty -- a component that set none at all would otherwise satisfy "they are all the same".
  { test: /\beach\s+[\w\s]*?(\w+)\s+in\s+the\s+group\s+share\s+the\s+same\s+(\w+)\s+attribute/i,
    build: (m, source) => {
      const [element, attribute] = [m[1].toLowerCase(), m[2]];
      if (!source) return [];

      // A group needs more than one member. Built from the usual declaration this component renders
      // a single radio, and "they all share a name" is then true of any component at all -- including
      // one that assigns a fresh name per input, which is exactly the bug the claim exists to
      // prevent. So the list option is filled with two entries and two are required to come back.
      const lists = arrayOptionNames(source);
      if (lists.length !== 1) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];

      return [
        `const _inst = new _SubjectCtor({ ...${optionsCode}, ${lists[0]}: ["lld-a", "lld-b"] });`,
        `const _els = Array.from(_inst.elem?.querySelectorAll(${JSON.stringify(element)}) ?? []);`,
        `expect(_els.length).toBeGreaterThan(1);`,
        `const _vals = _els.map(e => e.getAttribute(${JSON.stringify(attribute)}));`,
        // Non-empty as well as equal: a component setting no attribute at all would otherwise pass.
        `expect(_vals.every(v => v && v === _vals[0])).toBe(true);`,
      ];
    } },

  // ── A list option accepts mixed formats without failing ──
  // The claim says what the values look like and that nothing breaks; the module says which option
  // holds them. A component with more than one list option is ambiguous and declines, because the
  // claim gives no way to choose between them.
  { test: /\b(?:a\s+mix\s+of|mixed)\s+string\s+and\s+object\b[^?]*?\b(?:without\s+(?:failing|error)|render\w*\s+without)/i,
    build: (_m, source) => {
      if (!source) return [];
      const lists = arrayOptionNames(source);
      if (lists.length !== 1) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      // One of each, which is what "a mix of string and object" describes. The object carries both
      // conventional keys so a component reading either finds one.
      const mixed = `["lld", { label: "lld", value: "lld" }]`;
      return [
        `expect(() => new _SubjectCtor({ ...${optionsCode}, ${lists[0]}: ${mixed} })).not.toThrow();`,
      ];
    } },

  // ── Content of a given shape promotes the element to a named tag ──
  // "does code with newlines render as a block (pre)" names the option holding the content, the
  // shape that triggers the promotion, and the tag it promotes to. Its sibling -- "does single-line
  // code render inline?" -- names no tag, and stays pending rather than having one guessed for it.
  { test: /\b(\w+)\s+with\s+newlines\s+render\s+as\s+a\b[^(?]*\((\w+)\)/i,
    build: (m, source) => {
      const [option, tag] = [m[1], m[2]];
      if (!source || !declaresOption(source, option)) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      return [
        `const _inst = new _SubjectCtor({ ...${optionsCode}, ${option}: "line one\\nline two" });`,
        `expect(_inst.elem?.tagName).toBe(${JSON.stringify(tag.toUpperCase())});`,
      ];
    } },

  // ── An option contributes a class the parent claim spells out ──
  // "does the language option add an identifiable class?" names no class -- "identifiable" is a
  // property, not a name. The claim above it does: "the `language` option adds a `language-{name}`
  // class". The braces are the option's own value, so the class asserted is built from whatever the
  // declaration says that option is worth.
  { test: /\bdoes\s+the\s+(\w+)\s+option\s+add\s+an?\s+[\w\s]*?class\b/i,
    build: (m, source, parentClaim) => {
      const option = m[1];
      if (!source || !parentClaim) return [];
      const template = parentClaim.match(
        new RegExp("`" + option + "`[^`]*?adds?\\s+an?\\s+`([\\w-]*\\{\\w+\\}[\\w-]*)`\\s+class", "i")
      )?.[1];
      if (!template) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      const value = optionsCode.match(new RegExp(`\\b${option}\\s*:\\s*"([^"]*)"`))?.[1];
      if (!value) return [];
      const expected = template.replace(/\{\w+\}/, value);
      return [
        `const _inst = new _SubjectCtor(${optionsCode});`,
        `expect(_inst.elem?.classList?.contains(${JSON.stringify(expected)})).toBe(true);`,
      ];
    } },

  // ── Two named methods move the component between two visible states ──
  // "calling `show()` slides the sheet into view; calling `hide()` slides it out" names both calls
  // and says each one is visible, which is the whole test: call the first and the rendering must
  // change, call the second and it must change again.
  //
  // Not "and then it matches what it started as" -- that is the tempting assertion and it is wrong.
  // Showing a component can register listeners and set attributes that hiding has no reason to
  // unwind, so a round trip is not the identity, and asserting it reports correct components as
  // broken. What the claim says is that each call does something visible, and that is what is
  // checked.
  //
  // Self-contained in a way the drag and navigation claims in the same document are not: it names
  // its own starting state by naming the call that establishes it.
  { test: /calling\s+`?(\w+)\(\)`?[^?]*?;\s*calling\s+`?(\w+)\(\)`?/i,
    build: (m, source) => {
      const [first, second] = [m[1], m[2]];
      if (!source) return [];
      const defines = (name: string) => new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, "m").test(source);
      if (!defines(first) || !defines(second)) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      return [
        `const _toggle = await withMountedComponent(() => new _SubjectCtor(${optionsCode}), async d => {`,
        `  const _i = d.instance as Record<string, () => void>;`,
        `  const initial = d.el.outerHTML;`,
        `  _i.${first}(); await d.settle();`,
        `  const afterFirst = d.el.outerHTML;`,
        `  _i.${second}(); await d.settle();`,
        `  return { initial, afterFirst, afterSecond: d.el.outerHTML };`,
        `});`,
        `expect(_toggle.afterFirst).not.toBe(_toggle.initial);`,
        `expect(_toggle.afterSecond).not.toBe(_toggle.afterFirst);`,
      ];
    } },

  // ── A collaborator the component builds for itself exists after construction ──
  // "does the Tooltip component exist after construction with a tooltip option?" names no member to
  // look at. The claim it hangs under does: "after construction it exists as `this._tooltip`". That
  // split is how these documents read -- a perspective is a follow-on question, and repeating the
  // identifier in both lines would be worse prose -- so the member comes from the parent and what is
  // asserted comes from the perspective.
  //
  // Requiring the parent to spell out `this.member` is what keeps this honest. Without it the pattern
  // would have to guess which member a phrase like "the Tooltip component" refers to, and a wrong
  // guess reads as a component that failed to build something it built correctly.
  { test: /\bdoes\s+(?:the|a|an)\s+[\w\s]*?\bexists?\b[^?]*?\bafter\s+construction\b/i,
    build: (_m, source, parentClaim) => {
      const member = parentClaim?.match(/\bexists?\s+as\s+`this\.(\w+)`/i)?.[1];
      if (!member || !source) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      return [
        `const _inst = new _SubjectCtor(${optionsCode});`,
        `expect(_inst.${member}).toBeDefined();`,
      ];
    } },

  // ── Destroying the component leaves nothing of it in the document ──
  // "does destroying the TagList remove its editing interface from the DOM?" and "does destroying the
  // wrapper also remove the tooltip from the DOM?" name different things being removed, and neither
  // name is something a pattern could resolve to an element. It does not need to: both claims say the
  // same thing, which is that nothing the component rendered outlives it. Taking every node in the
  // subtree and requiring all of them to be disconnected afterwards tests that directly, and says it
  // about "the tooltip" and "the editing interface" alike without knowing which is which.
  //
  // The count before destroying is asserted too. Without it the check passes for a component that
  // rendered nothing at all, which is the shape every vacuous assertion in this engine has taken.
  //
  // `destroy` is not required to appear in the module's own source, and gating on that was wrong:
  // it is almost always inherited from a base class the module never mentions, so the gate declined
  // both components that motivated the pattern. Its existence is asserted at runtime instead -- a
  // claim about what destroying does, made against a component with no `destroy`, is a genuine
  // disagreement and should read as one rather than as a TypeError.
  { test: /\bdestroy(?:ed|ing|s)?\b[^?]*?\bremoved?\b[^?]*?\bDOM\b/i,
    build: (_m, source) => {
      if (!source) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      return [
        `const _gone = await withMountedComponent(() => new _SubjectCtor(${optionsCode}), async d => {`,
        `  const _nodes = [d.el, ...Array.from(d.el.querySelectorAll("*"))];`,
        `  const connectedBefore = _nodes.filter(n => n.isConnected).length;`,
        `  expect(typeof (d.instance as { destroy?: unknown }).destroy).toBe("function");`,
        `  (d.instance as { destroy(): void }).destroy();`,
        `  await d.settle();`,
        `  return { connectedBefore, stillConnected: _nodes.filter(n => n.isConnected).length };`,
        `});`,
        `expect(_gone.connectedBefore).toBeGreaterThan(0);`,
        `expect(_gone.stillConnected).toBe(0);`,
      ];
    } },

  // ── Holding an interaction past a stated threshold makes something appear ──
  // "does hovering for longer than 700ms show the tooltip?" names the interaction, the threshold and
  // the fact that the outcome is *visible*. That last part is what licenses reading rendered output
  // here: a claim whose verb is `show`/`appear` is a claim about what a user can see, so comparing
  // markup across the threshold measures exactly what was claimed. The scheduling pattern above
  // deliberately does not do this -- "queues `show()`" is about a call, and deferred work that changes
  // no markup would read as broken.
  { test: /\b(hovering|clicking|pressing|holding)\b[^?]*?\b(?:for\s+)?(?:longer\s+than|more\s+than|at\s+least|over)\s+(\d+)\s*ms\b[^?]*?\b(?:shows?|displays?|reveals?|opens?|appears?)\b/i,
    build: (m, source) => {
      const [verb, delay] = [m[1].toLowerCase(), Number(m[2])];
      if (!source) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      const enter = verb === "hovering" ? "hover()" : verb === "clicking" ? "click()" : `press("Enter")`;
      return [
        `const _hold = await withMountedComponent(() => new _SubjectCtor(${optionsCode}), async d => {`,
        `  const before = d.el.outerHTML;`,
        `  await d.${enter};`,
        `  d.advance(${Math.max(0, delay - 1)}); await d.settle();`,
        `  const justBefore = d.el.outerHTML;`,
        `  d.advance(1); await d.settle();`,
        `  return { before, justBefore, after: d.el.outerHTML };`,
        `});`,
        `expect(_hold.justBefore).toBe(_hold.before);`,
        `expect(_hold.after).not.toBe(_hold.before);`,
      ];
    } },

  // ── Ending the interaction before the threshold prevents it ──
  // The mirror of the pattern above, and the claim only names the *exit* -- "does leaving before 700ms
  // prevent the tooltip from appearing?" takes the hover as read. Entering is the inverse of the exit
  // the claim names, which is a fact about pointer events rather than about any codebase.
  //
  // Both comparisons happen on one instance, and that is not incidental. Comparing a cancelled run
  // against a separate allowed run looks like the obvious differential and is worthless: components
  // generate unique ids per instance, so two instances never render identical markup and the
  // assertion passes no matter what the component does. Driving the same instance twice -- cancel,
  // then allow -- leaves the ids fixed so the only thing that can differ is whether it appeared.
  { test: /\b(leaving|exiting|releasing)\b[^?]*?\bbefore\s+(\d+)\s*ms\b[^?]*?\b(?:prevents?|stops?|cancels?|keeps?)\b/i,
    build: (m, source) => {
      const delay = Number(m[2]);
      if (!source) return [];
      const { optionsCode, unresolved } = declaredConstructorOptions(source);
      if (unresolved.length) return [];
      return [
        `const _cancel = await withMountedComponent(() => new _SubjectCtor(${optionsCode}), async d => {`,
        `  await d.hover();`,
        `  d.advance(${Math.max(1, Math.floor(delay / 2))}); await d.settle();`,
        `  await d.leave();`,
        `  d.advance(${delay * 3}); await d.settle();`,
        `  const cancelled = d.el.outerHTML;`,
        `  await d.hover();`,
        `  d.advance(${delay}); await d.settle();`,
        `  return { cancelled, allowed: d.el.outerHTML };`,
        `});`,
        `expect(_cancel.cancelled).not.toBe(_cancel.allowed);`,
      ];
    } },

  // ── An interaction invokes a named callback option ──
  // "does pressing Enter on a focused menu item invoke onSelect?" is self-contained: the claim names
  // the interaction and it names the callback, and a callback either ran or it did not. That is the
  // rare interaction claim needing no knowledge of what the component *does* in response -- which is
  // what lets one pattern serve a Button, a Menu and a Dialog alike.
  //
  // Most interaction claims are not like this. "does clicking a sortable column update sortProperty"
  // names a consequence only that component can define, and guessing at it derives a different test
  // than the one the claim asks for. The line this pattern draws is exactly that: the consequence has
  // to be named by the claim, and a callback is the one consequence that always is.
  //
  // `calling` is in the list of triggers alongside the pointer and keyboard verbs because the claim
  // shape is identical -- "does calling hide() invoke the onClose callback?" names a trigger and a
  // consequence in exactly the same way, and the only difference is that the trigger is a method on
  // the component rather than an event on its element. Splitting that into a second pattern would
  // duplicate the gating and the construction for no gain.
  { test: /\b(pressing|clicking|hovering|typing|calling)\b\s*`?(\w+)`?(?:\(\))?([^?]*?)\b(?:invokes?|triggers?|calls?|fires?)\s+(?:the\s+)?`?(on[A-Z]\w*)`?/i,
    build: (m, source) => {
      const [verb, keyArg, middle, callback] = [m[1].toLowerCase(), m[2], m[3] ?? "", m[4]];
      if (!source) return [];
      return callbackProbe({ verb, keyArg, middle, callback, negated: false }, source);
    } },

  // ── The same trigger, claimed *not* to invoke the callback ──
  // "does calling hide() on an already-closed sheet leave onClose uninvoked?" is the other half of a
  // contract, and it is the half that pins it: a component that fires its callback unconditionally
  // satisfies every positive claim anyone can write about it. Reusing the same probe with the
  // opposite expectation is deliberate -- the negative case is not a different test.
  { test: /\b(pressing|clicking|hovering|typing|calling)\b\s*`?(\w+)`?(?:\(\))?([^?]*?)\b(?:leaves?\s+(?:the\s+)?`?(on[A-Z]\w*)`?\s+(?:uninvoked|uncalled|unfired)|(?:does\s+not|never|without)\s+(?:invok\w+|trigger\w*|call\w*|fir\w+)\s+(?:the\s+)?`?(on[A-Z]\w*)`?)/i,
    build: (m, source) => {
      const [verb, keyArg, middle] = [m[1].toLowerCase(), m[2], m[3] ?? ""];
      const callback = m[4] ?? m[5];
      if (!source || !callback) return [];
      return callbackProbe({ verb, keyArg, middle, callback, negated: true }, source);
    } },

  // ── The instance carries a named member at all ──
  { test: /\bdoes\s+(?:an?\s+)?\w+\s+have\s+(\w*(?:is|has)[A-Z]\w*|\w+\(\))\s*\??$/i, build: m => {
    const member = m[1].replace(/\(\)$/, "");
    return [
      `const _inst = new _SubjectCtor({});`,
      `expect(_inst).toHaveProperty(${JSON.stringify(member)});`,
    ];
  } },

  // ── Calling a method again does not add to what it already built ──
  // Compares the second call against the first rather than against a literal count, so the claim's
  // "exactly one copy" holds for a component whose build produces any number of children.
  { test: /calling\s+(\w+)\(\)\s+twice.*?(?:one copy|not two|exactly one|unchanged)/i, build: m => [
    `const _inst = new _SubjectCtor({});`,
    `_inst.${m[1]}();`,
    `const _afterFirst = _inst.elem?.children.length;`,
    `_inst.${m[1]}();`,
    `expect(_inst.elem?.children.length).toBe(_afterFirst);`,
  ] },

  { test: /updating the (\w+) option change the \1'?s? content without replacing the \w+'?s? structure/i, build: m => [
    `const _inst = new _SubjectCtor({ ${m[1]}: "Original" });`,
    `const _ref = _inst._${m[1]}?.elem;`,
    `_inst.options.${m[1]} = "Updated";`,
    `expect(_inst._${m[1]}?.elem).toBe(_ref);`,
    `expect(_inst._${m[1]}?.elem?.textContent).toBe("Updated");`,
  ] },

  // ── Option list entries: string label==value, object separates them ─
  { test: /(\w+)\s+values?;\s+anything\s+else\s+throws/i, build: m => [
    `expect(() => new _SubjectCtor({ ${m[1]}: "__lld_invalid__" })).toThrow();`,
  ] },
  // Show/hide animation is a CSS concern: the component's only JS-observable responsibility is
  // applying the position class; the transition itself is declared in CSS (:popover-open /
  // @starting-style), outside what a unit test can observe.
  { test: /the\s+(\w+)\s+attribute\s+is\s+set\s+on\s+the\s+element/i, build: m => {
    const attr = m[1];
    return [
      `const _inst = new _SubjectCtor({ ${attr}: true });`,
      `expect((_inst.elem as any)?.${attr} || _inst.elem?.hasAttribute("${attr}")).toBe(true);`,
    ];
  } },

  // ══ Pattern 2: Exclusive class set ═══════════════════════════════
  // Pattern: changing an option removes old class, adds new one.
  // Covers: variant, position, state, type -- any option that maps to
  // mutually exclusive CSS classes. Universal UI component pattern.

  // Position specifically needs real valid values, not placeholders: Tooltip's `position`
  // option validates against nine specific enum values and throws on assignment for anything
  // else, so a generic "valueA"/"valueB" probe would throw instead of testing the class switch.
  // This also tests reassignment on one instance (replaces, not accumulates), not two separate
  // constructions -- a different, stronger claim than the generic fallback below tests.
  { test: /changing\s+(\w+)\s+from.*(?:leaves?\s+only|removes?\s+old|exclusive)/i, build: (m, source) => {
    const option = m[1];
    // Two values the option will actually accept. A validated option rejects anything outside its
    // declared set, so the generic "valueA"/"valueB" probe throws on construction and the claim
    // reports as *failing* -- a test of the validator, not of the class switch the claim describes.
    // The header comment above has warned about this since before the option was declarative; what
    // changed is that the declaration can now be read, so the probe uses real values instead of
    // being masked by a more specific pattern somewhere else.
    const values = declaredOptionValues(source, option);
    if (values === "unusable") return [];
    const [a, b] = values ?? ["valueA", "valueB"];
    return [
      `const _a = new _SubjectCtor({ ${option}: ${JSON.stringify(a)} });`,
      `const _b = new _SubjectCtor({ ${option}: ${JSON.stringify(b)} });`,
      `expect(_a.elem?.className).not.toBe(_b.elem?.className);`,
    ];
  } },

  // ══ Pattern 3: Deferred / timer behavior ═════════════════════════
  // Pattern: "X fires after Nms delay" -- check SYNCHRONOUS state only.
  // Full timer tests (advance Nms and assert fired) need fake timers;
  // the synchronous check (not-yet-open at t=0) is derivable now.

  // Option name extracted from claim text ("with X not open synchronously") rather than
  // hardcoded -- any boolean option gating synchronous auto-open/fire behavior fits this,
  // not just autoOpen specifically. Deliberately just the one tight alternative: a looser
  // fallback would let JS's leftmost-match regex semantics capture the wrong word
  // (e.g. "does" from "does a popover with autoOpen...") by starting its match earlier
  // in the string than this alternative can.
  { test: /with\s+(\w+)\s+not\s+(?:open|fire)\s+synchronously/i, build: m => {
    const opt = m[1];
    return [
      `const _inst = new _SubjectCtor({ ${opt}: true });`,
      `expect((_inst.elem as any)?.matches?.(":popover-open") ?? _inst.elem?.hasAttribute("open") ?? false).toBe(false);`,
    ];
  } },

  // ══ Pattern 5: Destroy removes from DOM ══════════════════════════
  // Pattern: destroy() removes the component and its children from the
  // document. Universal cleanup contract -- present in every component
  // library that manages child component lifecycles.

  // destroy() removes the component element from DOM -- universal cleanup contract. Both variants
  // below share a bare-construction body: destroy() doesn't depend on what was passed.
  { test: /(?:invalid|unrecognized|unsupported)\s+(\w+)\s+(?:value\s+)?throw|does.*throw.*invalid\s+(\w+)/i, priority: 10, build: m => {
    const opt = m[1] ?? m[2];
    return opt ? [`expect(() => new _SubjectCtor({ ${opt}: "__lld_invalid__" })).toThrow();`] : [];
  } },
  // ── Property comparison between two instances (e.g. throttle adapts to lineWidth) ──
  // "does a Whiteboard with X 10 have a higher Y than one with X 2?"
  { test: /with\s+(\w+)\s+(\d+)\s+have\s+a\s+higher\s+(\w+)\s+than\s+.*with\s+\1\s+(\d+)/i, build: m => {
    const [, opt, bigVal, prop, smallVal] = m;
    return [
      `const _big   = new _SubjectCtor({ ${opt}: ${bigVal} });`,
      `const _small = new _SubjectCtor({ ${opt}: ${smallVal} });`,
      `expect(_big.${prop}).toBeGreaterThan(_small.${prop});`,
    ];
  } },

  // ── Element remains a specific tag type ──────────────────────────
  // "does a Link with variant 'button' remain an anchor element?"
  { test: /remain\s+an?\s+(\w+)\s+element|still\s+(?:be|is)\s+an?\s+(\w+)\s+element/i, build: (m) => {
    const rawTag = (m[1] ?? m[2]).toLowerCase();
    // Map semantic names to actual HTML tag names
    const tagMap: Record<string, string> = { anchor: "a", button: "button", paragraph: "p" };
    const tag = tagMap[rawTag] ?? rawTag;
    const optMatch = m.input?.match(/variant\s*[:']\s*['"]?(\w+)/i);
    const opt = optMatch ? `{ variant: "${optMatch[1]}" }` : `{}`;
    return [
      `const _inst = new _SubjectCtor(${opt});`,
      `expect(_inst.elem?.tagName?.toLowerCase()).toBe("${tag}");`,
    ];
  } },

  // ── DOM element presence / absence ───────────────────────────────
  // "does a readOnly X contain no input element?" → readOnly:true, querySelector null
  { test: /readOnly\s+\w+\s+contain\s+no\s+(\w+)\s+element/i, build: m => [
    `const _inst = new _SubjectCtor({ readOnly: true });`,
    `expect(_inst.elem?.querySelector("${m[1]}")).toBeNull();`,
  ] },
  // "does a non-readOnly X contain both input and ..." → default ctor, input exists
  { test: /had\s+icon\s+['"](\w+)['"]\s+and.*updated\s+to\s+['"](\w+)['"]/i, build: m => {
    const [, prev, next] = m;
    return [
      `const _inst = new _SubjectCtor({ icon: "${prev}" });`,
      `_inst.options.icon = "${next}";`,
      `expect(_inst.elem?.classList?.contains("fa-${prev}")).toBe(false);`,
      `expect(_inst.elem?.classList?.contains("fa-${next}")).toBe(true);`,
    ];
  } },

  // ── Reactive: adding text removes icon-only class ────────────────
  { test: /setting\s+(\w+):\s*false\s+prevent|prevent.*setting\s+(\w+):\s*false/i, priority: 10, build: m => {
    const opt = m[1] ?? m[2];
    return [
      `const _inst = new _SubjectCtor({ ${opt}: false });`,
      `expect((_inst.elem as any)?.open).not.toBe(true);`,
    ];
  } },

  // ── Reactive: setting option to boolean value ─────────────────────
  // "setting X: true hide" / "setting X: false show" -- option name extracted from claim
  // text rather than hardcoded to "collapsed". `variant: "collapsible"` stays as a
  // best-effort compatibility nudge for a Popover-shaped component, which needs it for
  // "collapsed" to take effect; an unrelated component that doesn't recognize "variant" just
  // ignores it.
  { test: /setting\s+(\w+):\s*(true|false)/i, build: m => {
    const [, opt, val] = m;
    return [
      `const _inst = new _SubjectCtor({ variant: "collapsible", ${opt}: ${val} });`,
      val === "true"
        ? `expect(_inst.elem?.classList?.contains("${opt}")).toBe(true);`
        : `expect(_inst.elem?.classList?.contains("${opt}")).toBe(false);`,
    ];
  } },

  // ── Option → DOM property dispatch ─────────────────────────────────
  // "constructing an Elem with an `id` option set the underlying element's `id` property"
  { test: /constructing\s+an?\s+\w+\s+with\s+an?\s+`?(\w+)`?\s+option\s+set.*(?:element'?s?|property).*`?\1`?\s+property|`?(\w+)`?\s+option\s+(?:sets?|assigns?)\s+the\s+(?:underlying\s+)?element'?s?\s+`?\2`?\s+property/i, build: m => {
    const opt = m[1] ?? m[2];
    return [
      `const _inst = new _SubjectCtor({ ${opt}: "__lld_probe__" });`,
      `expect((_inst.elem as any)?.${opt}).toBe("__lld_probe__");`,
    ];
  } },
];

// Exported for direct regression testing (src/ast.test.ts) -- a claim-in/code-out pure
// function is far easier to test against a real claims matrix than through deriveInline's
// full AstFacts-gated dispatch, and this catalog has bitten silent regressions twice: a
// merged pattern that only failed against a real validated-enum option, and a leftmost-match
// regex collision that produced wrong-but-still-passing code. Don't edit COMPONENT_PATTERNS
// without running the full claims matrix in that test file first.
/** Whether the pattern that claims this text reads its own match.
 *
 *  This is the membership rule from the header, asked at runtime. A pattern whose `build` takes the
 *  match adapts to what it captured, so the claim survives being reworded within the same vocabulary
 *  -- "the disabled attribute is set on the element" and "the readonly attribute is set on the
 *  element" both work. A pattern that ignores its match is keyed to the one sentence it was written
 *  from, and rewording silently drops the claim to pending.
 *
 *  The linter needs the difference: warning about a claim anchored to a *generalizing* pattern is a
 *  false alarm, and a warning nobody can act on is one people learn to ignore. */
export function matchIsGeneralizing(claim: string, source?: string): boolean {
  const winner = orderedMatches(claim)[0];
  if (!winner) return false;
  // Arity: `build: m => ...` declares a parameter, `build: () => ...` does not.
  if (winner.pattern.build.length === 0) return false;
  // A pattern that matched but produces nothing is not the one that anchored this claim.
  return winner.pattern.build(winner.match, source).length > 0;
}

/** Every pattern matching this claim, highest-priority-first, ties broken by array order.
 *
 *  Resolving by priority rather than raw array position means a specific pattern's win over a looser
 *  one survives future reordering or insertions rather than depending on staying physically earlier
 *  in the array. See ComponentPattern's `priority` field.
 *
 *  Shared so that "which pattern claims this text" has one answer: `matchIsGeneralizing` reporting
 *  on a different winner than `deriveComponentInline` actually uses would make the linter describe
 *  a test nobody runs. */
function orderedMatches(claim: string) {
  return [...COMPONENT_PATTERNS]
    .map((pattern, index) => ({ pattern, index, match: claim.match(pattern.test) }))
    .filter((c): c is { pattern: ComponentPattern; index: number; match: RegExpMatchArray } => c.match !== null)
    .sort((a, b) => (b.pattern.priority ?? 0) - (a.pattern.priority ?? 0) || a.index - b.index);
}

export function deriveComponentInline(claim: string, source?: string, parentClaim?: string): InlineDerived | null {
  for (const { pattern, match } of orderedMatches(claim)) {
    const code = pattern.build(match, source, parentClaim);
    // A pattern that matched but produced no lines (e.g. an expected capture group came back
    // empty) is not a real hit -- keep scanning instead of returning empty inspectCode.
    if (code.length === 0) continue;
    return { method: undefined, callArgs: [], inspectCode: code.join("\n") };
  }
  return null;
}
