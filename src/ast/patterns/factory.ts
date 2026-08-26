// Factory-function claim derivation: a reactive derive(selector, combiner, options) factory,
// and styled()/configured() higher-order component factories.

import type { InlineDerived } from "../types.ts";

// ── Reactive-derivation factory (a module exporting derive(selector, combiner, options)) ──
// A plain exported function, not a class -- separate from deriveEventTargetInline, which is
// gated on a constructible default export. Gated on the module actually exporting a function
// literally named `derive`, so this only fires for a module implementing this exact shape.
// "Derive" is the module-override alias the adapter assigns via moduleAlias() (basename of the
// module path, capitalized) -- the same mechanism every other **module:** override group relies on.
// Triggers below are short composable phrase-fragments (mirroring event-target.ts's style)
// rather than near-full-sentence matches, so a differently-worded claim about the same
// reactive-derivation vocabulary family generalizes instead of requiring identical wording to
// whatever claim this catalog was first derived from. Watch for ties after touching this array --
// a broad descriptive parent claim that enumerates several concepts in one sentence can match more
// than one fragment even when each fragment is individually well-scoped. src/ast.test.ts pins the
// exact derived output, so a tie that changes which fragment wins shows up as a snapshot diff.
export function deriveDerivationFactoryInline(claim: string): InlineDerived | null {
  if (/not\s+read.*recomputation|recomputation.*not\s+read/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ a: 1, b: 2 });`,
      `let _calls = 0;`,
      `const _d = Derive.derive(() => [_s.a], v => v);`,
      `_d.subscribe(() => { _calls++; });`,
      `_s.b = 99;`,
      `expect(_calls).toBe(0);`,
    ].join("\n") };
  }
  if (/reads?\s+nothing\s+reactive|only\s+static\s+values.*throw/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `expect(() => Derive.derive(() => [42], x => x)).toThrow();`,
    ].join("\n") };
  }
  if (/combiner.*order|order.*combiner/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1, y: 2 });`,
      `const _d = Derive.derive(() => [_s.x, _s.y], (a, b) => \`\${a}-\${b}\`);`,
      `expect(_d.toJSON()).toBe("1-2");`,
    ].join("\n") };
  }
  if (/subscriber.*fire.*input\s+change|new\s+derived\s+value/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1 });`,
      `const _d = Derive.derive(() => [_s.x], v => v * 2);`,
      `let _received;`,
      `_d.subscribe(v => { _received = v; });`,
      `_s.x = 5;`,
      `expect(_received).toBe(10);`,
    ].join("\n") };
  }
  if (/memoiz\w*.*not\s+notify|memoiz\w*.*unchanged/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1 });`,
      `const _d = Derive.derive(() => [_s.x], v => (v % 2 === 0 ? "even" : "odd"), { memoize: true });`,
      `let _calls = 0;`,
      `_d.subscribe(() => { _calls++; });`,
      `_s.x = 3;`,
      `expect(_calls).toBe(0);`,
    ].join("\n") };
  }
  if (/second\s+\w+\s+instance.*(?:update|change)|(?:update|change).*second\s+\w+\s+instance/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s1 = new _SubjectCtor({ x: 1 });`,
      `const _s2 = new _SubjectCtor({ y: 2 });`,
      `const _d = Derive.derive(() => [_s1.x, _s2.y], (a, b) => a + b);`,
      `let _received;`,
      `_d.subscribe(v => { _received = v; });`,
      `_s2.y = 10;`,
      `expect(_received).toBe(11);`,
    ].join("\n") };
  }
  if (/chain\w*.*upstream|upstream.*chain\w*/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1 });`,
      `const _d1 = Derive.derive(() => [_s.x], v => v * 2);`,
      `const _d2 = Derive.derive(() => [_d1.valueOf()], v => v + 1);`,
      `let _received;`,
      `_d2.subscribe(v => { _received = v; });`,
      `_s.x = 10;`,
      `expect(_received).toBe(21);`,
    ].join("\n") };
  }
  if (/fire\s+once.*batch|batch.*fire\s+once/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1, y: 2 });`,
      `const _d = Derive.derive(() => [_s.x, _s.y], (a, b) => a + b);`,
      `let _calls = 0;`,
      `_d.subscribe(() => { _calls++; });`,
      `_s.batch(() => { _s.x = 5; _s.y = 5; });`,
      `expect(_calls).toBe(1);`,
    ].join("\n") };
  }
  if (/derivation\s+subscriber.*destroy|subscriber.*derivation.*destroy/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _s = new _SubjectCtor({ x: 1 });`,
      `const _d = Derive.derive(() => [_s.x], v => v);`,
      `let _calls = 0;`,
      `_d.subscribe(() => { _calls++; });`,
      `_d.destroy();`,
      `_s.x = 99;`,
      `expect(_calls).toBe(0);`,
    ].join("\n") };
  }
  return null;
}

