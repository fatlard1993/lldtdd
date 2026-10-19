# lldtdd Grammar

The full assertion syntax: forms, outcome patterns, perspectives, and authoring guidance. For what an LLD is, why it exists, and what belongs in one, see [README.md](./README.md); this document assumes that and covers syntax only.

Writing your first document: [Document structure](#document-structure) for the skeleton,
[Assertion forms](#assertion-forms) for how to write a claim, and
[Deterministic outcome patterns](#deterministic-outcome-patterns) for what can go after the `->`.
The rest is for when a claim you want is not turning green. `examples/auth.lld.md` in this repo is
the shape to copy.

---

## Document structure

```markdown
# Module Name
> path/to/module.js          <- module pointer (non-relative = project-root; ./x = LLD-relative)

Prose description of the module's purpose and the key design intent.

## Group Name               <- behavioral category
**method:** `methodName`    <- default callable for this group (optional; see below)
**setup:** `expr(args)`     <- runs in beforeEach, result bound as _subject (optional)
**beforeAll:** `expr()`     <- runs once before the group, for expensive setup (optional)
**beforeEach:** `expr()`    <- runs before each test, void call (optional)
**module:** `path/to/alt.js` <- overrides the document-level module for this group only (optional)
**mock-http:** `{ "json": "shape" }` <- wraps the group's tests in withMockFetch with this response body (optional)

- assertion
- assertion
  - perspective question?   <- indented sub-question; derives a focused verification test
```

`**beforeAll:**` and `**beforeEach:**` can also appear at document scope, before any `## ` heading -- they become the default for every group that doesn't set its own. `**companion:**` (a base-class module for `styled()`/`configured()` factories, imported as `_Companion`) is document-scoped only, not overridable per group; see "Automatic derivation from module structure" below.

`**mutate:** false` is also document-scoped, and opts the document out of the mutation pass:

```markdown
# Module Name
> src/orchestrator.ts

**mutate:** false
```

Use it when the probe costs more than it tells you. The clearest case is a document whose claims
each drive a whole pipeline -- mutating that module re-runs every claim once per mutant, and what
the mutants flip is wiring the claims already exercise end-to-end. That is a judgment about this
document, which is why it lives in the document rather than in a config file. `lldtdd run --no-mutate`
still overrides it globally, and `lldtdd mutate <file>` run directly ignores it -- if you ask for
mutation explicitly, you get it.

Whether a group needs an explicit `**method:**` depends on what its module *is*, not on how the group is named. If the module matches one of the structural shapes in "Automatic derivation from module structure" below (an `EventTarget` subclass, a DOM component class, a class-based CLI parser, a caching-fetch client, a self-database module, a `createCRUD` or `createStore` schema, or a `derive()`/`styled()`/`configured()` factory), most claims resolve straight from vocabulary with zero annotation -- confirmed across this project's own example corpus, where every file of one of those shapes carries no `**method:**` at all. If the module is a plain function export with none of those shapes -- including lldtdd's own internals (`parser.ts`, `pipeline.ts`, `drift.ts`) -- the fallback is a conservative name-matching heuristic (`lldtdd suggest`) that guesses from the group heading against the module's exported function names, and it often can't: it returns nothing rather than guess wrong. For plain-function modules, expect to write `**method:**` explicitly on most groups. Run `lldtdd suggest <file>` any time you're unsure -- it reports exactly which groups it could and couldn't infer, before you commit to writing the annotation by hand.

A `**method:**` annotation applies to the *whole group* uniformly -- every assertion and perspective under that heading resolves through the same call, not a call chosen per-claim. If a group states two or more genuinely different behaviors (e.g. "delete removes the record" and "delete with a destination moves it instead"), giving them one shared method produces identical passing test code for both, which proves nothing about the difference between them. Split them into separate `##` groups, each with its own method, instead.

---

## Assertion forms

### Form 1: Condition -> Outcome
```
[N x] condition -> outcome [// prose explanation]
```
Used when there is a clear cause-and-effect split.

```markdown
- wrong credentials -> `AuthError`
- 3 x _subject("same-key") captures r -> r.allowed === false
- getTotal("empty-sess") -> total is zero
- read with unknown id -> false, not null
```

The `[N x]` prefix runs the condition N times before the final assertion (sets up state).

### Form 2: Invariant (no arrow)
```
[subject] statement [// prose explanation]
```
Used for universal properties, safety invariants, and ordering claims.

```markdown
- setting a key nobody has subscribed to is safe // no error, no effect
- subscribers fire synchronously, before the assignment returns
- subscribe takes { key, callback }, not positional arguments // subscribe("key", fn) does not work
- destruction is one-way // a destroyed context cannot be reactivated
```

**An invariant on its own does not become a test.** These are design statements; the grammar has
no way to check one without inventing a criterion the author never wrote. An invariant stays
pending unless it carries a perspective or an inline call, or an AST pattern recognizes it.

A no-throw check is not a check of "subscribers fire synchronously"; it is a check of nothing in
particular, wearing that claim's name -- it would report **passing** against an event bus whose
`publish()` had been gutted to an empty body.

Some phrases resolve to a concrete assertion on their own, because the phrase itself names one:

| Phrase pattern | Maps to |
|---|---|
| `returns a function` | property: typeof-function |
| `returns an object` | property: typeof-object |
| `returns N`, `fires once`, `fires zero times` | equals N |
| `output contains a sentinel/marker`, `includes a substring` | contains |
| `field is absent/not present/not populated` | absent |
| `a failed X does not stall/block/crash Y` | fault-resilience (needs a resolvable fault target) |
| `only declared fields survive`, `undeclared fields are dropped` | schema-drop |

These do not resolve on their own, because no-throw is the only check they could produce --
`X is safe`, `does nothing`, `does not throw`, `no error`, `is a valid state`, `does not
affect/fire/receive/create/store/…`, `can [be] verb`, `requires no X`, `need not`, `is
structural`, `returns a list/array`. Write the invariant as prose (that is what it is for) and
hang the check off it:

```markdown
- publishing to an unsubscribed topic does nothing // no error, no effect
  - publish("nobody-listening", { id: 1 }) -> resolves
```

An explicit `-> resolves` is still a no-throw check, and that is fine: there the author chose it,
and the call named the condition it is a check of. The difference is who decided.

A claim whose only assertion is no-throw reports as **`◐ shallow`**, not `✓ passing` -- a real green
(the call ran) held apart from a claim that also checked what the call returned or did, because a
no-throw-only claim stays green against a gutted implementation. It is not an error: `run` exits 0
and a document may legitimately mean only "this runs." `lint` names it, and `run --fail-on-weak`
fails on it, for a corpus that wants every green to check a behavior. To strengthen one, give it a
perspective that asserts the result (`-> resolves with \`{ ok: true }\``, a captured value, a spy).

### Form 3: Inline call with captures

A chain of one or more calls, each binding its own capture, joined by `and` or `then`:

```
method(args) captures varName -> assertion
method1(args) captures varA and method2(args) captures varB -> assertion
method1(args) captures varA then method2(args) captures varB then method3(args) captures varC -> assertion
```

There is no limit on chain length. `and` and `then` mean the same thing to the parser -- pick
whichever reads correctly -- and every capture is in scope by the time the next call is emitted,
so a later call can reference an earlier result by name:

```markdown
- create({ name: "Original", url: "x" }) captures r then update({ id: r.id, update: { name: "Renamed" } }) captures result → result.name === "Renamed"
- create({}) captures r then read({ id: r.id }) captures found → found.name === ""
- login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- login("a@b.com", "p1") captures tokenA and login("b@b.com", "p2") captures tokenB -> tokenA.token !== tokenB.token
```

**Calls run in the order written**, which is why chain length matters: for a whole class of claim
the ordering *is* the design decision, and it takes as many steps as it takes to set up. Three
calls is the shape of most "one participant misbehaves, the others carry on" claims:

```markdown
- a throwing handler does not prevent subsequent handlers from running
  - subscribe("orders", thrower) captures u1 then subscribe("orders", spy) captures u2 then publish("orders", { id: 1 }) captures sent -> spy called
```

That claim is only distinguishable from its neighbour ("a throwing handler's error does not
propagate to the publisher") by a bus that both swallows the error *and* keeps looping -- a
two-call chain cannot separate them, and an implementation that swallowed the error but stopped
the loop would satisfy the shorter form.

Every step must bind a capture. A chain with a step that doesn't (`a(1) captures x then b(2)`) is
not treated as a partial chain -- deriving from the readable prefix would check something narrower
than the claim states -- so the condition falls back to non-chain handling, which usually means
pending.

After a chain, the available outcomes are the inspect assertions below, the spy outcomes in Form
3b, and `-> resolves`. `-> throws` is not among them: a claim cannot both capture a call's result
and expect that call to throw.

### Arguments that have to be computed

Most arguments are literals. Four forms are passed through as code instead: an object or array
literal, `new X(...)`, a bare or dotted identifier (which is how a chain references an earlier
capture), and **any argument that opens with `(`**:

```markdown
- searchProvider((await Subject.create({ label: "L", url: "https://x/?q=:term" })).id, "x") captures r -> r.length === 2
```

Use it when the value cannot be written down because it does not exist until the test runs -- a
generated id being the usual case. `Subject` and any group-`**module:**` alias are both in scope,
so this is also how a claim reaches a second module: create through one, call through the other.

Everything else is a string, including unquoted prose, which is what lets a claim name a condition
it has not made concrete yet (`addItem(a valid session)`). That is why the leading parenthesis is
required rather than inferred: prose does not open with one. An argument whose brackets do not
close stays a string too, rather than becoming a fragment that cannot compile.

### Form 3b: Callback handlers: `spy` and `thrower`

A claim about a callback API has to name the handler it registers. Two reserved identifiers can
appear anywhere an argument can, and only these two carry behavior the runner supplies:

| identifier | is | ask about it with |
|---|---|---|
| `spy` | a recording no-op | `-> spy called` / `called once` / `called with ...` / `not called` |
| `thrower` | a handler that throws | usually paired with `-> resolves` on the publisher |

Because a chain runs its calls in the order written, the *ordering* can be the claim:

```markdown
- subscribing after a publish does not receive that event
  - publish("orders", { id: 1 }) captures sent then subscribe("orders", spy) captures unsub -> spy not called
- a throwing handler's error does not propagate to the publisher
  - subscribe("orders", thrower) captures unsub then publish("orders", { id: 1 }) captures sent -> resolves
- a throwing handler does not prevent subsequent handlers from running
  - subscribe("orders", thrower) captures u1 then subscribe("orders", spy) captures u2 then publish("orders", { id: 1 }) captures sent -> spy called
```

Both handlers can appear in one chain, in the order they are registered -- which is what makes the
last claim checkable at all.

When a claim registers `spy` itself, the runner asserts on it directly and does **not** insert a
subscribe of its own -- otherwise it would silently reorder the very sequence being claimed. When
a claim uses a spy outcome *without* naming `spy`, the runner subscribes one for you, reading
`subscribe.length` off the implementation to decide between `subscribe(handler)` and
`subscribe(topic, handler)`; a topic-keyed API gets the call's first argument as its topic.

---

## Perspectives

A perspective is an indented bullet under a claim. The claim states the design decision; the
perspective is the concrete, checkable form of it. Most verification in a mature document lives here,
not in the claims.

```markdown
- a bookmark belongs to at most one category
  - does the category field hold a string value?
```

**A perspective attaches to the bullet immediately above it.** This is the single easiest thing to get
wrong, and it fails silently: the perspective still runs, still passes, and verifies the wrong claim.
It happens when a rationale bullet sits between a claim and its perspective --

```markdown
- only one position class is active at a time; switching position replaces      <- the claim
- callers can safely reassign position without manual cleanup                   <- rationale
  - does changing position leave only the new class active?                     <- binds to the rationale
```

The check above proves the first bullet and is filed under the second, so the claim it verifies still
reads as pending. Keep rationale in the section prose and bullets for claims, and the problem cannot
arise.

### Two forms

A perspective is either an English question, which derives if a pattern recognises it, or a concrete
call, which needs no pattern at all:

```markdown
- `readOnly: true` omits the input and add button entirely
  - does a readOnly TagList contain no input element?                    <- derived

- clicking a column header updates `sortProperty` and `sortDirection`
  - new Subject({ columns: [{ key: "name", sort: true }], data: [{ name: "b" }] }) captures t
    then t.elem.querySelector("th").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    -> t.options.sortProperty === "name"                                 <- concrete
```

Reach for the question form first: it is shorter, it reads as design, and it costs nothing if a
pattern already covers the shape. Reach for the concrete form when the claim is about *intent* --
priority ordering, cleanup replacing rather than accumulating, a gesture threshold. Intent is not in
the source, so no amount of derivation will find it, and a claim like that stays pending forever
unless somebody writes down what it means.

One perspective per claim is the common case, but write as many as the claim has separable halves. A
claim with two directions ("blocked when read-only, preserved when it was already drawn") wants both,
because either alone passes against a component that does nothing at all.

### A perspective can set up its own state

Derived patterns construct the component and drive it; they cannot know that a sheet must be shown
before a drag can dismiss it. A concrete perspective simply says so:

```markdown
- dragging past a distance threshold triggers `hide()`
  - new Subject({ appendTo: document.body }) captures s then s.show() then ... -> ...
```

That is why "this claim needs a starting-state mechanism" is usually wrong. It is true of the pattern
path and false of the perspective path.

### Vocabulary comes from the claim above

A perspective is written as a follow-on and inherits the claim's nouns -- "does the Tooltip component
exist after construction?" names no member because the claim above already said "it exists as
`this._tooltip`". Patterns read the parent for exactly this. What gets *asserted* still comes from the
perspective; the parent only supplies vocabulary, so a parent mentioning a delay cannot retarget a
child asking about existence.

## Prose separator

Use ` // ` (space-double-slash-space) to append an explanation to any assertion.

```
- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- unrecognized input returns itself, not null // callers can distinguish unrecognized from absent
```

The text after ` // ` is stripped before matching: it is for the reader, not the runner.

**Why ` // `**: space-double-slash-space never conflicts with URL paths (`https://` has no leading space), flag names (`--no-flag`), or any other content likely to appear in an LLD.

---

## Deterministic outcome patterns

When the outcome (right side of `->`) matches one of these patterns, the test is derived directly
from the rule; no inspection of the implementation is needed.

Every rule in this file is offline and reproducible. A claim either matches something documented
here or an AST pattern in the implementation, or it stays pending; nothing is guessed at, and the
same document always derives the same suite. If a claim you care about is pending, this file is
the list of shapes that would make it concrete.

### Error throws
```
-> `ErrorClass`
-> `ErrorClass("message")`
-> throws
```

### Value equality
```
-> false
-> true
-> null
-> undefined
-> zero  /  0
```

To assert on a property, capture the result and name it: `call(...) captures r -> r.allowed === true`.
A captured property check says which property, on which call, and generalizes to any module; a
bare value-word like `allowed` would hard-code one module's property name and silently pend on
every other.

### Resolves (no throw)
```
-> resolves
-> no error
-> returns
```

### Shape
```
-> `{ field: Type }`       (structural match)
-> resolves with `{ ... }`
```

### Spy / callback assertions (needs a **setup:** with `_subject`, or a claim that names `spy` in its own call)
```
-> handler called
-> handler called once / twice / N times
-> handler called with the event
-> not called
-> all called
```

### Inspect (requires `captures`)
```
-> result.X does not contain "Y"
-> result.X is within N hours from now
-> result.X === "literal"
-> result.X !== result.Y
-> result.X is defined / is not defined
-> result.X is not a TypeName
-> result.X is an Array
-> result.X starts with "prefix"
-> result[0] === value
-> result.X is a string / number / boolean / Date / function
-> result.X > N
-> result.X >= N
-> result.X < N
-> result.X <= N
```

### Substring / sentinel assertion
```
-> contains "text"
-> does not contain "text"
```

### Conditional field absence
```
-> absent
-> absent when not provided
-> undefined
-> not present
```

---

## "not" qualifier on outcome

When the outcome contains `, not Y`, it generates a primary assertion AND a secondary negation.

```markdown
- read with unknown id -> false, not null
```
-> primary: `expect(result).toEqual(false)`
-> secondary: `expect(result).not.toBe(null)`

---

## The hybrid pattern

When an assertion implies a specific test input that can't be synthesized from the description alone, add an inline call as execution evidence:

```markdown
## Login
**method:** `login`

- wrong password -> `AuthError`                                     <- design assertion
- login("user@example.com", "wrongpass") -> `AuthError`             <- execution evidence
```

The design assertion documents the decision. The inline call proves it holds against the actual implementation. They are not redundant: the first says WHY, the second verifies it.

---

## Cross-module evidence

An LLD's `> module.js` header sets the default module for the whole file. When a design contract is best evidenced by a different module, use `**module:**` on the evidence group:

```markdown
# Persistence
> server/database/database.js

## Schema enforcement
**module:** `server/database/bookmarks.js`

- only declared fields survive a write
- missing fields default to empty string, not null
```

The `**module:**` override applies only to that group. The rest of the LLD still uses the document-level module. This pattern is for when the contract's evidence naturally lives in a collaborating module.

---

## Source-embedded scenarios

For modules with complex behavior that can't be derived from vocabulary alone, the recommended approach is to export zero-arg scenario functions directly from the source module. These functions exercise the behavior and return a verifiable value.

```js
// In Router.js:
export const hashStripsQueryString = () => {
  const r = new Router({ views: { '/path': Component }, autoRender: false });
  window.location.hash = '#/path?query=1';
  return r.path; // "/path"
};
```

Then in the LLD:
```markdown
## Query strings are stripped before route matching
**method:** `hashStripsQueryString`

- `#/path?foo=bar` matches the `/path` route: query strings are stripped before matching
  - hashStripsQueryString() → "/path"
```

This pattern is particularly useful for:
- Pure logic (routing, date arithmetic, value transformations)
- Multi-step state sequences (add duplicate → count unchanged)
- Scenarios involving internal state that isn't directly observable from the outside

---

## Automatic derivation from module structure

lldtdd derives tests directly from source code structure without requiring any annotation for several common module types. Every pattern that does this is **structural**: gated on the module's actual shape (e.g. "exports a default class extending `EventTarget`"), and matched against claim text via phrase *families* with capture groups rather than fixed sentences. They work for a brand-new module of the matching shape and a claim that has never been written before, as long as it uses the vocabulary family. EventTarget, class-based CLI parsers, DOM components, caching-fetch clients, and `createCRUD` and `createStore` schemas all work this way.

The membership rule is mechanical, not a judgment call: a pattern must be **gated on the module's real shape** and **keyed on a vocabulary family, never on one hand-transcribed sentence.** Most read capture groups and build the test around what they captured, so they adapt to a claim never written before. A few target a fixed module contract whose invariants have no value to lift from the claim (the `styled()` and `derive()` factories below); those emit the contract's test but still trigger on phrase-fragments, so rewording within the vocabulary still derives it. What does not belong is a pattern keyed to the exact wording of one claim -- that is a lookup table from a sentence to a hand-written body, not derivation.

If you write a claim against a module in one of the shapes below and it doesn't resolve, check with `lldtdd run --verbose` or `lldtdd suggest`, and reach for `**method:**` or a perspective rather than assuming the shape isn't recognized at all.

### EventTarget reactive classes

When a module exports `export default class X extends EventTarget`, lldtdd automatically derives tests from behavioral vocabulary:

| Claim vocabulary | Derived test |
|---|---|
| "fires synchronously / before the next line" | subscribe-count: `ctx.subscribe({key, callback}); ctx[key] = val; expect(count).toBe(1)` |
| "key-scoped / only fires for its key / not fire when different key" | subscribe-silent: subscribe A, set B, expect 0 fires |
| "receives the new value / callback argument" | subscribe-received: capture callback arg, assert equals assigned value |
| "addEventListener / native event API / event bus" | addEventListener path: raw `addEventListener` subscription fires |
| "destroy stops / stops future notifications" | subscribe-then-destroy: subscribe, destroy, set, expect 0 fires |
| "isDestroyed / stays destroyed / no reactivation" | destroy-and-check: destroy, check `isDestroyed === true` |
| "destroy twice / second destroy / idempotent" | destroy-twice: double destroy, `isDestroyed` still true |
| "derived state freezes / stops updating" | subscriber freeze: source destroyed, derived value unchanged |
| "constructor rejects null / array" | throw test: `expect(() => new X(null)).toThrow()` |
| "constructor accepts plain object / succeeds" | resolves test: `expect(() => new X({})).not.toThrow()` |

Fully generalized: any module of this shape, any claim using this vocabulary, no `**method:**` needed. (Constructor-throw/resolves tests fire for any constructible default export, not just `EventTarget` subclasses specifically.)

### Component UI classes

When a module exports `export default class X extends Y` (non-EventTarget), lldtdd derives tests from
the vocabulary families below. Every one of them is **structural**: it reads its values out of the
claim text or out of the module's own declarations, so it fires for a component and an option name it
has never seen. There is no per-project catalog and no named fixtures.

Several families need to construct the component the way its author intended, and they read that from
the module: a `static schema`, JSDoc `@param` lines, or a TypeScript `options` type. If the module
declares an option they cannot type and does not mark it optional, they decline rather than guess --
constructing with a wrong value throws inside the component and reports a correct implementation as
broken. `--verbose` says which claims resolved and which did not.

**Construction and instance state**
| Claim vocabulary | Derived test |
|---|---|
| "does `isDirty` return false when the value matches the initial value" | `new X({})` then `expect(inst.isDirty).toBe(false)`. Fresh-instance conditions only -- a claim about state *after a change* is declined, because construction cannot produce it |
| "does a X have `isReady` / `reset()`" | `expect(inst).toHaveProperty(...)` |
| "the `disabled` attribute is set on the element" | `new X({ disabled: true })` → `elem.disabled \|\| elem.hasAttribute("disabled")`. The attribute name is captured, so any boolean HTML attribute works |
| "constructing an Elem with an `id` option sets the element's `id` property" | option name captured, asserted on the element |
| "an invalid `variant` value throws" / "there are N valid `variant` values; anything else throws" | `expect(() => new X({ variant: "__lld_invalid__" })).toThrow()` |
| "does a Link with `variant: 'button'` remain an anchor element" | asserts `tagName` after construction |
| "does a readOnly Select contain no input element" | `new X({ readOnly: true })`; asserts the named element is absent |
| "does a X with `lineWidth` 10 have a higher `blur` than one with `lineWidth` 2" | builds both and compares the named property |

**What construction renders**

Each of these reads its target out of the claim. Where a claim leaves the target to the reader -- "an
identifiable class", "renders inline" -- it stays pending rather than having one guessed for it.

| Claim vocabulary | Derived test |
|---|---|
| "does a Page element have `height: 100%` applied at construction" | asserts `elem.style.height`; property and value both come from the claim |
| "does each radio input in the group share the same `name` attribute" | fills the module's list option with two entries, requires two elements back, and asserts the attribute is shared *and* non-empty |
| "does a List render a mix of string and object items without failing" | builds the module's one list option with a string and an object, asserts no throw. Declines when the module declares more than one list, since the claim gives no way to choose |
| "does code with newlines render as a block (`pre`)" | sets the named option to multi-line content, asserts `tagName` |
| "does the `language` option add an identifiable class" | needs the claim above it to spell out the template -- "adds a `language-{name}` class" -- and substitutes the option's declared value |

**Options changing what is rendered**
| Claim vocabulary | Derived test |
|---|---|
| "changing `position` from top leaves only the new class" | asserts the old class is gone and the new one present |
| "setting `collapsed: true` hides the panel" / "setting `openOnRender: false` prevents ..." | option set, effect asserted |
| "does updating the `label` option change the label's content without replacing its structure" | compares the subtree across the assignment |
| "does calling `render()` twice leave exactly one copy" | compares child count across a second call |

**Driven in a real DOM** (mounted, with the clock under test control)
| Claim vocabulary | Derived test |
|---|---|
| "`autoOpen: true` queues `show()` after 200ms" | watches `show`, asserts not called at 199ms and called at 200ms |
| "does hovering for longer than 700ms show the tooltip" | hovers, compares rendered output across the threshold |
| "does leaving before 700ms prevent the tooltip from appearing" | hovers, leaves early, waits past the deadline, then compares against the same instance allowed to show |
| "does clicking a menu item invoke `onSelect`" / "pressing Enter on a focused item" / "hovering" / "typing" | constructs with the callback, drives the real event sequence, asserts it fired |
| "does calling `hide()` invoke the `onClose` callback" | same, with a method call as the trigger |
| "does destroying the wrapper also remove the tooltip from the DOM" | asserts nothing the component rendered is still connected |

**Reading the claim above**

A perspective inherits vocabulary from the claim it hangs under, and a few families read it. "Does the
Tooltip component exist after construction?" names no member; the claim above it says "it exists as
`this._tooltip`", and that is where the member comes from. Context only -- what gets asserted always
comes from the perspective itself. A perspective whose parent does not spell out the identifier stays
pending rather than guessing at it.

### Claims that need a real browser

A few design decisions are about *layout* -- a textarea growing to fit its content, a popover flipping
at a viewport edge, two elements sitting side by side. happy-dom computes no layout, so it reports 0
for every measurement, and those claims cannot be answered there at any effort.

Mark the group and its scenarios run in headless Chrome instead:

```markdown
## Textarea height follows content automatically

**browser:** true

- when `tag: 'textarea'`, the element resizes to fit its content without the caller managing height
  - new Subject({ tag: "textarea", appendTo: document.body }) captures i then i.elem.offsetHeight captures before then i.elem.value = "a\nb\nc" then i.elem.dispatchEvent(new Event("input", { bubbles: true })) then await new Promise(r => setTimeout(r, 60)) -> i.elem.offsetHeight > before
```

The module is bundled and loaded into a real page, with its default export bound to `Subject`, so the
claim runs against the same code every other claim runs against. Chrome is driven over the DevTools
Protocol directly -- there is no Playwright or Puppeteer dependency, and no browser download. It is
found on `PATH`; if there is no browser, those claims stay **pending**, because the question was never
put to anything.

Marking is per group and is not inherited: a browser costs seconds, so it applies only where asked.

**What does not derive**

These are worth stating plainly, because a claim that looks like the ones above but names a
consequence only the component can define will stay pending no matter how it is worded:

- effects that need the component's own semantics -- "does clicking a sortable column update
  `sortProperty` to that column's key", colour-space maths, canvas pixel state, calendar layout
- gestures: nothing yet drives a drag, so drag-threshold claims stay pending
- navigation: no hashchange or route driving
- ordering between two effects: "does the sheet animate out *before* calling `onClose`"

For any of these, write a perspective carrying a concrete call. That is the intended answer, not a
fallback: a perspective lives in the document where a reader auditing the design can see it, it is
keyed by position rather than by a fuzzy regex over English, and rewording the claim above it cannot
silently unanchor it.

### Class-based CLI parsers

When a module exports `export default class X` that assigns `this.options = ...` in its constructor, lldtdd derives tests for the command/flag/tail argument model directly from claim vocabulary, no `**method:**` annotation needed:

| Claim vocabulary | Derived test |
|---|---|
| "declared command consumes the first word" | `argv: ["build", "--flag", "val"]`; `_a.command === "build"` |
| "command word precedes flag resolution" | same argv; `_a.options.flag === "val"` |
| "tail argument captures its slot after all flags are consumed" | `argv: ["--flag", "val", "target"]` with a `tail` config; `_a.options.target === "target"` |
| "spanning all three categories" (command + flag + tail together) | one argv exercising all three; asserts all three |
| "does not appear in the options object" / "no default, absent when not provided" | unset flag; `_a.options.flag === undefined` |
| "zero exit code" (`--version`/`--help`/`-h`) | parse, catch, assert exit code `0` |
| "non-zero exit code" | parse an unknown flag, catch, assert exit code `1` |
| "registered in every schema by default" + "disabled or replaced" | `--help` with `defaults: { config: { help: false } }`; expect throw |
| "parse: false runs option registration immediately" | construct with `parse: false`; assert `flagNames`/`requiredOptions` populated before `.parse()` runs |
| "flag-like string after `--` remains unparsed" | `argv: ["--", "--flag"]`; flag absent, `passThrough` contains it |
| "flag before `--` still parses correctly" | `argv: ["--flag", "val", "--", "extra"]`; flag still resolves |

A second, complementary path resolves `result.FIELD === VALUE` / `result.FIELD → absent` / throw assertions against a synthetic `__lld_api` description (usually auto-generated from the module's TypeScript types) -- this is what lets a bare `**method:**` group with no other annotation derive real `process.argv` + parse-and-assert code for arbitrary flag names, types (boolean, integer, alias, negation, `--flag=value`, pass-through), matched to the field's declared type rather than a hardcoded example.

Fully generalized: any class-based parser of this shape, any claim in this vocabulary. One ordering caution if you're editing the derivation itself: "non-zero exit code" must be checked before "zero exit code" -- a looser zero-exit check placed first will silently swallow a non-zero-exit claim.

### Text transformers, pipeline chains, and structural comparators

One family covers modules whose exported plain functions form a processing pipeline. Every
vocabulary in it is gated on facts read from the module's own signatures, so it fires for
functions it has never seen and declines, leaving the claim pending, when the shape is absent:

- **Text transformers** are exported `(string, ...) → object` functions in a module that
  demonstrably parses a structured text format. Detection requires format-token evidence in the
  source (short `.startsWith("# ")`-style markers), and the synthetic valid input for the derived
  call is built from those very tokens. The token gate is load-bearing: string-in, object-out is
  one of the most common signatures there is, and without the gate any comparator taking a
  `beforeSource: string` would classify as a text parser.
- **Pipeline chains** are detected when one exported function's return type is another exported
  function's first-parameter type (`Promise<T>` unwraps, and `export { X } from "Y"` re-exports
  are followed). A claim about a late stage then derives its whole setup: each predecessor runs in
  order, with a text transformer at the root producing the first input.
- **Structural comparators** are exported `(T, T) → changes[]` functions where both parameters
  share a `Record<string, Interface>` type. Before/after snapshots are synthesized from the
  interface's own declared properties, one scenario per drift kind (a parameter added, nothing
  changed, an export removed, an export renamed, and guard or try/catch removal where the
  interface declares those fields).

| Claim vocabulary | Derived test |
|---|---|
| "pipeline stage ... calls X" (needs a detected chain ending at X) | runs every predecessor stage in order, feeding the root a synthetic structured-text input, then calls X with the last output and asserts a defined result with populated groups |
| "text transformer parses structured text input into a document object" | calls the detected transformer with the synthetic input built from the module's own format tokens; asserts a document whose `groups` are populated |
| "code processor processes source code input and returns an array" | same call shape, for a transformer whose declared return type is an array; asserts a non-empty array |
| "structural comparator ... calls X" | synthesizes before/after snapshots from the shared interface and calls X; "identical" / "no change" / "unchanged" wording asserts an empty changes array, anything else asserts a non-empty one |

Four further scenarios in this family exercise a class-based CLI parser's transform machinery,
and they gate exactly as the CLI family above does: on a constructible default export that
declares `parse()`. These scenarios are reachable from raw claim prose, so the gate is what keeps a
non-parser module with transform-flavored claims from deriving a parser test it can only fail;
`src/family-coverage.test.ts` pins that such a module declines and the claims stay pending.

| Claim vocabulary | Derived test |
|---|---|
| "transform map is replaceable" / "replacing string transform" | constructs the parser with a replaced string transform and asserts a flag value passed through it |
| "per-flag transform replaces" / "flag-level transform overrides" | a flag-level `transform` overrides the built-in type coercion; asserts the transformed value |
| "custom test receives coerced value" / "parse fails on invalid value" | a flag `test` that rejects its value makes `parse()` throw |
| "rest tail captures" / "remaining tokens ... array" | a `rest: true` tail collects the remaining tokens into an array |

### CRUD entities

When a module exports (or re-exports) an entity built with `createCRUD(name, fields)` or `createStore({ collection, fields, hooks })`, lldtdd derives tests from schema shape and claim vocabulary. A `createStore` call's fields can be a list of names, a map of defaults, or a map of typed specs (`{ type, required, default }`), written inline or through a `const`; its collection has to be a literal string. Its hooks are read from its own `hooks` option.

| Claim vocabulary | Derived test |
|---|---|
| "a name and X are the only required fields" / "create with required fields" | minimal `create()` call using just the required fields, asserts it resolves |
| "only declared fields survive a write" | write extra undeclared fields, read back, assert they're absent |
| "missing fields default to empty string, not null" | write with a field omitted, read back, assert `""` not `null` |
| "deleting a category removes or reassigns its bookmarks -- no bookmark is left orphaned" | derived from `AstFacts.foreignKeys` -- create parent + dependent, delete parent, assert dependent is gone |
| "if a destination category is provided, affected bookmarks are moved to it" | same FK derivation, with a destination argument -- assert the dependent's FK now points at the destination |
| "a snapshot is taken before the operation; any failure mid-loop restores them" | same FK derivation, with a forced mid-loop failure -- assert original records are restored |
| "creating two entities produces an array" / "categories are a flat collection" | create two records, call the read-all method, assert an array of length ≥ 2 |
| "changing one entity's category affects only that entity" | create two records sharing a context, mutate one, assert the other is unchanged |

The FK-derived patterns (orphan-delete, move-delete, snapshot-restore) read `AstFacts.foreignKeys` directly from the module's exports -- they aren't hardcoded to `bookmarks`/`categories` specifically, so they generalize to any CRUD entity with a detected foreign-key relationship. The self-database claims (write-queue ordering, fault recovery) match on short phrase-fragments (`order`/`structural`, `fail`/`recover`) rather than one exact sentence, and are gated on `facts.isSelfDatabase` -- a module with an `init`, a `write()` and a `db`, and no imported database. The queue itself is detected by shape (a property seeded with `Promise.resolve()` and reassigned from itself), not by being named `_writeQueue`; `lld/fixtures/selfdb.ts` is a synthetic module that pins that.

A `createStore` collection gets the same two claims, because the store queues each change behind the last. They derive against the store: two concurrent `create()` calls with the first write slowed down must finish in the order they were made, and a `create()` whose write fails must not stop the next one. The writes are reached as the database module's `db` (or the module itself when it is the writer). A store whose changes don't take turns fails the order claim rather than passing on timing; `lld/fixtures/stock.lld.md` and `lld/fixtures/loose.lld.md` pin both. A document about persistence points these claims at a collection with a `**module:**` override.

Field defaults are checkable where the fields are *declared* -- see "missing fields default to
empty string" in the CRUD table above. A claim that a raw store defaulted a field it was never
told about is satisfiable by nothing; point such a claim at the module that declares the fields,
with a `**module:**` override if the document is about persistence.

### Caching-fetch clients

Gated on two structural signals together, because either alone is far too common: the module exports
functions named after HTTP verbs (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), **and** its result
carries a network state (`isFetching`) alongside an `idle`/`loading`/`success`/`error` data state.
That pair is the signature of the caching-data-fetching niche -- the vocabulary React Query, SWR and
their relatives share -- rather than any one library's invention.

| Claim vocabulary | Derived test |
|---|---|
| `enabled: false` + "idle" | call with `enabled: false`; `status === "idle"` |
| `enabled: false` + "does not hit / never fetches / response empty" | counting fetch stub; 0 calls, falsy response |
| "2xx" / "success" + "status" | 200 stub; `status === "success"` |
| "isFetching" + "settles / back to false / completes" | 200 stub; `isFetching === false` after await |
| `select` + "transform / return value / shaped" | `select` returns a marker; delivered body carries it |
| `select` + "not called / fails / error" | 500 stub, and a `select` that throws if invoked; `status === "error"` |
| "cache" + "once / subsequent / serves from cache" | two identical GETs; fetch stub called once |
| "never served from cache / not cached / each call hits the network" | two identical writes; fetch stub called twice |

The verb in the emitted call is read off the module's own exports, so a client exporting only `PUT`
is tested through `PUT`. Each derived test also mints its own URL, because cache keys in this niche
derive from method + URL -- distinct URLs make the tests order-independent against a module-level
cache singleton without needing a reset function, whose name *would* be project-specific.

Triggers are short composable phrase-fragments, not full-sentence matches, so a differently-worded
claim in the same vocabulary resolves.

**What this family deliberately does not cover.** Claims about *subscription* semantics stay pending.
Deriving them needs a subscribe API whose callback shape (`onResponse`, `onSuccess`, …) genuinely
varies between libraries in this niche, and guessing it is how a pattern ends up keyed to one codebase.

Some of those claims can be anchored by hand instead. Anything the result object carries is fair
game -- `apiId` and `cacheId` are resolved onto every result, including a disabled one, so the
key-versus-storage distinction is checkable with an ordinary perspective:

```markdown
- `apiId` is the subscription key; `cacheId` is the storage key
  - GET("https://x.test/k", { enabled: false, apiId: "a", cacheId: "c" }) captures r -> r.apiId === "a"
```

Three kinds of claim, though, have **no form in this grammar at all**, and saying "write a
perspective" about them would be wrong:

| Claim needs | Why no perspective reaches it |
|---|---|
| a callback to be invoked ("a subscriber is notified when…") | a claim cannot contain a function, and `**setup:**` supplies a subject rather than a handler |
| module-level state, not a returned value ("invalidating by apiId clears every entry") | assertions are on captures; an exported `cache` map is not one |
| a function-valued option (`select: v => …`) | same as the first, and STYLE.md argues against logic in a claim regardless |

Leave those as prose. A claim that no rule reaches is *supposed* to read as pending: that is the
state telling you the document is ahead of what the runner can check, which is different from, and
more useful than, a claim quietly anchored to nothing.

### Reactive-derivation factories

When a module exports a function literally named `derive` (`export function derive(selector, combiner, options)`), lldtdd recognizes claims about the reactive-derivation contract: a derived value recomputes only when a value its selector actually reads changes, throws at construction if the selector reads nothing reactive, receives combiner arguments in selector order, notifies subscribers with the new value, skips notification when `memoize: true` and the result is unchanged, updates from inputs across multiple source instances, propagates through chained derivations, coalesces multiple same-batch input changes into one notification, and stops notifying after `destroy()`.

Triggers are short phrase-fragments (`recomputation`, `combiner`/`order`, `memoiz*`, `chain*`/`upstream`, ...) rather than full-sentence matches, same style as HTTP clients above -- exercised against one consuming project so far, so a substantially different phrasing for the same concept is worth checking with `--verbose`.

### `styled()` / `configured()` factories

When a module exports `export const styled = ...`, lldtdd recognizes claims about the higher-order component factory contract: two `styled()` calls on the same base class produce distinct scope classes, two instances of one styled component share a scope class, a styled instance is still `instanceof` its base class, template-literal and function-call syntax are equivalent (both attach a scope class), a function interpolated into the template literal receives the theme object, and `configured()` produces a component that behaves like its base class with the given defaults applied. These require a `**companion:**` annotation naming the base class module, imported as `_Companion` -- the factory has no fixed base class of its own to construct against, so `**companion:**` here is load-bearing, not optional convenience.

**Phrase-fragment triggers.** Same style and caveat as the derive factory above: short vocabulary fragments (`different`/`same scope class`, `both syntaxes`, `function syntax`, `template literal syntax`, `theme object`, `configured`, ...) rather than full-sentence matches, so rewording within that vocabulary still derives -- exercised against one consuming project so far, so a substantially different phrasing for the same contract is worth checking with `--verbose`.

---

## When no pattern reaches your claim

Write the perspective. That is the supported answer, not a workaround.

```markdown
- does calling render() twice leave exactly one copy of the built structure?
  - render() then render() captures r -> r.elem.children.length === 1
```

A perspective lives in the document next to its claim and is keyed by position rather than by a
regex over English: rewording the claim cannot silently unanchor it, and the reviewer auditing the
design reads the check in place. What an unreachable claim usually describes is **intent**, and
intent is not in the source -- "render() is idempotent" cannot be read off an implementation, so no
derivation engine closes that gap. Writing down what the claim means is the feature.

lldtdd's own documents resolve every claim they carry on exactly this basis, with no
project-specific pattern catalog of any kind; `lldtdd run --no-mutate` in this repo prints the
current split between direct and perspective-verified claims.

---

## Runtime utilities

None of these are called from an `.lld.md` file directly -- the runner reaches for them automatically once a claim's vocabulary matches the pattern they back (write-queue ordering, fault-injection recovery, shape-normalization comparisons, seed-and-read/isolation checks for CRUD entities). If you're writing claims rather than extending the derivation engine itself, you don't need to know their signatures; they live in `src/runtime.ts` for anyone who does.

---

## What stays in unit tests

An assertion belongs in the unit test suite, not the LLD, when:
- it describes an obvious behavior that any competent implementation would produce
- it enumerates a specific input/output pair without expressing a design decision
- removing it would not change what the implementation is required to be

```
parseBool("true") -> true      <- unit test (trivially obvious)
unrecognized input returns itself, not null   <- LLD (design decision)

parseInteger("042") -> "042"   <- unit test (specific pair)
"042" is rejected, not parsed as 42 // leading zeros prevent octal ambiguity   <- LLD (decision + rationale)
```

---

## Writing good LLD claims

**Each section should have exactly one primary claim with exactly one set of perspectives.** Supporting context (why a decision was made) belongs inline in the claim bullet, not as a separate bullet without a perspective. Separate bullets without perspectives generate unnecessary pending tests.

**Good structure:**
```markdown
## Auto-open delays until the element is in the DOM

- `openOnRender` defaults to a small delay so the dialog is guaranteed to be attached before `showModal()` is called; opening before attachment fails silently
  - does setting openOnRender: false prevent the dialog from opening on its own?
```

**Avoid this pattern** (context bullet with no perspective generates phantom pending):
```markdown
## Auto-open delays until the element is in the DOM

- `openOnRender` defaults to a small delay, enough time for the element to be in the document
- opening an element that isn't yet in the DOM would fail silently; the delay is a correctness decision
  - does setting openOnRender: false prevent the dialog from opening on its own?
```

The second version generates two claims: one pending correctly (has perspective) and one pending unnecessarily (context-only bullet). Merge them.
