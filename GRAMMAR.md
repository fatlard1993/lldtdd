# lldtdd Grammar

## What an LLD is

An LLD (Low Level Design) document is a versioned design contract. It commits intent: "this is what this slice of the product should do." The test runner converts that intent into pass/fail, but the document's primary audience is the team and its primary artifact is its commit history.

**The git log of an LLD file is the history of the product's design thinking for that slice.**

When you change an LLD, you're committing a design decision — not fixing a test. The commit message should explain why the vision changed.

### The lifecycle

```
commit LLD     ->  intent documented, implementation pending
implement      ->  assertions go from pending to passing ("we arrived")
assertion fails ->  implementation drifted from intent (regression)
LLD changes    ->  vision evolved (log the why)
```

### What belongs in an LLD

Three questions. If the answer to any is no, it's a unit test, not an LLD assertion.

1. Does this assertion express a **decision** that shaped the design?
2. Would a developer implementing naively **get this wrong**?
3. Would a future developer reading only this file understand **what was chosen and what was rejected**?

Assertions that describe the happy path, enumerate obvious I/O, or document what a function does rather than why it does it belong in the unit test suite. The LLD captures what was decided, not what was implemented.

---

## Document structure

```markdown
# Module Name
> path/to/module.js          <- module pointer (non-relative = project-root; ./x = LLD-relative)

Prose description of the module's purpose and the key design intent.

## Group Name               <- behavioral category
**method:** `methodName`    <- default callable for this group (optional — often inferred)
**setup:** `expr(args)`     <- runs in beforeEach, result bound as _subject (optional)
**beforeAll:** `expr()`     <- runs once before the group, for expensive setup (optional)
**beforeEach:** `expr()`    <- runs before each test, void call (optional)
**context:** prose          <- human-readable context hint for the AI (optional)
**module:** `path/to/alt.js` <- overrides the document-level module for this group only (optional)

- assertion
- assertion
  - perspective question?   <- indented sub-question; derives a focused verification test
```

Most `**method:**` annotations are inferred automatically from the group name and claim vocabulary — you only need to write one when the group name doesn't clearly map to the intended method.

---

## Assertion forms

### Form 1 — Condition -> Outcome
```
[N x] condition -> outcome [// prose explanation]
```
Used when there is a clear cause-and-effect split.

```markdown
- wrong credentials -> `AuthError`
- 3 x request on same key -> denied
- getTotal("empty-sess") -> total is zero
- read with unknown id -> false, not null
```

The `[N x]` prefix runs the condition N times before the final assertion (sets up state).

### Form 2 — Invariant (no arrow)
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

Full-text pattern matching fires on invariants when a `**method:**` annotation is present on the group. Recognized phrases:

| Phrase pattern | Maps to |
|---|---|
| `X is safe`, `does nothing`, `does not throw`, `no error`, `is a valid state`, `not an error condition` | resolves |
| `does not affect/fire/receive/create/store/...` | resolves |
| `can [be] verb` | resolves (capability claim) |
| `requires no X`, `there is no X required` | resolves (independence claim) |
| `returns a function` | property: typeof-function |
| `returns an object` | property: typeof-object |
| `returns a list / array` | resolves |
| `returns N`, `fires once`, `fires zero times` | equals N |
| `output contains a sentinel/marker`, `includes a substring` | contains |
| `field is absent/not present/not populated` | absent |

### Form 3 — Inline call with captures
```
method(args) captures varName -> inspect assertion
method1(args) captures varA and method2(args) captures varB -> inspect assertion
method1(args) captures varA then method2(args_referencing_varA) captures varB -> inspect assertion
```

The `then` keyword signals that the second call's args may reference the first capture by name. The first result is in scope when the second call is emitted:

```markdown
- create({ name: "Original", url: "x" }) captures r then update({ id: r.id, update: { name: "Renamed" } }) captures result → result.name === "Renamed"
- create({}) captures r then read({ id: r.id }) captures found → found.name === ""
```

Generated code holds `r` in scope before calling `update`, so `r.id` resolves correctly.

```markdown
- login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- login("a@b.com", "p1") captures tokenA and login("b@b.com", "p2") captures tokenB -> tokenA.token !== tokenB.token
```

### Form 4 — Conditional invariant
```
when [field] is set, [output] is [property]
```

Describes field-controlled output transformation. The runner detects the field name and behavior, derives appropriate test data, and verifies the transformation automatically.

```markdown
- when orderBy is set, results are sorted server-side before being returned
- when limit is set, results are truncated to that count
```

These require a schema with the named field and a detected primary action (e.g. a search function). The runner creates the entity with the field set, mocks the external dependency with controlled data, and asserts the transformation.

---

## Perspectives

A perspective is an indented question under an assertion. It derives a focused verification test for a specific aspect of the parent claim.

