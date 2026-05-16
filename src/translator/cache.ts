import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { resolve } from "path";
import type { TestCase } from "../types.ts";

type CacheEntry = TestCase & { cachedAt: string };
type CacheStore = Record<string, CacheEntry>;

const CACHE_FILE = resolve(process.cwd(), ".lldtdd-cache.json");

let memory: CacheStore | null = null;
let dirty = false;

async function load(): Promise<CacheStore> {
  if (memory) return memory;
  try {
    memory = JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    memory = {};
  }
  return memory!;
}

export function cacheKey(raw: string, module: string, group: string, groupMethod?: string): string {
  return createHash("sha256")
    .update(`${module}::${group}::${groupMethod ?? ""}::${raw}`)
    .digest("hex")
    .slice(0, 16);
}

export async function get(key: string): Promise<TestCase | null> {
  const store = await load();
  const entry = store[key];
  if (!entry) return null;
  return {
    description: entry.description,
    setup: entry.setup,
    action: entry.action,
    assertion: entry.assertion,
    source: entry.source,
  };
}

export async function set(key: string, tc: TestCase): Promise<void> {
  const store = await load();
  store[key] = { ...tc, cachedAt: new Date().toISOString() };
  dirty = true;
}

export async function flush(): Promise<void> {
  if (!dirty || !memory) return;
  await writeFile(CACHE_FILE, JSON.stringify(memory, null, 2));
  dirty = false;
}
