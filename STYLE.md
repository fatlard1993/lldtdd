# Writing LLD prose

GRAMMAR.md is the syntax reference: what forms exist, what the parser recognizes. This document is about the sentences themselves: what makes an `.lld.md` file read like a design decision instead of a description of one.

The test is always the same one: **could this have been written before any code existed?** If a sentence only makes sense once you already know the implementation, it isn't a design document, it's commentary on one.

Every finding below is a real edit made to real documents, not a hypothetical.

---

## Write at founding altitude, not test-coverage altitude

Every rule below is about making a claim read well once it's decided the claim belongs. This one comes first because it's about whether it belongs at all -- a well-worded sentence can still be the wrong thing to write down.

The question isn't (only) README.md's three-questions test applied claim by claim -- a claim can individually pass "would a naive implementer get this wrong?" and still be the wrong thing for the file to contain, because it belongs to a later phase of the project than the one the document is capturing. The question to ask about the file as a whole: **would someone sketch this before writing a line of code, or did it get added later, after the core idea already existed, to harden an edge?**

A rate limiter's founding shape is one sentence: requests are limited per key by a sliding window that resets from first use, not a clock boundary. A dedicated group for "limit of zero," a separate one for "limit of one," and a third for the exact arithmetic of quota decrementing are all real and all true -- and all belong to the phase *after* that founding sentence, when the core idea is already built and being stress-tested at its edges. None of them change what the rate limiter fundamentally *is*.

The same tell shows up as boilerplate in CRUD-shaped domains: "all fields can be updated after a bookmark is created" is true of nearly any record type and isn't a decision anyone had to make -- contrast it with "a bookmark belongs to at most one category" and "categories are a flat collection," which *are* decisions (nesting was on the table; single-tag-only was on the table) and read as such.

It also shows up as unbounded growth in a library that started with a real founding shape and kept accumulating documented features past it. Two groups can capture what a reactive container fundamentally is -- plain-object ergonomics on top of the platform's own event system, and rejecting anything that isn't a plain object. Fifteen groups past that point (manual batching, deferred batching, memoized derivation, multi-key subscriptions) -- each true, each legitimate library documentation -- collectively read as a finished feature catalog, not the sketch that came before any of those features existed. Neither shape is wrong -- a mature library's `.lld.md` can reasonably be a catalog -- but know which one you're writing, and don't mistake the catalog for the founding document when someone asks what the thing fundamentally *is*.

The strongest antidote isn't cutting harder, it's writing the *why*: "`select` earns its place when two or more subscribers on the same `apiId` need different shapes from the same response. For a single subscriber, the transform belongs in `onResponse` directly." That's a decision being argued, not a feature being logged. If a claim can't be reframed that way -- if there's no trade-off to explain, just a behavior to enumerate -- it's probably hardening, not founding, and belongs in the unit test suite or a later revision of the document, not the first one.

---

## Name the decision in the opener, not the feature list

The opening paragraph of a component's `.lld.md` should state what was decided and why, not enumerate what the component does.

**Before** (BottomSheet, listed features):
> A bottom sheet that can be dismissed by dragging down, tapping the backdrop, or pressing Escape.

**After** (names the decision):
> Three dismiss triggers (drag, backdrop tap, Escape) all converge on the same close path, so callers only need to handle one `onDismiss` regardless of how the user chose to leave.

The first version is accurate but tells you nothing you couldn't get from the prop list. The second names the actual design choice: convergence onto one path. That's the sentence a future maintainer needs when they're tempted to add a fourth trigger that skips the shared path.

## Name the axes when a concept has more than one dimension

When a claim is actually doing two jobs, say so explicitly: don't let the second job hide inside a vague verb.

**Before** (Whiteboard):
> `clearCanvas()` clears the 2D context and resets stroke state.

**After**:
> `clearCanvas()` has two separate jobs: erase the drawn content, and reset any stroke currently being tracked.

"Resets stroke state" reads like an implementation detail bolted onto the real job (clearing). Naming it as a second, coequal axis is what let the perspective questions actually test both -- and what surfaced that the implementation was only doing the first job, a real bug the vaguer sentence had hidden.

Same pattern, Table:
> The first click on a column sorts it descending; a second click on the same column toggles to ascending -- sorting only moves between columns, there is no click back to unsorted.

Not "clicking toggles sort direction." A toggle with a starting state, a direction, and a missing third state is a state machine; name it as one.

## Don't overclaim shared code when only a shared principle exists

**Before** (Menu):
> Pointer and keyboard activation both resolve to the same `select` event -- the same activation path as Button.

**After**:
> Pointer and keyboard activation both resolve to the same `select` event -- the same principle Button applies to `onPointerPress` -- so keyboard and pointer users get the same experience without separate handlers.

