# Run Contract
> src/run.ts

**mutate:** false

The `run` command is the primary entry point. It executes the full pipeline -- translating claims,
generating tests, running them, checking drift, and running mutation testing -- in one invocation.
Exactly one thing decides the exit code: whether a claim the tool could verify came out false.
Drift and surviving mutations are reported alongside, but neither fails the run -- both are signals
that a human has to weigh, not verdicts the tool is entitled to reach on its own.

Every claim below runs a real document from `lld/fixtures/` and inspects the outcome. These are
the contracts a caller wires into CI, so leaving them as prose the tool could not check would be
the wrong place to be relaxed about it.

This document sets `**mutate:** false`. Each claim here already drives a full pipeline, so
mutating `src/run.ts` would re-run all of them once per mutant -- and what those mutants flip is
orchestration and reporting, which these claims verify end-to-end anyway. The cost is minutes; the
information is close to nothing. `src/run.ts` is still covered by the claims themselves and by
`src/run.test.ts`.

## A passing suite exits zero

**method:** `runDocument`

- when every verified claim holds, the process exits 0 -- drift findings do not change that, however many there are
  - runDocument("lld/fixtures/passing.lld.md") captures r → r.exitCode === 0
  - runDocument("lld/fixtures/passing.lld.md") captures r → r.failed === 0

## A claim carried entirely by its perspectives is a success, reported apart from a direct pass

**method:** `runDocument`

- a bare prose claim with a concrete perspective under it has no test of its own; the perspective carries the evidence, and that is a legitimate way to verify the claim -- the author wrote the perspective, so the author decided it operationalises the parent
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.indirect === 1
- it is not the same evidence as a test of the claim itself, so it is counted separately rather than folded into the passing total; a reader deciding whether to trust a green document can see the difference
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.passed === 1
- being indirect never fails a run -- collapsing the distinction would have been safe for the exit code and dishonest in the report, so the report is where the distinction lives
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.exitCode === 0
  - runDocument("lld/fixtures/indirect.lld.md") captures r → r.failed === 0

## A failing suite exits non-zero

**method:** `runDocument`

- when a claim fails, the process exits non-zero to signal to the calling environment that the document is incomplete or the implementation has diverged
  - runDocument("lld/fixtures/failing.lld.md") captures r → r.exitCode === 1
- the failure is counted, not just signalled -- a caller can see how much came out false without parsing the output
  - runDocument("lld/fixtures/failing.lld.md") captures r → r.failed === 1

## Mutation testing runs automatically after a passing suite

**method:** `runDocumentWithMutations`

- `run` does not require a separate `mutate` invocation -- if all tests pass, mutation testing runs automatically to check the strength of the claims
  - runDocumentWithMutations("lld/fixtures/weak.lld.md") captures r → r.survivingMutations === 1

## Surviving mutations are advisory, not a build failure

**method:** `runDocumentWithMutations`

The alternative was tried and rejected. Failing the build on surviving mutations pressures authors
into adding claims whose only purpose is to kill a mutant, which is coverage-shaped writing and
the opposite of what an LLD is for. A document is allowed to be deliberately silent about a
behavior, and `lld/fixtures/weak.lld.md` is that case in miniature.

- a surviving mutation says no claim in the document would notice that change to the implementation; that is worth surfacing, but it is not the same as a claim being wrong, so it does not fail the run
  - runDocumentWithMutations("lld/fixtures/weak.lld.md") captures r → r.exitCode === 0

## A mutant that could not run is counted separately from one that was caught

**method:** `runDocumentWithMutations`

- a mutant that fails to load has not been caught by anything; reporting it as caught would claim strength the run has no evidence for, so it is tracked on its own
  - runDocumentWithMutations("lld/fixtures/weak.lld.md") captures r → r.erroredMutations === 0

## Drift is checked as part of every run

**method:** `runDocument`

Drift is informational. It surfaces divergence so the author can decide whether to update the
document or revert the code, and it never causes a non-zero exit on its own -- the same judgment
as surviving mutations. The tool can see that something moved; it cannot see whether the document
or the code is the thing that should change.

The outcome carries `hadDrift` for exactly that reason: a caller that wants to gate on drift can,
but it has to choose to, and the choice stays visible in the caller's config rather than buried
in this tool's exit code.

- running `lldtdd run` always includes drift detection -- callers do not need to invoke `drift` separately to keep the document current
  - runDocument("lld/fixtures/passing.lld.md") captures r → r.hadDrift === false
