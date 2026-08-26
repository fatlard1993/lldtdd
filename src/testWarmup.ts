// Shared test warm-up.
//
// ts-morph loads the TypeScript compiler and its lib files the first time anything actually
// builds a source file -- roughly six seconds, once per process, no matter how small the input.
// That is a fixed cost of the tool, not a slow test.
//
// Left unpaid, it lands on whichever test first reaches ts-morph and pushes it past bun's
// five-second default. Which test that is depends on file scheduling and on what ran before, so
// the failure moves: it was in drift.test.ts, and adding three unrelated parser tests moved it to
// translator.test.ts. A correctness test failing on a timeout it didn't cause, in a file nobody
// edited, is a bad signal to hand anyone.
//
// So it is paid once per file that needs it, out loud, with a timeout set for what it actually is.
//
//   import { warmTsMorph } from "./testWarmup.ts";
//   beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

import { compareSourcesForDrift } from "./drift.ts";

/** Generous, because this is a compiler load and CI runners are slower than laptops. */
export const WARMUP_TIMEOUT_MS = 60_000;

let warmed = false;

/** Forces the ts-morph/TypeScript load. Idempotent -- repeated calls are free. */
export function warmTsMorph(): void {
  if (warmed) return;
  warmed = true;
  compareSourcesForDrift(
    "export function _warm() { return 1; }",
    "export function _warm() { return 2; }",
    [],
  );
}
