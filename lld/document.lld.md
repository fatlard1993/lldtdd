# LLD Document Format
> src/parser.ts

A design document that can be mechanically verified. The format exists at two scales simultaneously: it must be readable by a developer who has never seen the codebase, and by a stakeholder who has never read code. The tests it generates are a consequence of the design, not the point of the document.

## A module annotation links design to implementation
**method:** `parse`

- every document names the module it describes; the link is explicit, not inferred
  - does a document with a module path produce a parsed result with a groups array?

## Groups name design decisions, not test categories
**method:** `parse`

- a group is a design decision stated plainly — not "tests for X" but "X works this way"; the heading is a claim about the system, not an organizational label
  - does a group heading become a named group in the document?

## Claims have two foundational forms: natural language and direct assertion
**method:** `parse`

- a claim stated as a question or natural language assertion describes intent — the framework derives what test to generate from the module's structure
- a claim stated as a direct value assertion (`fn(input) -> expected`) is itself a design statement about what the function produces — it is executed directly without derivation
  - does a top-level assertion produce an assertion in the parsed group?
  - does an indented perspective produce a nested entry attached to its parent assertion?
  - does a claim with the `->` separator produce a parseable assertion?

## Multi-step claims express sequential operations with captured intermediates
**method:** `parse`

- some design decisions require operating on the result of a prior step — a claim can capture an intermediate result and use it in a subsequent call: `create(A) captures r then update({ id: r.id }) captures result`
- this is the intended form for claims about operations that depend on state from a previous operation; it is not shorthand for writing two separate claims
  - does a captures-chain claim produce a parseable assertion with action and extra-call steps?

## Repeat claims express idempotency and accumulation
**method:** `parse`

- a claim prefixed `Nx` means the action runs N times before the assertion is checked — `3x create(A) → result` asserts on the state after three repetitions
- this is for design decisions that only become observable after accumulation: rate limits, lockout thresholds, queue depth
  - does a repeat prefix produce a parseable assertion with a repeat count?

## Groups carry execution context through annotations
**method:** `parse`

- a group may declare a `**setup:**` function that creates the subject, a `**module:**` override to test a different module than the document's default, `**beforeAll:**` and `**beforeEach:**` lifecycle hooks, and a `**mock-http:**` response shape for HTTP-dependent tests; these are metadata that the framework uses to generate correct test scaffolding
  - does a document parse correctly when groups contain annotation lines?

## Lifecycle can be declared at document scope
**method:** `parse`

- `**beforeAll:**` and `**beforeEach:**` may appear at the document level before any group heading; they set defaults that apply to all groups unless a group overrides them
- document-level lifecycle is for modules whose every test requires the same setup — the same database state, the same authenticated session
  - does a document-level beforeAll annotation propagate to groups that don't override it?

## Fault-resilience claims describe what survives a failure
**method:** `parse`

- a claim phrased as "a failed X does not stall Y" describes a fault-resilience property — the system continues operating correctly even when a component fails; the framework recognizes this pattern and generates fault-injection tests automatically
- this is distinct from correctness claims: a fault-resilience claim says the system degrades gracefully, not that it produces a specific result
  - does a claim matching the "a failed X does not stall Y" pattern parse into a distinct assertion structure?

## Claims use natural language, not embedded logic
**method:** `parse`

- the document belongs to a shared audience; logic embedded in a claim couples the design to implementation details that will change and excludes collaborators who don't read code; direct assertions express value relationships, not logic
  - does a plain-language claim without any code-like syntax parse into a non-empty assertion?

## The format is valid for both new design and backfilled intent
**method:** `parse`

- writing the document before code exists and writing it to describe code that already exists are equally valid uses; the format does not distinguish between them and neither does the parser
  - does a document with a module path produce the same document structure whether or not that module currently exists?
