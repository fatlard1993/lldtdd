// The parent half of subprocess module inspection. inspectModule spawns src/inspectWorker.ts, which
// imports the subject module in its own process and writes the runtime facts lldtdd needs -- export
// names, the optional __lld_api string, and zero-arg scenario results -- to a temp file.
//
// This is the one place lldtdd's fact extraction runs a subject's code, and it does so out of
// process on purpose. Importing a module in-process meant a subject could call process.exit and make
// the whole run vanish with exit 0 (a green a CI gate cannot tell from success), or monkeypatch
// globals before the mutation pass wrote to the user's tree. Across the subprocess boundary, a
// subject that exits or crashes only kills the worker, and this returns null -- the caller then falls
// back to reading the source statically, exactly as it already did when an import merely threw.

import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { trackTempFile, untrackTempFile } from "./tempFiles.ts";

export interface InspectResult {
  exports: string[];
  api?: string;
  scenarios: Record<string, { result?: unknown; threw: boolean }>;
}

const workerPath = new URL("./inspectWorker.ts", import.meta.url).pathname;

export async function inspectModule(
  modulePath: string,
  scenarioNames: string[] = []
): Promise<InspectResult | null> {
  const outFile = join(tmpdir(), `lldtdd-inspect-${randomUUID()}.json`);
  trackTempFile(outFile);
  try {
    const proc = Bun.spawn(
      ["bun", "run", workerPath, modulePath, outFile, JSON.stringify(scenarioNames)],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" }
    );
    await proc.exited;
    let parsed: { ok?: boolean; exports?: string[]; api?: string; scenarios?: InspectResult["scenarios"] } | null = null;
    try { parsed = JSON.parse(await readFile(outFile, "utf-8")); } catch { return null; }
    if (!parsed?.ok) return null;
    return { exports: parsed.exports ?? [], api: parsed.api, scenarios: parsed.scenarios ?? {} };
  } finally {
    await unlink(outFile).catch(() => {});
    untrackTempFile(outFile);
  }
}