Menu and Button don't share an activation path -- they share a *design principle*, applied independently in each component's own code. "Same path" is a claim about implementation; "same principle" is a claim about intent. Get this wrong and a reader assumes a refactor-safe shared abstraction exists where there's really just a convention two components both happen to follow.

The flip side: Menu has two separate event handlers (pointer, keyboard) that both emit one event, so "one event" is true and "one handler" is not. The plurality of the mechanism and the singularity of the outcome are different facts -- say the one that's actually true.

## Give every claim a perspective, or don't leave it bare

A claim without a perspective and without an inline call stays pending -- there is nothing concrete
in it to check, so unless one of the shipped structural families recognizes the wording, the runner
has nothing to derive a test from. Don't write toward that exception. Whether a family fires depends
on what your module *is* -- a component class, a caching-fetch client, a `createCRUD` schema -- which
is not something you should have to hold in your head while deciding how to phrase a design
decision. Write the perspective and the claim is checkable regardless.

A bare invariant that merely ran without throwing would look verified while testing nothing about
what it claims. Pending is the truthful state for it, and `lldtdd lint` names them.

**Before** (Popover, two bare claims):
> When the popover would overflow an edge, the position flips; this calculation runs on each `show()` call so it stays accurate as the page scrolls or resizes.

(no perspective; nothing measurable attached)

**After**:
> (same claim)
>   - does the popover flip to the opposite edge when it would overflow?

If the claim states something concrete, it can carry a perspective. If it can't carry one, that's usually a sign the claim is actually context for a neighboring claim, not a claim of its own; merge it in rather than leaving it to generate noise. (See GRAMMAR.md's "Writing good LLD claims" section for the merge pattern.)

## Keep rationale in the prose, not in the bullet list

A bullet that explains *why* looks harmless and is not, because a perspective attaches to the bullet
immediately above it. Put a reason between a claim and its check and the check silently files itself
under the reason:

**Before**

```markdown
- only one position class is active at a time; switching position replaces
- callers can safely reassign position without manual cleanup
  - does changing position leave only the new class active?
```

The question proves the first bullet and is recorded against the second. The claim it actually
verifies still reads as pending, and the rationale -- which asserts nothing -- reads as verified. Both
are wrong and neither shows up as a failure.

**After**

```markdown
Callers can reassign `position` freely without cleaning up after the previous value.

- only one position class is active at a time; switching position replaces
  - does changing position leave only the new class active?
```

This shape is invisible in a run: the tests pass and the counts look reasonable; only reading the
structure turns it up. The rule that
prevents it is simple: **bullets are claims, prose is reasons.** If a sentence cannot be wrong, it is
not a claim, and it belongs above the list rather than in it.

## Don't repeat a perspective's exact wording across groups

**Before** (the same perspective question attached verbatim to two different parent claims across two different groups, plus a near-duplicate "immediacy" claim inside one of them):
> - does a search return a list of results? *(appeared under two unrelated claims)*

**After**: merged into one claim, one new and *distinct* perspective:
> - does a newly-created engine produce results immediately, with no additional setup?

Repetition that restates is noise, not reinforcement: it doesn't strengthen the claim, it just means the same test runs twice under different names while an actually-distinct property (does immediacy hold even on a just-constructed engine?) goes unverified.

## Cut the bullet that only restates its neighbor

**Before** (Router, two bullets under one group):
> - unmatched routes fall back to `notFound`, not a blank render
> - a route that has no match does not render nothing

**After**: the second bullet, cut. It's the same claim said in the negative, adding a contrapositive without adding information. If removing a bullet loses nothing a reader didn't already have, it was weight, not content.

## Avoid code fences except where you're teaching vocabulary, not asserting a claim

Code fences are legitimate in GRAMMAR.md -- they're teaching the grammar itself, separate from any one document's claims. Inside a component's `.lld.md`, a code fence in the middle of prose is usually a sign the sentence gave up trying to say the thing in English. If a claim needs a snippet to make sense, that's often the tell that the claim is actually two claims, or that the sentence needs the axis named explicitly (see above) instead of shown.

---

## The test, restated

Every rule above is one instance of the same check: **read the sentence with no knowledge of the source file. Does it still mean something specific?**

- "Clears the 2D context and resets stroke state" fails this test a little (which context? what state?) -- "erase the drawn content, and reset any stroke currently being tracked" passes it.
- "The same activation path as Button" fails it (a reader now believes something false about the codebase) -- "the same principle Button applies" passes it.
- A bare claim with no perspective fails it by omission: there's a decision stated but nothing the reader (or the runner) can hold onto to confirm it.

If you're editing an `.lld.md` and you can't tell whether a sentence passes, read it out loud to someone who has never seen the implementation. Where they'd ask "wait, what does that mean exactly" is where the next edit goes.