```markdown
- a bookmark belongs to at most one category
  - does the category field hold a string value?
- categories are a flat collection
  - does readCategories return an array?
- write ordering is structural, not a mutex
  - do concurrent writes complete in the order they were submitted?
```

The parent assertion documents the design decision. The perspective question proves a concrete, measurable aspect of it. Perspectives run as sibling tests immediately after their parent.

Use perspectives when:
- the parent claim is abstract but one specific property is measurable
- you want to add targeted verification without changing the design statement
- mutation testing identifies a gap — adding a perspective is how you close it

---

## Prose separator

Use ` // ` (space-double-slash-space) to append an explanation to any assertion.

```
- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- unrecognized input returns itself, not null // callers can distinguish unrecognized from absent
```

The text after ` // ` is stripped before matching — it is for the reader, not the runner.

**Why ` // `**: space-double-slash-space never conflicts with URL paths (`https://` has no leading space), flag names (`--no-flag`), or any other content likely to appear in an LLD.

---

## Deterministic outcome patterns

When the outcome (right side of `->`) matches one of these patterns, no AI translation is needed.

### Error throws
```
-> `ErrorClass`
-> `ErrorClass("message")`
-> throws
-> account locked
-> rate limited
```

### Value equality
```
-> false
-> true
-> null
-> undefined
-> zero  /  0
-> allowed         (property: result.allowed === true)
-> denied          (property: result.allowed === false)
```

### Resolves (no throw)
```
-> resolves
-> no error
-> returns
-> allowed again
-> unchanged
-> without error
-> without failing
```

### Shape
```
-> `{ field: Type }`       (structural match)
-> resolves with `{ ... }`
```

### Spy / callback assertions (requires **setup:** with _subject)
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

The design assertion documents the decision. The inline call proves it holds against the actual implementation. They are not redundant — the first says WHY, the second verifies it.

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

- `#/path?foo=bar` matches the `/path` route — query strings are stripped before matching
  - hashStripsQueryString() → "/path"
```

This pattern is particularly useful for:
- Pure logic (routing, date arithmetic, value transformations)
- Multi-step state sequences (add duplicate → count unchanged)
- Scenarios involving internal state that isn't directly observable from the outside

---

## Automatic derivation from module structure

lldtdd derives tests directly from source code structure without requiring any annotation for several common module types.

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

### Component UI classes

When a module exports `export default class X extends Y` (non-EventTarget), lldtdd derives tests from these vocabulary patterns:

**Reactive state properties**
| Claim vocabulary | Derived test |
|---|---|
| "isDirty false / matches initial value" | `new X({ value: 'init' }); expect(inst.isDirty).toBe(false)` |
| "isDirty true / after value changed" | set `inst.options.value = 'new'`; check `isDirty === true` |
| "hasErrors returns false / all valid" | `new Form({ inputs: [] }).hasErrors()` → false |
| "hasErrors returns true / validation fails" | `new Form({ inputs: [{ key: 'x', validations: [[fn, 'msg']] }] }).hasErrors()` → true |
| "disabled / element is disabled" | `new X({ disabled: true })` → `elem.disabled === true` |

**Construction assertions**
| Claim vocabulary | Derived test |
|---|---|
| "invalid X throws / unrecognized X throws" | `expect(() => new X({ X: '__lld_invalid__' })).toThrow()` |
| "renders without error / without failing" | `expect(() => new X({})).not.toThrow()` |
| "readOnly contains no input element" | `new X({ readOnly: true }); querySelector('input') === null` |
| "boolean value → checkbox" | `new X({ value: true }); elem.type === 'checkbox'` |
| "number value → numeric entry" | `new X({ value: 1 }); elem.type === 'number'` |
| "code with newlines → block (pre)" | `new X({ code: 'a\nb' }); elem.tagName === 'PRE'` |
| "language option adds identifiable class" | `new X({ language: 'js' }); class contains 'language-'` |
| "full-height flex / height: 100%" | `new X({}); elem.style.height === '100%'` |
| "remain an anchor element" | `new X({ variant: 'button' }); elem.tagName === 'A'` |
| "icon without text → icon-only class" | `new X({ icon: 'star' }); classList.contains('icon')` |
| "icon with text → no icon-only class" | `new X({ icon: 'star', textContent: 'text' }); !classList.contains('icon')` |
| "both icon and animation → both classes" | `new X({ icon: 'star', animation: 'spin' }); has both FA classes` |
| "icon updated → no stale classes" | `inst.options.icon = 'moon'`; no `fa-star`, yes `fa-moon` |

**Event dispatch**
| Claim vocabulary | Derived test |
|---|---|
| "pressing Enter invokes Y" | `elem.dispatchEvent(KeyboardEvent('keyup', { key: 'Enter', code: 'Enter' }))`; spy on Y |
| "clicking invokes Y" | `elem.dispatchEvent(PointerEvent('pointerdown' + 'pointerup'))`; spy on Y |
| "clicking removes it from the page" | `elem.dispatchEvent(pointerdown + pointerup)`; `document.body.contains(elem) === false` |

**Timer mechanism (setTimeout spy)**
| Claim vocabulary | Derived test |
|---|---|
| "hovering for longer than Nms shows the tooltip" | mock setTimeout, dispatch pointerover, verify timer registered with delay ≥ 600ms |
| "leaving prevents tooltip from appearing" | mock clearTimeout, dispatch pointerover then pointerout, verify timer cleared |
| "cancelling before 200ms prevents opening" | append to DOM (fires onConnected), destroy, verify clearTimeout called |
| "manually dismissing cancels pending timeout" | dismiss notification, verify clearTimeout called |

**Reactive option updates**
| Claim vocabulary | Derived test |
|---|---|
| "switching layout removes keys / new layout keys appear" | `inst.options.layout = 'number'`; compare DOM before/after |
| "switching from month to day view reflects events" | `inst.options.view = 'day'`; `inst.render()`; DOM changed |

---

## Runtime utilities

The tool ships helpers that eliminate boilerplate from every test scenario.

### `createDbLifecycle(database, collections, opts?)`

Returns `initDb` and `reset` for any lowdb-style database. Eliminates the repeated temp-dir + init + zero + write pattern.

```js
import { createDbLifecycle } from "lldtdd/runtime";

