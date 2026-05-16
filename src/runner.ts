import { readFile } from "fs/promises";
import { resolve } from "path";
import { glob } from "glob";
import { parseFile } from "./parser.ts";
import { translate } from "./translator/index.ts";
import { synthesize } from "./synthesis/index.ts";
import { BunAdapter } from "./adapters/bun.ts";
import type { Adapter } from "./adapters/interface.ts";
import type { RunResult } from "./types.ts";

export interface Config {
  mappings: Array<{ glob: string; adapter: string }>;
}

const ADAPTERS: Record<string, Adapter> = {
  bun: new BunAdapter(),
};

export async function loadConfig(cwd: string): Promise<Config> {
  try {
    const raw = await readFile(resolve(cwd, ".lldtddrc"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { mappings: [{ glob: "**/*.lld.md", adapter: "bun" }] };
  }
}

export async function* streamFiles(
  pattern: string | undefined,
  config: Config,
  cwd: string
): AsyncGenerator<RunResult> {
  for (const mapping of config.mappings) {
    const filePattern = pattern ?? mapping.glob;
    const adapter = ADAPTERS[mapping.adapter];
    if (!adapter) { console.error(`Unknown adapter: ${mapping.adapter}`); continue; }

    const files = await glob(filePattern, { cwd, absolute: true, ignore: ["node_modules/**"] });

    for (const file of files) {
      process.stderr.write(`parsing ${file}\n`);
      const doc = await parseFile(file);
      const translated = await translate(doc);
      const suite = await synthesize(translated);
      const result = await adapter.run(suite);
      result.modulePath = suite.modulePath;
      result.groups = translated.groups;
      result.lldFile = file;
      yield result;
    }
  }
}

export async function runFiles(
  pattern: string | undefined,
  config: Config,
  cwd: string
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for await (const r of streamFiles(pattern, config, cwd)) results.push(r);
  return results;
}
