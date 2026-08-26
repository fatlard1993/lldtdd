// Subprocess module inspector -- the isolated half of src/inspect.ts.
//
// This runs in its own process, spawned by inspectModule(). It imports the module under test, which
// runs that module's top-level code, and calls any requested zero-arg scenario exports. Doing this
// here rather than in lldtdd's own process is the whole point: a subject that calls process.exit,
// monkeypatches globals, or crashes the interpreter at import takes down only this worker. The parent
// reads the result from the output file; a worker that died before writing it is read as a failed
// inspection, so a hostile or broken module can no longer make `lldtdd run` exit 0 with the run
// half-done, nor tamper with lldtdd's process before the mutation pass writes to disk.
//
// The result goes to a file, not stdout, so the subject printing to stdout at import cannot corrupt
// it. Scenario results are round-tripped through JSON here so only values the parent can actually
// receive cross the boundary; anything that won't serialize becomes undefined, which every consumer
// already handles.
//
// argv: <modulePath> <outFile> [scenarioNamesJson]

import { writeFileSync } from "fs";

const [modulePath, outFile, scenariosJson] = process.argv.slice(2);
const scenarioNames: string[] = scenariosJson ? JSON.parse(scenariosJson) : [];

function emit(obj: unknown): void {
  try { writeFileSync(outFile, JSON.stringify(obj)); } catch { /* parent reads absence as failure */ }
}

async function main(): Promise<void> {
  const mod = await import(modulePath);
  const exports = Object.keys(mod).filter(
    k => typeof mod[k] === "function" && k !== "default" && !k.startsWith("__")
  );
  const api = typeof mod.__lld_api === "string" ? mod.__lld_api.trim() : undefined;

  const scenarios: Record<string, { result?: unknown; threw: boolean }> = {};
  for (const name of scenarioNames) {
    if (typeof mod[name] !== "function") continue;
    try {
      const result = await (mod[name] as () => unknown)();
      let safeResult: unknown = undefined;
      try { safeResult = JSON.parse(JSON.stringify(result)); } catch { /* unserializable -> undefined */ }
      scenarios[name] = { result: safeResult, threw: false };
    } catch {
      scenarios[name] = { threw: true };
    }
  }

  emit({ ok: true, exports, api, scenarios });
}

main().catch(err => emit({ ok: false, error: String((err && (err as { message?: string }).message) ?? err) }));
