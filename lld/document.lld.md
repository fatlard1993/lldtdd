# LLD Document Format
> src/parser.ts

A design document that can be mechanically verified. The format exists at two scales simultaneously: it must be readable by a developer who has never seen the codebase, and by a stakeholder who has never read code. The tests it generates are a consequence of the design, not the point of the document.

## A module annotation links design to implementation
**method:** `parse`

- every document names the module it describes; the link is explicit, not inferred
  - does a document with a module path produce a parsed result with a groups array?
- the first `>` line is the pointer; a blockquote further down is prose // documents quote things, and a quotation must not silently repoint the document at another module
  - parse("# S\n> real.ts\n\n## G\n\n> a quoted aside\n\n- a claim\n", "s.lld.md") captures r -> r.module contains "real.ts"
- the first `#` heading is the title, for the same reason // a later top-level heading is a section of prose, not a rename
  - parse("# The Title\n> m.ts\n\n# An Aside\n\n## G\n\n- a claim\n", "s.lld.md") captures r -> r.title === "The Title"

## Groups name design decisions, not test categories
**method:** `parse`

- a group is a design decision stated plainly -- not "tests for X" but "X works this way"; the heading is a claim about the system, not an organizational label
  - does a group heading become a named group in the document?

## Claims have two foundational forms: natural language and direct assertion
**method:** `parse`

- a claim stated as a question or natural language assertion describes intent -- the framework derives what test to generate from the module's structure
  - parse("# S\n> m.ts\n\n## G\n\n- the cache is cleared on logout\n", "s.lld.md") captures r -> r.groups[0].assertions[0].raw === "the cache is cleared on logout"
- a claim stated as a direct value assertion (`fn(input) -> expected`) is itself a design statement about what the function produces -- it is executed directly without derivation
  - does a top-level assertion produce an assertion in the parsed group?
  - does an indented perspective produce a nested entry attached to its parent assertion?
  - does a claim with the `->` separator produce a parseable assertion?
- normalizing the two spellings of the outcome separator is the parser's job, not the file reader's // when only the file-reading path normalized, content passed straight to `parse` kept its ASCII arrows, matched no outcome pattern, and demoted every claim to a bare invariant -- all pending, exit 0, on claims that were in fact false. The ASCII half of this cannot be claimed here: normalization rewrites the whole document, so an `->` inside a claim's own string argument is already a `→` by the time the claim runs. `src/run.test.ts` covers that side, where a string literal survives as written.
  - parse("# S\n> m.ts\n\n## G\n\n- double(2) → 4\n", "s.lld.md") captures r -> r.groups[0].assertions[0].outcome === "4"

## Multi-step claims express sequential operations with captured intermediates
**method:** `parse`

- some design decisions require operating on the result of a prior step -- a claim can capture an intermediate result and use it in a subsequent call: `create(A) captures r then update({ id: r.id }) captures result`
- this is the intended form for claims about operations that depend on state from a previous operation; it is not shorthand for writing two separate claims
  - does a captures-chain claim produce a parseable assertion with action and extra-call steps?

## Repeat claims express idempotency and accumulation
**method:** `parse`

- a claim prefixed `Nx` means the action runs N times before the assertion is checked -- `3x create(A) → result` asserts on the state after three repetitions
- this is for design decisions that only become observable after accumulation: rate limits, lockout thresholds, queue depth
  - does a repeat prefix produce a parseable assertion with a repeat count?

## Groups carry execution context through annotations
**method:** `parse`

- a group may declare a `**setup:**` function that creates the subject, a `**module:**` override to test a different module than the document's default, `**beforeAll:**` and `**beforeEach:**` lifecycle hooks, and a `**mock-http:**` response shape for HTTP-dependent tests; these are metadata that the framework uses to generate correct test scaffolding
  - does a document parse correctly when groups contain annotation lines?

## Lifecycle can be declared at document scope
**method:** `parse`

Parsing records these as document-level defaults rather than copying them onto each group; applying
them to a group that has not overridden them is translation's job, and `lld/pipeline.lld.md` states
that half. Keeping the two apart is what lets a group override a default at all.

- `**beforeAll:**` and `**beforeEach:**` may appear at the document level, before any group heading
  - parse("# S\n> m.ts\n\n**beforeEach:** `reset()`\n\n## G\n\n- a claim\n", "s.lld.md") captures r -> r.defaultBeforeEach === "reset()"
  - parse("# S\n> m.ts\n\n**beforeAll:** `initDb()`\n\n## G\n\n- a claim\n", "s.lld.md") captures r -> r.defaultBeforeAll === "initDb()"
- document-level lifecycle is for modules whose every test requires the same setup -- the same database state, the same authenticated session
  - parse("# S\n> m.ts\n\n**beforeAll:** `initDb()`\n\n## A\n\n- one\n\n## B\n\n- two\n", "s.lld.md") captures r -> r.groups.length === 2

## Fault-resilience claims describe what survives a failure
**method:** `parse`

A fault-resilience claim says the system degrades gracefully, not that it produces a specific result,
which is what separates it from a correctness claim about the same call. The format stays out of
that distinction: the parser records the sentence and nothing else, so what a phrasing *means* is
settled in one place rather than two.

- a claim is stored as written, whatever vocabulary it uses; the format assigns no meaning to phrasing
  - parse("# S\n> m.ts\n\n## G\n\n- a failed fetch does not stall the queue\n", "s.lld.md") captures r -> r.groups[0].assertions[0].raw === "a failed fetch does not stall the queue"

## Claims use natural language, not embedded logic
**method:** `parse`

- the document belongs to a shared audience; logic embedded in a claim couples the design to implementation details that will change and excludes collaborators who don't read code; direct assertions express value relationships, not logic
  - does a plain-language claim without any code-like syntax parse into a non-empty assertion?

## The format is valid for both new design and backfilled intent
**method:** `parse`

- writing the document before code exists and writing it to describe code that already exists are equally valid uses; the format does not distinguish between them and neither does the parser
  - does a document with a module path produce the same document structure whether or not that module currently exists?
