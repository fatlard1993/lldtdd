# lldtdd

Intent documentation that runs.

---

## What it is

An LLD (Low Level Design) document is a versioned design contract. You write it before you write code. It commits your intent about a logical slice of the solution: what it should do, what decisions were made, what would surprise a naive implementer.

The test runner converts that intent into pass/fail. But the document's primary artifact is its **commit history**. The git log of an LLD file is the history of the product's design thinking for that slice.

**A change to an LLD is a design decision, not a bug fix.** The commit message should explain why the vision changed.

---

## The lifecycle

```
commit LLD      intent documented, all assertions pending
implement       assertions go from pending to passing
assertion fails implementation drifted from intent (regression)
LLD changes     vision evolved -- log the why
```

When all assertions in an LLD pass, the implementation satisfies the documented intent for that slice. That is the moment you can say: *we built what we said we'd build.*

---

## What belongs in an LLD

Three questions. All three must be yes.

1. Does this assertion express a **decision** that shaped the design?
2. Would a developer implementing naively **get this wrong**?
3. Would a future developer reading only this file understand **what was chosen and what was rejected**?

If any answer is no, it belongs in a unit test, not an LLD.

---

## Quick example

```markdown
# Auth Service
> examples/auth.ts

Passwords are never returned or stored in tokens. Tokens are time-bounded. Failed attempts are tracked per user, not per session.

## Login
**method:** `login`

- wrong password -> `AuthError` // the error does not distinguish wrong password from unknown email
- unknown email -> `AuthError` // same error as wrong password, by design
- locked account -> `AuthError` regardless of whether the password would have been correct
- repeated failed attempts lock the account, so brute-force guessing can't run indefinitely
  - 5 x login("user@example.com", "wrongpass") -> `AuthError("account locked")`

## Security invariants
**method:** `login`
**beforeEach:** `_reset()`

- the token never contains the raw password used to obtain it
  - login("user@example.com", "password123") captures result -> result.token does not contain "password123"
- tokens expire; they are not valid indefinitely
  - login("user@example.com", "password123") captures result -> result.expiresAt is within 24 hours from now

## Token validation
**method:** `validateToken`
**beforeEach:** `_reset()`

A token carries its own proof. Validation re-signs the payload and compares, so it needs no session
store and no round trip -- which is the reason the signature is part of the token rather than a
record on the server.

- a token issued by login validates, and identifies the user it was issued to // the signature makes the token self-verifying; nothing is looked up
  - login("user@example.com", "password123") captures issued then validateToken(issued.token) captures claims -> claims.userId === "u1"
- a missing token is rejected as an invalid token, not as a crash // callers handle one error type; they never see a TypeError from indexing nothing
  - validateToken(null) -> `InvalidTokenError`
```

This is the real, shipped `examples/auth.lld.md` -- run `lldtdd run examples/auth.lld.md` yourself to see it pass. Indented bullets (`  - does X?`) are **perspectives**: the concrete, checkable form of the claim above them. A perspective is either a question, which derives a test if a pattern recognises it, or a call written out in full, which needs no pattern at all. They attach to the bullet directly above, so keep reasons in the prose and bullets for claims. Notice every claim above carries one: a bare claim with no perspective and no inline call stays pending unless an AST pattern happens to recognize it, because there's nothing concrete in the claim itself to check (more on this in STYLE.md).

---

## Install