const { initDb, reset } = createDbLifecycle(database, ["bookmarks", "categories"]);
```

`initDb` creates a fresh temp-dir database each run. `reset` clears all records in the listed collections between tests. For `isSelfDatabase` modules (the raw database object), the lifecycle is auto-wired with no annotation needed.

### `withMockFetch(responseBody, fn)`

Stubs `global.fetch` for the duration of `fn`, then restores it — even if `fn` throws.

```js
import { withMockFetch } from "lldtdd/runtime";

const results = await withMockFetch({ results: [...] }, () => searchProvider(engineId, term));
```

### `withOrderTracking(...triggers)`

Runs multiple async operations concurrently and returns the order they completed. Used to verify write-queue ordering guarantees.

```js
const order = await withOrderTracking(() => db.write(), () => db.write());
// order[0] === 1 && order[1] === 2 means A completed before B
```

### `withFaultInjection(target, method, trigger)`

Patches `target[method]` to fail once, then calls `trigger`, then verifies recovery. Returns `true` if the system recovered.

```js
const recovered = await withFaultInjection(database.db, "write", () => database.write());
expect(recovered).toBe(true);
```

### `withSchemaEvolution(dbData, writeFn, collection, record, newField)`

Writes a raw record (bypassing CRUD field filtering), then reads it back. The new field should have an empty-string default. Verifies: "schema changes do not require data migration."

### `withShapeComparison(fn1, fn2)`

Calls both functions and returns `true` if their results have the same shape (same keys at every level). Used to verify normalization across different configurations.

### `createEntityRegistry(modules)`

Builds a standard CRUD interface (`create`, `read`, `readAll`, `update`) from a map of entity name → module. Powers `withSeedAndRead` and `withIsolationTest`.

### `withSeedAndRead(createFn, readAllFn, fixtures)`

Seeds records using `createFn`, calls `readAllFn`, and returns the result. Used to verify "returns an array" / "flat collection" claims.

### `withIsolationTest(registry, contextEntity, primaryEntity, contextField, sharedFixture, entityFixture, mutation)`

Creates two entities sharing a context, mutates one, and verifies the other is unchanged. Used to prove isolation invariants.

---

## Pending state

**Pending is not a problem.** It means: intent documented, implementation not yet verified.

An LLD written before implementation will be entirely pending. That is correct. Pending assertions are progress markers — each one that turns green is a verified step toward the stated intent.

```
○ pending    ->  intent documented
✓ passing    ->  intent verified
✗ failing    ->  implementation drifted from intent
```

When all assertions pass, the implementation satisfies the stated intent for that slice.

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

- `openOnRender` defaults to a small delay so the dialog is guaranteed to be attached before `showModal()` is called — opening before attachment fails silently
  - does setting openOnRender: false prevent the dialog from opening on its own?
```

**Avoid this pattern** (context bullet with no perspective generates phantom pending):
```markdown
## Auto-open delays until the element is in the DOM

- `openOnRender` defaults to a small delay — enough time for the element to be in the document
- opening an element that isn't yet in the DOM would fail silently; the delay is a correctness decision
  - does setting openOnRender: false prevent the dialog from opening on its own?
```

The second version generates two claims: one pending correctly (has perspective) and one pending unnecessarily (context-only bullet). Merge them.
