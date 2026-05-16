# CLI Behavior
> src/cli.ts

The `run` command is the primary entry point. It executes the full pipeline — translating claims, generating tests, running them, checking drift, and running mutation testing — in one invocation. Exit codes are meaningful: 0 means the design document fully describes passing, well-verified behavior; non-zero means something requires attention.

## A passing suite exits zero
**method:** `runPassingExample`

- when all tests pass and no mutations survive, the process exits 0 — the document is current and its claims are strong enough to catch real bugs
  - does runAndCheck return exitCode 0 on a known-passing LLD?

## Mutation testing runs automatically after a passing suite
**method:** `runPassingExample`

- `run` does not require a separate `mutate` invocation — if all tests pass, mutation testing runs automatically to check the strength of the claims
  - does runAndCheck report mutation activity when tests pass?

## A failing suite exits non-zero
**method:** `runFailingExample`

- when tests fail, the process exits non-zero to signal to the calling environment that the document is incomplete or the implementation has diverged
  - does runAndCheck return exitCode 1 on a suite with failing tests?
  - does runAndCheck return survivingMutations of zero when tests fail?

## Surviving mutations exit non-zero
**method:** `runSurvivingMutationsExample`

- a surviving mutation means a design claim cannot catch a real bug; this is treated as a build failure, not a warning; the process exits non-zero
  - does runAndCheck return non-zero when mutations survive?

## Detecting drift does not fail the build
**method:** `runPassingExample`

- drift is informational — it surfaces divergence so the author can decide whether to update the document or revert the code; drift alone does not cause a non-zero exit
  - does runAndCheck report hadDrift without causing a non-zero exit?

## Drift is checked as part of every run
**method:** `runPassingExample`

- running `lldtdd run` always includes drift detection — callers do not need to invoke `drift` separately to keep the document current
  - does runAndCheck report hadDrift information?

## Lint checks document structure independently of the module

- `lldtdd lint` checks LLD files for structural and style problems without running any tests or loading any implementation module — it is the fast path for authors who want to validate their document format before running the full pipeline
- lint exits non-zero when structural errors are found; it does not require the module to be present or to compile

## Suggest infers method annotations from exports

- `lldtdd suggest` reads the module and the LLD document, infers which group each unnamed group most likely corresponds to based on its claims, and shows the resulting `**method:**` annotations
- `suggest --apply` writes the inferences back into the document; this is the intended bootstrap path when first adding a document to an existing codebase
- suggest is conservative: it only emits annotations when confidence is high enough to be useful; partial matches are surfaced for human review, not auto-applied