**lldtdd requires [Bun](https://bun.sh).** This isn't a preference: the tool runs TypeScript
sources directly with no build step, generates `bun:test` files, and executes them via
`Bun.spawn`. There is no Node-compatible build, and there isn't going to be one.

**The package is not yet published to the npm registry**, so `bun add lldtdd` will not find it today.
Until it is, run from a clone:

```bash
git clone https://github.com/fatlard1993/lldtdd.git
cd lldtdd && bun install
bun run src/cli.ts run    # or run `bun link` here once, then `lldtdd run` from any project
```

Once it is published, the intended install path will be:

```bash
bun add -d lldtdd
bunx lldtdd run
```

Linux and macOS only, as declared in `package.json`; there is no Windows support today.

One thing is optional: add `@happy-dom/global-registrator` if any of your documents describe DOM
component classes, which need a real `document`. Suites that don't are unaffected either way.

Nothing else is required: no API key, no network, no service. lldtdd reads your implementation's
source; it never asks you to annotate production code with test metadata.

Add these two to your `.gitignore`. Both are cleaned up on exit, including on Ctrl-C, but a
`SIGKILL` or a power cut can strand one:

```
.lldtdd-mut-*
.lldtdd-tmp/
```

### An .lld.md file is executable input

Running a document runs code: claims name calls in your module, scenario steps are emitted into the
generated suite as written, and `run` and `mutate` import the module under test. That is the point
of the format, and it is the same trust you extend to a `Makefile` or a test file -- **review a
`.lld.md` the way you would review source, especially one arriving in a pull request.**

`lint`, `suggest`, and `drift` do not execute your module. They read it. Pass `--execute` to
`lint` or `suggest` to opt into loading it for sharper inference, which is the only way those three
commands will run anything.

## Commands

```bash
lldtdd run [-v|--verbose] [--no-mutate] [--fail-on-pending] [--fail-on-weak] [pattern]
                                         Run assertions + drift + mutation (default: **/*.lld.md)
lldtdd lint [--execute] [pattern]        Check LLD files for structure and style issues
lldtdd suggest [--apply] [--execute] <file>
                                         Show (or apply) auto-inferred method decorations
lldtdd drift <file.lld.md>               Detect structural changes that may invalidate claims
lldtdd mutate <file.lld.md>              Find claims that don't catch real implementation bugs
lldtdd help                              Show this message
```

An unrecognized command exits 1; `help` exits 0. An unrecognized flag is rejected the same way,
not silently ignored: every flag is boolean, so a typo like `--no-mutat` would otherwise run the
very pass the user meant to skip.

Bare `lldtdd` with no command is `lldtdd run` -- it runs, and mutates, every `.lld.md` in the tree
(the default `**/*.lld.md` pattern, with the exclusions below). It is the executing verb; there is
no read-only default.

`run` includes drift checking and mutation testing inline -- after assertions pass, it checks whether the implementation has drifted from HEAD and whether any mutations of the implementation would go undetected by the claims.

The default pattern skips `node_modules/` and any `fixtures/` directory. Fixture documents exist to
be run *by* something else -- a test, or a claim in another document -- and some of them are broken
on purpose, so sweeping them into the suite would make a document written to fail fail the build.
Naming a fixture path explicitly still runs it. A bare directory named where a pattern was expected
means everything under it: `lldtdd run docs` expands to `docs/**/*.lld.md`, for `run` and `lint`
alike, with the sweep's usual exclusions still applied.

**Exit codes.** `run` exits non-zero for exactly three reasons: a claim it could verify came out
false; `--fail-on-pending` was passed and a claim is pending; `--fail-on-weak` was passed and a
claim's only green is a no-throw check. The first is the whole default contract, and the only one a
plain `run` applies. The two flags are opt-in ratchets: pending is the correct state for a document
written before its code, and a no-throw-only green may be all a liveness claim means, so neither
fails a run unless the caller asks for a corpus that has reached zero pending, or all-strong
greens, to stay there. Left off, they change nothing. Drift findings and surviving mutations are
printed but advisory in every case: they mean *a human should look at this*, which is not something
the tool can decide for you. A document is allowed to be deliberately silent about a behavior, and
failing the build on that would push you toward writing claims whose only job is to kill a mutant.
That is coverage-shaped writing, and it is the thing an LLD is meant to be an alternative to.

**`mutate` is the exception, and it is deliberate.** Run on its own, `mutate` exits non-zero when a
mutation survives. The two commands have different jobs: `run` is the build gate, so it answers
only the question a build can act on mechanically -- is anything the tool checked actually false.
`mutate` is an audit you invoke when you have decided to go looking, and a non-zero exit is what
makes it usable in a targeted "claims must have teeth here" check without dragging every other
document into that standard. If you want the strict behavior across a whole suite, call `mutate`
per document; if you want the advisory behavior, use `run`.

**Mutants that could not run are counted separately.** A mutant that fails to load has not been
caught by anything, and reporting it as caught would claim strength the run has no evidence for.
These are surfaced on their own line and never folded into the killed count.

Use `--verbose` (or `-v`) to see the derived test for each assertion: source, method call, and assertion type. Use `--no-mutate` to skip the mutation pass.

### Environment

Four environment variables tune behavior; none is required.

```
NO_COLOR                     Disable ANSI color in all output (the de-facto standard var).
LLDTDD_DEBUG=1               On an error, print the stack trace instead of the one-line message.
LLDTDD_DEBUG_GEN=<path>      Write the last generated bun:test file to <path>, for inspecting what
                             a claim derived to. Diagnostic; overwritten each suite.
LLDTDD_MUTATION_CONCURRENCY  Number of mutants to test in parallel during `mutate` (default: half
                             the CPU count, capped at 4). Set to 1 for a sequential pass.
```

---

## The five states

Every claim lands in exactly one of five states, and the boundaries between them are the whole
point of the tool:

```
○  pending     the claim exists, but no test of it could be derived
◐  shallow     a test ran and the call didn't throw -- but nothing it returned or did was checked
✓  passing     a test of this claim ran, checked what the call returned or did, and it agreed
⊙  indirect    the claim itself had no test; its perspectives carry the evidence, and they passed
✗  failing     a test of this claim ran, and the implementation disagreed
```

The load-bearing words are **of this claim**. A test that runs the right function but checks
something other than what the claim says is not a pass -- it is a pending claim wearing a green
badge, and it is worse than no coverage, because nothing downstream distinguishes it.

`◐` and `⊙` both exist to keep a weak green from wearing a strong badge. **`◐ shallow`** is a claim
whose only assertion is no-throw (`-> resolves`): the call ran, so it is genuinely green, but it
would stay green against an implementation gutted to an empty body, because nothing about the result
was checked. That is a real fact -- the code runs -- but it is not the claim's design intent verified,
so it is counted apart from `passing`. `run --fail-on-weak` fails the build on it and `lint` names
it at authoring; both are opt-in, because a document may legitimately mean only "this runs."

**`⊙ indirect`** is the directness analog. A bare prose claim with a concrete perspective underneath
it has no test of its own; the perspective does. That is a real verification -- you wrote the
perspective, so you decided it operationalizes the claim -- and it does not fail the build. But it is
weaker evidence than a test of the claim itself, and folding the two into one green tick would let a
document report "all passed, 0 pending" while some of those claims had nothing of their own behind
them. All are successes; the run says which kind, so a reader deciding whether to trust a green
document can see which greens actually bite.

Pending has four usual causes, in rough order of frequency:

1. **Not implemented yet.** An LLD written before its code is *entirely* pending. That is the
   correct starting state, not a problem to fix.
2. **The claim isn't specific enough.** "Discounts apply at checkout, not at add-time" names a
   design decision but nothing measurable. Give it a perspective and it becomes checkable.
3. **Nothing in the grammar or the AST patterns reaches it.** The vocabulary in
   [GRAMMAR.md](./GRAMMAR.md) is the full list of what can be derived from.
4. **The claim needs a browser and there is none.** A group marked `**browser:** true` runs in
   headless Chrome; on a machine with no Chrome or Chromium on `PATH`, its claims stay pending
   because the question was never put to anything, and the run output names that as the reason.

**A bare prose claim will not turn green.** Prose like "a transfer does not affect the source
balance" used to be matched to a check that the call didn't throw -- which passes for any function
that doesn't crash, and would have stayed green if `transfer()` were gutted to an empty body. It
is pending now. To make a claim checkable, give it one of:

- an outcome: `- wrong password -> \`AuthError\``
- an inline call: `- addItem("sess1", "sku-out") -> \`CartError\``
- a perspective: an indented sub-claim carrying the concrete check

`lldtdd lint` names the claims in a document that can only ever be pending, so you don't have to
find them by reading run output.

---

## Test derivation

Test derivation is entirely offline. The system reads the implementation module's AST and derives:

- **CRUD schema** → create/update/schema-drop/default-field tests
- **FK relationships** → isolation tests, category list tests
- **Self-database modules** (the module *is* the persistence layer: `init`/`write`/`db`, no db import) → write-queue ordering and fault-recovery tests
- **Caching-fetch clients** (exported HTTP-verb functions returning a result with both `isFetching` and an `idle`/`loading`/`success`/`error` status) → `enabled`, `select`, and cache-behavior tests
- **EventTarget reactive classes** → subscribe/destroy/fire-order tests (`examples/eventBus.lld.md`)
- **DOM component classes** → construction, event-dispatch, and reactive-option tests (`examples/toggle.lld.md`)
- **Text transformers, pipeline chains, and structural comparators** (functions that parse a structured text format, functions whose input type is another function's output type, and `(T, T)` comparison functions) → parse, chain-setup, and before/after comparison tests
- **CLI parsers, reactive-derivation and `styled()` factories**: see GRAMMAR.md's "Automatic derivation from module structure" for the full vocabulary each family recognizes

A claim that matches neither the grammar nor an AST pattern stays **pending**. It is not guessed at.

### How much of this is general, and what to do with the rest

Every pattern that ships is **structural** in two respects: it fires only for a module that actually
implements the shape it targets (gated on the real source, not on the claim's wording), and it
generalizes across wording rather than matching one exact sentence. Most read capture groups out of
the claim and build a test around whatever they captured, so they fire for a component, an option
name, or a flag never seen before. A few target a specific module shape -- a `styled()`/`configured()`
component factory, a `derive()` reactive factory -- whose invariants have no value to lift from the
claim; those key on the *vocabulary* of the claim, not its phrasing, so rewording within that
vocabulary still derives the same test. The membership rule is mechanical: a pattern that fires on a
module without its shape, or that only matches one hand-written sentence, doesn't belong.

Structural patterns cover a real but narrow slice: the module shapes listed above. **Everything
else is covered by writing the claim concretely**, not by extending the engine. A perspective or an
inline call is how a claim about your own domain becomes checkable:

```markdown
- does calling render() twice leave exactly one copy of the built structure?
  - render() then render() captures r -> r.elem.children.length === 1
```

That is the whole answer, and this project is its own evidence, stated as a measurement rather
than a guarantee: at the time of writing, `bun run src/cli.ts run 'lld/**/*.lld.md' --no-mutate`
reports 99 passed, 0 failed, 29 via perspectives, and nothing pending, and the examples corpus
reports 24 passed, 16 via perspectives, 3 no-throw only, again nothing pending, with no
project-specific pattern catalog of any kind, because those perspectives carry concrete calls.
Nothing enforces those numbers: CI runs plain `run` as an audit, pending claims do not fail its
build, and `--fail-on-pending` / `--fail-on-weak` remain available as opt-in ratchets for a corpus
that wants to hold a state it has reached. The measurement also depends on capabilities, since
browser-gated claims pend on a machine without Chrome. So treat the numbers above as a snapshot
that can drift, and run `lldtdd run --no-mutate` in this repo for the current split between claims
with a direct test and claims verified through perspectives.

There used to be a second mechanism here. A project could supply *example-anchored* patterns --
regexes matched against the near-exact wording of its own claims, each building a hand-written test
body against its own internals -- and they covered the majority of claims in the component library
this tool grew up alongside. They were removed, and the reasoning is worth stating because it is
the same reasoning that removed the AI translator below:

An example-anchored pattern is a lookup table from one sentence to one hand-written test body. It
isn't derivation, and it can't be: what those claims describe is **intent**, and intent is not in
the source. "render() is idempotent" cannot be read off an implementation; if `render()` had a
double-append bug, structural derivation would faithfully derive "render() appends" and pass. So
the real choice was never *catalog vs. better AST work*. It was **catalog vs. perspective** -- and a
perspective wins on every axis. It lives in the document where a reader auditing the design can see
it. It is keyed by position rather than by a fuzzy regex over English, so rewording a claim cannot
silently drop it back to pending. And it needs no second file, no priority field, and no collision
auditor to stay safe.

If you have a claim that no shipped pattern reaches, write the perspective. That is not a
workaround for a missing feature; it is the feature.

An earlier version sent unmatched claims to a language model, which
wrote a test body for them. Two things were wrong with it. The generated tests were the weakest in
every suite -- most collapsed to "the call resolves", which passes for any function that doesn't
throw and therefore verifies nothing -- and, more importantly, the derived suite became a function
of network reachability, an API key, and a model version. The same commit could report differently
on two machines. **A test runner whose results depend on which machine ran it is not reporting.**

So the rule is now simple enough to hold in your head: a claim is verified by a rule you can read
in [GRAMMAR.md](./GRAMMAR.md), or it is pending. Same document plus same source derives the same
suite given the same capabilities. The one machine-shaped input left is whether a browser is
present: browser-gated claims stay pending on a machine without Chrome, and the run output names
that as the reason, so two machines can differ in what they verified but never in what a green
means. If a claim you care about is pending, the fix is to give it a perspective or an inline
call, which is also the thing that makes the claim concrete enough to be worth having.

---

## Grammar

See [GRAMMAR.md](./GRAMMAR.md) for the full assertion syntax, outcome patterns, perspectives, and authoring guidance.

See [STYLE.md](./STYLE.md) for how to write the prose itself: what makes an LLD read like a design decision instead of a description of one.