// ── styled()/configured() factory (a module exporting styled.js) ─────────────────────────
// Plain exported factory functions, not a constructible class, so -- like
// deriveDerivationFactoryInline -- this can't go through the constructorModulePath-gated
// catalogs. `_Companion` is the **companion:** module (the real base Component class to style);
// `Subject` is the namespace import of styled.js itself (Subject.styled / Subject.configured).
//
// Template-literal calls deliberately avoid native tagged-template syntax (`` styled(X)`...` ``):
// Bun's Proxy (styled() returns one with only a `construct` trap, for the 1-arg tag-function
// form) intermittently resolves `new TagResult(...)` to the underlying class itself rather than
// an instance after several prior Proxy-returning styled() calls in the same test file --
// verified empirically (fails ~5 calls in, passes in isolation). Calling the proxy as a plain
// function with a manually-built strings array (a real `.raw`-bearing array, exactly what a
// tagged template passes) reaches the same code path without going through `new` on the proxy,
// and was verified stable across 8 repeated calls in one file where the native form was not.
/** Whether a module's `styled` export is a component-class factory.
 *
 *  Every pattern below does `new Subject.styled(_Companion, ...)(...)` and reads `.elem` off the
 *  instance, so `styled` has to *return a class*. Exporting something called `styled` does not make
 *  it one: a one-line class-name joiner (`export const styled = (...n) => n.join(" ")`) matched the
 *  old gate and derived a test that reported the claim **failing** -- the author reading red for a
 *  premise they never wrote, rather than the pending this family should have produced.
 *
 *  `return class ... extends` is the signal, and it is the same thing the emitted code depends on. */
export function isComponentClassFactory(source: string): boolean {
  return /export\s+const\s+styled\s*=/.test(source) && /return\s+class\s+\w*\s*extends\b/.test(source);
}

// Triggers are short composable phrase-fragments over the styled()/configured() vocabulary rather
// than near-full-sentence matches, so a differently-worded claim about the same behavior generalizes
// instead of requiring the exact wording this catalog was first derived from -- the same style, and
// the same discipline, as deriveDerivationFactoryInline above. Every branch is still gated by
// isComponentClassFactory (real structure in the module source: a `styled` export that returns a
// class), so it only fires for modules that actually implement the shape; the fragments discriminate
// *which* invariant of that shape a claim is about. Order matters: the more specific fragment wins,
// so the two single-syntax and the two scope-identity branches sit after the ones that would also
// match their words. src/ast.test.ts pins the exact derived output, so a fragment that reroutes a
// claim to a different body shows up as a snapshot diff.
export function deriveStyledFactoryInline(claim: string, source?: string): InlineDerived | null {
  // `source` is optional so the regression matrix can exercise the patterns directly, but a real
  // derivation always has it -- see the call site in ast/dispatch.ts.
  if (source !== undefined && !isComponentClassFactory(source)) return null;
  const c = claim.toLowerCase();

  // configured() -- checked before the generic base-class-instance fragment, which its wording also
  // matches ("behaves like the base class").
  if (/\bconfigured\b/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.configured(_Companion, { tag: "span" });`,
      `const _a = new _A({ autoRender: false });`,
      `expect(_a instanceof _Companion).toBe(true);`,
      `expect(_a.elem.tagName).toBe("SPAN");`,
    ].join("\n") };
  }
  // Theme object interpolated into a template literal.
  if (/theme\s+object|interpolat/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `let _receivedTheme;`,
      `const _strings = Object.assign(["color: ", ";"], { raw: ["color: ", ";"] });`,
      `const _A = Subject.styled(_Companion)(_strings, (t: unknown) => { _receivedTheme = t; return "red"; });`,
      `new _A({ autoRender: false });`,
      `expect(typeof _receivedTheme).toBe("object");`,
      `expect(_receivedTheme).not.toBeNull();`,
    ].join("\n") };
  }
  // Both call syntaxes attach a scope class -- before the single-syntax fragments, whose words it
  // contains.
  if (/both\s+synta/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.styled(_Companion, () => "body { color: red; }");`,
      `const _strings = Object.assign(["body { color: blue; }"], { raw: ["body { color: blue; }"] });`,
      `const _B = Subject.styled(_Companion)(_strings);`,
      `const _a = new _A({ autoRender: false });`,
      `const _b = new _B({ autoRender: false });`,
      `expect(_a.elem.className.length).toBeGreaterThan(0);`,
      `expect(_b.elem.className.length).toBeGreaterThan(0);`,
    ].join("\n") };
  }
  if (/function\s+syntax/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.styled(_Companion, () => "body { color: red; }");`,
      `const _a = new _A({ autoRender: false });`,
      `expect(_a.elem.className.length).toBeGreaterThan(0);`,
    ].join("\n") };
  }
  if (/template\s+literal\s+syntax/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _strings = Object.assign(["body { color: red; }"], { raw: ["body { color: red; }"] });`,
      `const _A = Subject.styled(_Companion)(_strings);`,
      `const _a = new _A({ autoRender: false });`,
      `expect(_a.elem.className.length).toBeGreaterThan(0);`,
    ].join("\n") };
  }
  // Two calls -> different scope classes; two instances of one -> same scope class.
  if (/(?:different|distinct|separate)\s+scope\s+class/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.styled(_Companion, () => "");`,
      `const _B = Subject.styled(_Companion, () => "");`,
      `const _a = new _A({ autoRender: false });`,
      `const _b = new _B({ autoRender: false });`,
      `expect(_a.elem.className).not.toBe(_b.elem.className);`,
    ].join("\n") };
  }
  if (/same\s+scope\s+class|share.*scope\s+class/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.styled(_Companion, () => "");`,
      `const _a1 = new _A({ autoRender: false });`,
      `const _a2 = new _A({ autoRender: false });`,
      `expect(_a1.elem.className).toBe(_a2.elem.className);`,
    ].join("\n") };
  }
  // Generic: a styled instance is an instance of the base class. Last, since "base class" appears in
  // several claims above that have a more specific handler.
  if (/instance\s+of\s+the\s+base\s+class|behaves?\s+as\s+an\s+instance|instanceof/.test(c)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _A = Subject.styled(_Companion, () => "");`,
      `const _a = new _A({ autoRender: false });`,
      `expect(_a instanceof _Companion).toBe(true);`,
      `expect(typeof _a.render).toBe("function");`,
    ].join("\n") };
  }
  return null;
}
