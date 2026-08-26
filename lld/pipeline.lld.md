# Translation Pipeline
> src/pipeline.ts

A document becomes a test suite by translating each claim into a runnable test case. The pipeline has three stages: `parse` converts markdown into a document model, `translate` derives test cases from that model, and `synthesize` enriches the cases with argument shapes read from the module's source. Each stage is independently testable; the pipeline is the composition.

## Derivation reads the implementation, not annotations on it
**module:** `src/ast/index.ts`
**method:** `extractFacts`

Production code stays production code. Nothing in a module has to be decorated, registered, or
tagged for lldtdd to derive tests from it -- the AST is the interface, and a module that has never
heard of this tool is fully usable by it.

- the translator reads the implementation source to derive what tests to generate; it does not require the author to annotate production code with test metadata
  - extractFacts("lld/fixtures/subject.ts") captures r → r.returnTypes is defined
  - extractFacts("lld/fixtures/subject.ts") captures r → r.exportVerbs is defined

## A missing module produces null, not an error
**module:** `src/ast/index.ts`
**method:** `extractFacts`

- asking for facts about a module that does not exist is a legitimate state during early design -- the document is written before the code; the result is null, not a thrown error
  - extractFacts("lld/fixtures/not-written-yet.ts") captures r → r === null

## Test cases carry a source tag communicating derivation confidence
**method:** `translate`

- the source tag on each test case records how it was derived: `deterministic` for a documented grammar rule, `ast-derived` for a structural pattern in the implementation, `pending` for a claim nothing derives yet
  - does a translated test suite produce test cases with defined source tags?

## Derivation is offline, so a suite is reproducible
**method:** `translate`

There was a fourth source tag once. A claim matching neither the grammar nor an AST pattern was
sent to a model, which guessed a test body; the guesses were the weakest cases in every suite,
most of them collapsing to a bare "the call resolves", which passes for any function that does not
throw and so verified nothing. It was demoted back to pending often enough that the path was
easier to describe than to defend.

The deciding argument was not quality but reproducibility. That path made the derived suite a
function of network reachability, an API key, and a model version -- so the same commit could
report differently on two machines. A test runner whose results depend on which machine ran it is
not reporting. Everything the translator does now is a function of the document and the
implementation source alone.

- the same document and the same implementation always derive the same suite; nothing in translation reads the network, a cache, or the clock
  - does translating a document twice produce identical test cases?

## An unmatched claim stays pending rather than being guessed at
**method:** `translate`

- a claim no rule matches is recorded as pending, not turned into a test that would pass without checking anything; pending says "this intent is documented but not yet verified", which is true, and a green from a guess says something false
  - does an unmatchable claim produce a test case tagged `pending`?

## Document-level lifecycle reaches the groups that did not override it
**method:** `translate`

Parsing records `**beforeAll:**` and `**beforeEach:**` written above the first group as document
defaults and stops there -- see `lld/document.lld.md`. Translation is what hands them to each group,
and it is the only place that can, because "did this group override the default" is a question about
the assembled suite rather than about the text.

- a group that declares no lifecycle of its own inherits the document's
  - runDocument("lld/fixtures/doc-lifecycle.lld.md") captures r → r.failed === 0
- a group that declares its own keeps it; the document default does not overwrite a local decision
  - runDocument("lld/fixtures/doc-lifecycle.lld.md") captures r → r.passed === 2

## When a claim has perspectives, the perspectives carry it
**method:** `translate`

The parent states the design decision and the perspectives test the angles, so the parent gets no
test of its own. Translation says so by leaving its case unresolved; the runner reports that as
`indirect` rather than as pending, because a claim whose perspectives all passed *has* been
verified -- just not directly. Pending would say nothing checked it, which is a different and
untrue thing. See `lld/run.lld.md` for the reporting contract.

- adding sub-perspectives to a claim means the perspectives are tested individually; the parent claim is not tested on its own, so translation leaves it unresolved rather than inventing an assertion for it
  - does the parent of a claim with sub-perspectives become pending?
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.indirect === 1
- a parent carried entirely by its perspectives is still a success; it is counted apart from a direct pass so a reader can tell the two kinds of evidence apart
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.exitCode === 0

## Unresolved claims produce test cases, never disappear
**method:** `translate`

- a claim the pipeline cannot translate into a runnable test is still visible in the output as a pending case; a failing translation is never mistaken for a passing one
  - does translating a document with one group produce a suite with exactly one group?
  - does a document with an unmatchable claim still produce at least one test case in the suite?
