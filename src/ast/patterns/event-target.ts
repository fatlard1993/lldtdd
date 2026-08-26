// EventTarget-vocabulary claim derivation: generates inline test code from claim wording
// for modules whose default export is a class extending EventTarget.

import type { InlineDerived, EventTargetClassInfo } from "../types.ts";

// ── EventTarget reactive-class derivation ─────────────────────────────
// Generates inline test code from vocabulary patterns without any helper file.
// The module must default-export a class that extends EventTarget.
// The adapter imports it as `_SubjectCtor` when constructorModulePath is set.
// Exported for direct regression testing (src/ast.test.ts) -- same reasoning as
// deriveComponentInline above.

/** Capabilities the emitted code reaches for, and the flag that has to back each one.
 *
 *  Checked against the *generated code* rather than per pattern, so a pattern added later is
 *  covered without its author remembering to guard it. That matters more than the small cost of
 *  matching a string: the guard exists precisely for the case nobody was thinking about. */
const REQUIRED_CAPABILITIES: ReadonlyArray<[RegExp, keyof EventTargetClassInfo]> = [
  [/_ctx\.subscribe\(/, "hasSubscribe"],
  [/_ctx\.destroy\(/, "hasDestroy"],
  [/\.isDestroyed\b/, "hasIsDestroyed"],
  [/_ctx\.batch\(/, "hasBatch"],
];

/** Derives a test for a reactive-context claim, or nothing.
 *
 *  `et` is absent unless the module default-exports a class extending EventTarget, and its flags say
 *  which parts of the reactive-context API that class actually has. Both gates matter: without
 *  them, any module with a default-exported constructor gets these patterns, so a plain
 *  `class Counter` with an `increment()` and a claim mentioning "subscriber" derives
 *  `_ctx.subscribe({ key, callback })` and reports the claim as **failing**, not pending. That is
 *  the mirror of a false pass and just as wrong: the run says the implementation disagrees with
 *  its own design document when this family never applied at all.
 *
 *  Anything it cannot build, it declines to build, and the claim stays pending. */
export function deriveEventTargetInline(claim: string, et?: EventTargetClassInfo): InlineDerived | null {
  if (!et) return null; // not a reactive-context class; this family says nothing about it

  const derived = deriveFromVocabulary(claim);
  if (!derived) return null;

  const code = derived.inspectCode ?? "";
  for (const [emits, capability] of REQUIRED_CAPABILITIES) {
    if (emits.test(code) && !et[capability]) return null;
  }
  return derived;
}

function deriveFromVocabulary(claim: string): InlineDerived | null {
  const ctor = `new _SubjectCtor({})`;

  if (/fires?\s+synchronously|before\s+the\s+next\s+line|no\s+async\s+tick|no\s+batching/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx["x"] = "test";`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }

  // "a destructured subscribe method still works standalone" -- proves the instance pre-binds
  // its own methods, so `const { subscribe } = ctx; subscribe(...)` doesn't need `.bind(ctx)`.
  if (/destructur.*(?:still work|stays?\s+bound|works?\s+standalone|without\s+its\s+original\s+receiver)/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `const { subscribe } = _ctx;`,
      `let _count = 0;`,
      `subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx["x"] = "test";`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }

  if (/key.scoped|only fires? for its key|other keys? do not trigger|does not trigger|not fire when.*key|subscriber.*not fire|different key/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "name", callback: () => { _count++; } });`,
      `_ctx["other"] = "test";`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }

  if (/receives?\s+the\s+new\s+value|callback\s+argument.*just\s+assigned|subscriber.*receives/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `_ctx.subscribe({ key: "x", callback: v => { _received = v; } });`,
      `_ctx["x"] = "test";`,
      `expect(_received).toBe("test");`,
    ].join("\n") };
  }

  if (/addEventListener|native\s+event\s+api|event\s+bus.*nothing\s+is\s+reinvented|subscriptions\s+are\s+addEventListener/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `_ctx.addEventListener("x", ({ detail }) => { _received = detail; });`,
      `_ctx["x"] = "test";`,
      `expect(_received).toBe("test");`,
    ].join("\n") };
  }

  if (/destroy.*stops?\s+(all|its|further|future)\s+(subscriptions?|notifications?)|stops?\s+all\s+future|subscriptions?\s+stop\s+firing\s+after\s+destroy/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx.destroy();`,
      `_ctx["x"] = "test";`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }

  // Assigning the same value as the current one is a no-op: no dispatch, no callback.
  if (/assign(?:ing)?\s+the\s+same\s+value\s+as\s+the\s+current\s+one\s+not\s+call\s+subscribers|same\s+value.*no\s+subscribers?\s+notified/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["x"] = "initial";`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx["x"] = "initial";`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }

  // Native EventTarget interop: { once: true } and { signal } work without library support,
  // since subscriptions dispatch through real addEventListener/removeEventListener.
  if (/listener\s+added\s+with\s+`?\{\s*once:\s*true\s*\}?`?\s+fire\s+only\s+once/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.addEventListener("x", () => { _count++; }, { once: true });`,
      `_ctx["x"] = "a";`,
      `_ctx["x"] = "b";`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }
  if (/listener\s+added\s+with\s+`?\{\s*signal\s*\}?`?\s+stop\s+when\s+the\s+signal\s+aborts/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `const _controller = new AbortController();`,
      `let _count = 0;`,
      `_ctx.addEventListener("x", () => { _count++; }, { signal: _controller.signal });`,
      `_ctx["x"] = "a";`,
      `_controller.abort();`,
      `_ctx["x"] = "b";`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }

  // Parser: transforms the value before delivery; a throwing parser delivers null for that
  // change instead of crashing, and the subscription stays alive for subsequent updates.
  if (/subscriber\s+receives?\s+the\s+parser'?s?\s+output\s+rather\s+than\s+the\s+raw\s+value/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `_ctx.subscribe({ key: "x", callback: v => { _received = v; }, parser: v => v.toUpperCase() });`,
      `_ctx["x"] = "test";`,
      `expect(_received).toBe("TEST");`,
    ].join("\n") };
  }
  if (/throwing\s+parser\s+not\s+crash\s+the\s+application/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx.subscribe({ key: "x", callback: () => {}, parser: () => { throw new Error("bad"); } });`,
      `expect(() => { _ctx["x"] = "test"; }).not.toThrow();`,
    ].join("\n") };
  }
  if (/subscription\s+continue\s+receiving\s+updates\s+after\s+a\s+parser\s+error/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _received;`,
      `let _first = true;`,
      `_ctx.subscribe({ key: "x", callback: v => { _received = v; }, parser: v => { if (_first) { _first = false; throw new Error("bad"); } return v; } });`,
      `_ctx["x"] = "a";`,
      `_ctx["x"] = "b";`,
      `expect(_received).toBe("b");`,
    ].join("\n") };
  }

  // Multi-key subscription: watches a list of keys via `keys`, delivers a snapshot object,
  // and coalesces to one notification when several listed keys change inside a batch.
  if (/callback\s+fire\s+when\s+any\s+listed\s+key\s+changes/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ keys: ["a", "b"], callback: () => { _count++; } });`,
      `_ctx["a"] = "1";`,
      `expect(_count).toBeGreaterThan(0);`,
    ].join("\n") };
  }
  if (/receive\s+a\s+snapshot\s+of\s+all\s+listed\s+key\s+values/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _snapshot;`,
      `_ctx.subscribe({ keys: ["a", "b"], callback: s => { _snapshot = s; } });`,
      `_ctx["a"] = "1";`,
      `expect(_snapshot).toHaveProperty("a");`,
      `expect(_snapshot).toHaveProperty("b");`,
    ].join("\n") };
  }
  if (/fire\s+once\s+when\s+multiple\s+listed\s+keys\s+change\s+inside\s+a\s+batch/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ keys: ["a", "b"], callback: () => { _count++; } });`,
      `_ctx.batch(() => { _ctx["a"] = "1"; _ctx["b"] = "2"; });`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }

  if (/isDestroyed.*true|true\s+after\s+destroy|stays\s+destroyed|there\s+is\s+no\s+reactivation|destroyed\s+context\s+stays/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx.destroy();`,
      `expect(_ctx.isDestroyed).toBe(true);`,
    ].join("\n") };
  }

  if (/destroy.*twice|second\s+destroy|does\s+not\s+reactivate|calling\s+destroy\s+a\s+second/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx.destroy();`,
      `_ctx.destroy();`,
      `expect(_ctx.isDestroyed).toBe(true);`,
    ].join("\n") };
  }

  if (/derived.*freezes?|stops?\s+updating.*destroyed|freezes?\s+at\s+its\s+last/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _source = ${ctor};`,
      `let _last = null;`,
      `const _sub = _source.subscriber?.("value");`,
      `if (_sub) _sub.subscribe(v => { _last = v; });`,
      `_source["value"] = 2;`,
      `const _frozen = _last;`,
      `_source.destroy();`,
      `try { _source["value"] = 3; } catch {}`,
      `expect(_last).toBe(_frozen);`,
    ].join("\n") };
  }

  // Constructor validation: null/array/undefined/string throw; plain object succeeds
  if (/constructing.*null.*throw|constructor\s+rejects\s+null|null.*\bthrow/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor(null)).toThrow();` };
  }
  if (/constructing.*array.*throw|constructor\s+rejects\s+array|array.*\bthrow/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor([])).toThrow();` };
  }
  if (/constructing.*undefined.*throw|constructor\s+rejects\s+undefined|undefined.*\bthrow/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor(undefined)).toThrow();` };
  }
  if (/constructing.*string.*throw|constructor\s+rejects\s+(?:a\s+)?string/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor("__lld_probe__")).toThrow();` };
  }
  if (/constructing.*plain\s+object.*succeed|plain\s+object.*succeed|constructor.*accepts.*plain/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: `expect(() => new _SubjectCtor({})).not.toThrow();` };
  }

  // subscriber(key, parser?): transparent live handle -- proxied access reads through to the
  // current value without unwrapping, and updates automatically as the property changes.
  if (/handle'?s?\s+properties\s+and\s+methods\s+behave\s+as\s+if\s+it\s+were\s+the\s+value/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["name"] = "abc";`,
      `const _h = _ctx.subscriber("name");`,
      `expect(_h.length).toBe(3);`,
      `expect(_h.toUpperCase()).toBe("ABC");`,
    ].join("\n") };
  }
  if (/reflect\s+changes\s+when\s+the\s+property\s+changes/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["name"] = "abc";`,
      `const _h = _ctx.subscriber("name");`,
      `_ctx["name"] = "xyz123";`,
      `expect(_h.length).toBe(6);`,
    ].join("\n") };
  }

  // batch(): coalesces same-key reassignments to one notification, delivering only the final value.
  if (/subscriber\s+fire\s+once\s+when\s+two\s+assignments\s+run\s+inside\s+a\s+batch/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `_ctx.batch(() => { _ctx["x"] = 2; _ctx["x"] = 3; });`,
      `expect(_count).toBe(1);`,
    ].join("\n") };
  }
  if (/see\s+the\s+final\s+value\s+rather\s+than\s+an\s+intermediate\s+one/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `let _seen;`,
      `_ctx.subscribe({ key: "x", callback: v => { _seen = v; } });`,
      `_ctx.batch(() => { _ctx["x"] = 2; _ctx["x"] = 3; });`,
      `expect(_seen).toBe(3);`,
    ].join("\n") };
  }

  // batch(): a thrown fn rolls back every change made inside it -- no subscribers, no leftover keys.
  if (/state\s+return\s+to\s+its\s+pre.batch\s+values\s+when\s+the\s+batch\s+function\s+throws/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["x"] = 1;`,
      `try { _ctx.batch(() => { _ctx["x"] = 99; throw new Error("fail"); }); } catch {}`,
      `expect(_ctx["x"]).toBe(1);`,
    ].join("\n") };
  }
  if (/subscribers\s+not\s+called\s+when\s+the\s+batch\s+function\s+throws/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["x"] = 1;`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "x", callback: () => { _count++; } });`,
      `try { _ctx.batch(() => { _ctx["x"] = 99; throw new Error("fail"); }); } catch {}`,
      `expect(_count).toBe(0);`,
    ].join("\n") };
  }
  if (/new\s+keys?\s+introduced\s+during\s+a\s+failed\s+batch\s+removed/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `try { _ctx.batch(() => { _ctx["newKey"] = "hello"; throw new Error("fail"); }); } catch {}`,
      `expect(Object.prototype.hasOwnProperty.call(_ctx, "newKey")).toBe(false);`,
    ].join("\n") };
  }

  // batchAsync(): same coalescing, deferred to a microtask; rejects (after rollback) on throw.
  if (/batchAsync\(\)\s+defer\s+execution\s+until\s+after\s+the\s+current\s+call\s+stack/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["x"] = 1;`,
      `let _ranSync = true;`,
      `const _p = _ctx.batchAsync(() => { _ranSync = false; _ctx["x"] = 2; });`,
      `expect(_ranSync).toBe(true);`,
      `await _p;`,
      `expect(_ctx["x"]).toBe(2);`,
    ].join("\n") };
  }
  if (/roll\s+back\s+and\s+reject\s+when\s+the\s+function\s+throws/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["x"] = 1;`,
      `let _rejected = false;`,
      `try { await _ctx.batchAsync(() => { _ctx["x"] = 99; throw new Error("fail"); }); } catch { _rejected = true; }`,
      `expect(_rejected).toBe(true);`,
      `expect(_ctx["x"]).toBe(1);`,
    ].join("\n") };
  }

  // notify(key): re-dispatches the current value with no assignment -- for in-place mutations
  // where the reference itself never changes, so the proxy's set trap never fires on its own.
  if (/notify\(\)\s+deliver\s+the\s+current\s+value\s+to\s+subscribers/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["list"] = [1, 2, 3];`,
      `let _received;`,
      `_ctx.subscribe({ key: "list", callback: v => { _received = v; } });`,
      `_ctx["list"].push(4);`,
      `_ctx.notify("list");`,
      `expect(_received).toEqual([1, 2, 3, 4]);`,
    ].join("\n") };
  }
  if (/fire\s+even\s+when\s+the\s+value\s+reference\s+is\s+unchanged/i.test(claim)) {
    return { method: undefined, callArgs: [], inspectCode: [
      `const _ctx = ${ctor};`,
      `_ctx["list"] = [1, 2, 3];`,
      `let _count = 0;`,
      `_ctx.subscribe({ key: "list", callback: () => { _count++; } });`,
      `const _ref = _ctx["list"];`,
      `_ctx.notify("list");`,
      `expect(_count).toBe(1);`,
      `expect(_ctx["list"]).toBe(_ref);`,
    ].join("\n") };
  }

  return null;
}
