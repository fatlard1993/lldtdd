// Zero-arg scenario extraction: the one stage of fact extraction that may run the module
// under test. Kept apart from the static extractors so the boundary is visible: everything
// else in src/ast/ only reads source text, while this file dynamically imports and calls
// exported scenario wrappers when (and only when) the caller opts into execution.

import type { ZeroArgScenario } from "./types.ts";
import { extractCallArgs } from "./sourceScrapers.ts";
import { inspectModule } from "../inspect.ts";

// Finds exported zero-arg arrow functions that wrap detection-signal calls
// (parseArgs / exitCode / checkExitCalled / parseManually), extracts their argument
// source text verbatim (preserving embedded arrow functions), and -- when the caller opts into
// execution -- calls them to capture the result for assertion generation.

export async function extractZeroArgScenarios(
  source: string,
  modulePath: string,
  execute: boolean
): Promise<Record<string, ZeroArgScenario>> {
  const scenarios: Record<string, ZeroArgScenario> = {};
  // Match any exported zero-arg arrow function that calls a local or imported helper function.
  // The callFn can be any function name, not tied to one project's specific exports.
  const pattern = /export\s+const\s+(\w+)\s*=\s*\(\)\s*=>\s*\n?\s*(\w+)\s*\(/g;
  for (const m of source.matchAll(pattern)) {
    const name = m[1];
    const callFn = m[2] as ZeroArgScenario["callFn"];
    const openPos = m.index! + m[0].length;
    const args = extractCallArgs(source, openPos);
    // CLI-style callFns need argv + options (≥2 args); general callFns only need 1
    const cliCallFns = new Set(["parseArgs", "exitCode", "checkExitCalled", "parseManually"]);
    if (cliCallFns.has(callFn) ? args.length >= 2 : args.length >= 1) {
      scenarios[name] = { callFn, argvText: args[0] ?? "", optText: args[1] ?? "", cfgText: args[2] };
    }
  }
  if (Object.keys(scenarios).length === 0) return scenarios;
  // Capturing a scenario's result means calling the export, which means running the module.
  // A reading caller (`lint`, `suggest`) gets the scenario shapes without their results: the
  // assertions those results would have produced stay pending rather than running someone's code.
  if (!execute) return scenarios;
  // The calls run in a subprocess (see inspectModule), so a scenario that exits, crashes, or
  // mutates process state -- including process.argv, which CLI parsers reassign -- cannot reach
  // this process. A failed inspection just leaves the results absent, so those assertions stay
  // pending. This also removes the old in-process re-entry and argv-restore hazards entirely.
  const inspected = await inspectModule(modulePath, Object.keys(scenarios));
  if (inspected) {
    for (const [name, r] of Object.entries(inspected.scenarios)) {
      const scenario = scenarios[name];
      if (scenario) { scenario.result = r.result; scenario.threw = r.threw; }
    }
  }
  return scenarios;
}
