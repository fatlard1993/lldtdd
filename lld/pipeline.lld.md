# Translation Pipeline
> src/pipeline.ts

A document becomes a test suite by translating each claim into a runnable test case. The pipeline has three stages: `parse` converts markdown into a document model, `translate` derives test cases from that model, and `synthesize` enriches the cases with argument shapes read from the module's source. Each stage is independently testable; the pipeline is the composition.

## Derivation detects schema from source structure
**module:** `src/ast.ts`
**method:** `factsFromCrudSource`

- the translator reads the implementation source to derive what tests to generate; it does not require the author to annotate production code with test metadata
  - does extracting facts from a CRUD module produce a detected schema?

## Modules without CRUD schema return empty schema lists
**module:** `src/ast.ts`
**method:** `factsFromNonCrudSource`

- a module that contains no recognized schema factory produces empty schema metadata — derivation degrades gracefully rather than erroring
  - does a module without a CRUD schema return an empty schemas list?

## A missing module produces null, not an error
**module:** `src/ast.ts`
**method:** `factsFromMissingPath`

- asking for facts about a module that does not exist is a legitimate state during early design; the result is null, not a thrown error
  - does extractFacts on a non-existent path return null — the check returns true when the path is missing?

## The translator stage takes a document and produces a test suite
**module:** `src/pipeline.ts`
**method:** `translate`

- `translate` takes an `LLDDocument` produced by `parse` and produces a `TestSuite`; the stages are linked by type — the output of one is the input of the next
  - does translating a parsed document produce a suite with at least one group?

## Test cases carry a source tag communicating derivation confidence
**module:** `src/pipeline.ts`
**method:** `translate`

- the source tag on each test case records how it was derived: `deterministic`, `ast-derived`, `ai`, or `needs-fixture`
  - does a translated test suite produce test cases with defined source tags?

## AI fills gaps with live network calls; results are cached
**module:** `src/pipeline.ts`
**method:** `translate`

- when neither grammar nor AST derivation can match a claim, AI generates a test body by calling an external model — this is a live network call, not an offline lookup
- to avoid redundant calls and cost, AI results are cached by claim text and module; the cache persists between runs and is invalidated when claims change
  - does translation of an unmatchable claim produce a test case with source tag `ai` or `needs-fixture`?

## Weak AI output is demoted rather than passed
**module:** `src/pipeline.ts`
**method:** `weakAiIsDemoted`

- a test body that only asserts the call resolves — no captures, no field assertions — is no stronger than a pending test; the framework demotes uncaptured resolves from AI to `needs-fixture` rather than reporting them as passing
- this keeps the passing count honest: a test that doesn't assert anything specific does not count as verified
  - does an unmatchable claim produce a test case tagged as `ai` or `needs-fixture`?

## When a claim has perspectives, the claim itself becomes pending
**module:** `src/pipeline.ts`
**method:** `perspectiveParentIsPending`

- adding sub-perspectives to a claim means the perspectives are tested individually; the parent claim is not tested on its own — it becomes a pending summary of its sub-claims
- this is intentional: the parent states the design decision, the perspectives test the angles; the parent has no independent assertion
  - does the parent of a claim with sub-perspectives become pending?

## Unresolved claims produce test cases, never disappear
**method:** `translatesDocumentGroupCount`

- a claim the pipeline cannot translate into a runnable test is still visible in the output as a pending case; a failing translation is never mistaken for a passing one
  - does translating a document with one group produce a suite with exactly one group?
  - does a document with an unmatchable claim still produce at least one test case in the suite?

## The synthesis stage enriches the suite with argument shapes
**module:** `src/pipeline.ts`
**method:** `synthesize`

- `synthesize` takes a `TestSuite` from the translator and produces an enriched `TestSuite` with concrete argument values derived from module source signatures
  - does synthesizing a translated suite produce a non-empty result?
  - does the synthesized result preserve the groups from the input?

## Lint checks document structure without running tests
**module:** `src/pipeline.ts`
**method:** `lintCleanDocument`

- `lintFile` inspects an LLD document for structural problems — missing title, missing module pointer, empty groups, malformed annotations, stale method names — and returns a structured result; no module loading or test generation is involved
- a well-formed document produces zero errors
  - does linting a clean document return zero errors?

## A structurally invalid document produces lint errors
**module:** `src/pipeline.ts`
**method:** `lintMissingStructure`

- a document missing its title and module pointer is not a valid LLD; lint surfaces this as errors so the author can correct the structure before running the full pipeline
  - does linting a document without title or module pointer produce at least one error?

## Suggest infers method annotations from module exports
**module:** `src/pipeline.ts`
**method:** `suggestOnCleanDocument`

- `suggestFile` reads the LLD and the module it points to, compares group names to exported function names, and returns inferred annotations; the author can review them before applying
  - does running suggest on a document produce a result with a groups array?

## The pipeline accepts in-memory content, not only files
**module:** `src/cli.ts`
**method:** `runContentExample`

- `runContentAndCheck` runs the full pipeline on a raw LLD content string without requiring a file on disk — the module annotation in the content string is what links the document to its implementation
- this is the intended form for programmatic or scenario-based pipeline use: a calling context can construct an LLD document inline and run it without writing to the filesystem
  - does running an in-memory LLD document produce a RunOutcome?
