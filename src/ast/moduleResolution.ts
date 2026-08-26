// Module-resolution helpers: every fact whose value is a path -- which files a module imports,
// where its database lives, which module provides its constructor, where its related entities'
// CRUD comes from, and which sibling file performs its primary action. This is the path.resolve
// cluster; nothing here inspects claim text, and nothing here uses ts-morph.

import { readFile } from "fs/promises";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname, basename, extname } from "path";
import { isContained } from "../pathContainment.ts";

/** Reads the module's local relative imports, and theirs, as extra source for fact extraction.
 *
 *  Two levels rather than one, because the facts a claim needs are routinely one hop further out
 *  than the module that uses them. A search module imports an entity, the entity imports the CRUD
 *  factory, and the database handle the generated suite has to initialize is declared in that
 *  factory -- at depth 1 the schema came through and the database did not, so every derived test
 *  was generated and then died on an uninitialized store.
 *
 *  It stops at two. This source is scanned by regex for declarations, so pulling in a whole
 *  transitive tree would start attributing distant modules' schemas and allowlists to this one,
 *  and a wrong fact is worse here than a missing one. Node modules are never followed.
 *
 *  Every followed import is contained to `root` (or the top module's own directory, for a module
 *  that legitimately lives outside root -- the linter's temp fixtures do). A module under review can
 *  contain `import x from "../../../../etc/passwd"`, and without containment the walk read it and fed
 *  its bytes into regex fact-extraction, so `lldtdd lint` on a document you did not write became a
 *  read of arbitrary files. The boundary here is the same one the parser puts on the module pointer;
 *  the transitive walk was the hole beneath it. */
export async function resolveImports(
  source: string,
  fromPath: string,
  root: string = process.cwd(),
  depth = 2
): Promise<Array<{ path: string; text: string }>> {
  const sources: Array<{ path: string; text: string }> = [];
  const seen = new Set<string>([resolve(fromPath)]);
  const bases = [resolve(root), dirname(resolve(fromPath))];

  async function walk(text: string, from: string, remaining: number): Promise<void> {
    if (remaining <= 0) return;
    const dir = dirname(from);

    for (const m of text.matchAll(/from\s+['"`](\.\.?\/[^'"`]+)['"`]/g)) {
      const raw = m[1];
      for (const ext of ["", ".js", ".ts", "/index.js", "/index.ts"]) {
        const abs = resolve(dir, raw + ext);
        if (!isContained(abs, bases)) break;   // climbs outside the project -- refuse the read
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
        if (seen.has(abs)) break;   // already read on another path through the graph
        seen.add(abs);
        try {
          const next = await readFile(abs, "utf-8");
          sources.push({ path: abs, text: next });
          await walk(next, abs, remaining - 1);
        } catch { /* unreadable sibling -- the facts it holds are simply absent */ }
        break;
      }
    }
  }

  await walk(source, fromPath, depth);
  return sources;
}

// Resolves the absolute path of the module that provides the primary constructor.
// Priority: explicit re-export of default → first capitalized default import → self (direct export default).
export function resolveConstructorModulePath(source: string, modulePath: string): string | undefined {
  const dir = dirname(modulePath);
  const reExport = source.match(/export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/);
  if (reExport) return resolve(dir, reExport[1]);
  // Case 1: inline class default-export -- this module IS the constructor
  if (/^export\s+default\s+class\b/m.test(source)) return modulePath;
  // Case 2: class defined locally, exported as default on a separate line
  const exportedName = source.match(/^export\s+default\s+(\w+)\s*;?\s*$/m)?.[1];
  if (exportedName && new RegExp(`\\bclass\\s+${exportedName}\\b`).test(source)) return modulePath;
  // Fall back to first capitalized default import (CLI-pattern modules that import a constructor)
  const defaultImport = source.match(/import\s+([A-Z]\w*)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/);
  if (defaultImport) return resolve(dir, defaultImport[2]);
  if (/export\s+default\s+/.test(source)) return modulePath;
  return undefined;
}

/** Detects the database module from the primary source, or from any file reached through it.
 *
 *  A relative specifier means nothing without knowing which file wrote it: `import database
 *  from '.'` inside the CRUD factory names the factory's own directory, not the directory of
 *  whatever module happens to be under test. Resolving it against the wrong base produced a
 *  path that did not exist, and the generated suite imported nothing at all. */
export function resolveDatabaseModulePath(files: Array<{ path: string; text: string }>): string | undefined {
  for (const file of files) {
    const m = file.text.match(/import\s+database\s+from\s+['"`]([^'"`]+)['"`]/);
    if (!m) continue;
    const raw = m[1];
    const base = dirname(file.path);
    if (raw === "." || raw === "./") return resolve(base, "index.js");
    if (raw.startsWith("./") || raw.startsWith("../")) return resolve(base, raw);
    return raw;
  }
  return undefined;
}

/** Maps related entity names to the absolute path of the module that provides their CRUD.
 *  Built from imports + FK relationships: "import categories from '...categories.js'" + FK
 *  "category" → { category: absPath }. */
export function resolveRelatedEntityPaths(
  source: string,
  modulePath: string,
  foreignKeys: Record<string, string>
): Record<string, string> {
  const importVarToPath: Record<string, string> = {};
  for (const m of source.matchAll(/import\s+(\w+)\s+from\s+['"`]([^'"`]+)['"`]/g)) {
    importVarToPath[m[1]] = m[2];
  }

  const paths: Record<string, string> = {};
  for (const relatedEntity of Object.values(foreignKeys)) {
    // Try common plural forms: "category" → "categories", "entity" → "entities", "item" → "items"
    const plural = relatedEntity.endsWith("y")
      ? relatedEntity.slice(0, -1) + "ies"
      : relatedEntity + "s";
    const varName = [relatedEntity, plural].find(v => importVarToPath[v]);
    if (varName && importVarToPath[varName]) {
      const relPath = importVarToPath[varName];
      paths[relatedEntity] = relPath.startsWith("./") || relPath.startsWith("../")
        ? resolve(dirname(modulePath), relPath)
        : relPath;
    }
  }
  return paths;
}

/** Resolves the sources behind `export { X } from "Y"` re-exports, first existing extension wins.
 *  Used by the function-type-chain stage, which scans those files for producer signatures. */
export function resolveReExportedSources(source: string, modulePath: string, root: string = process.cwd()): Array<{ path: string; text: string }> {
  const reExportPattern = /export\s*\{[^}]+\}\s*from\s*["']([^"']+)["']/g;
  const dir = dirname(modulePath);
  const bases = [resolve(root), dir];
  const files: Array<{ path: string; text: string }> = [];
  for (const m of source.matchAll(reExportPattern)) {
    const relPath = m[1];
    const absPath = relPath.startsWith(".") ? resolve(dir, relPath) : null;
    if (!absPath) continue;
    for (const ext of [".ts", ".js", ".tsx", ".jsx", ""]) {
      const candidate = absPath.endsWith(".ts") || absPath.endsWith(".js") ? absPath : absPath + ext;
      if (!isContained(candidate, bases)) continue;   // re-export target outside the project -- refuse
      if (!existsSync(candidate)) continue;
      try {
        files.push({ path: candidate, text: readFileSync(candidate, "utf-8") });
      } catch { /* skip unreadable */ }
      break;
    }
  }
  return files;
}

/** Detects the module's primary action function: the exported function that performs external I/O.
 *
 *  Priority: the optional/legacy __lld_primaryAction annotation (still accepted as an explicit
 *  override), then an exported async function whose body calls fetch, then a search-style import,
 *  then a reverse-dependency scan of sibling directories for a consumer file that imports this
 *  module AND calls fetch. */
export async function resolvePrimaryAction(
  source: string,
  allSource: string,
  modulePath: string,
  hasSchemas: boolean,
  root: string = process.cwd()
): Promise<{ primaryAction?: string; primaryActionModule?: string }> {
  let primaryAction: string | undefined;
  let primaryActionModule: string | undefined;

  // __lld_primaryAction is optional/legacy -- the system now auto-detects the primary action
  // by scanning sibling directories for a consumer file that imports this module AND calls fetch.
  // The annotation is still accepted as an explicit override when auto-detection isn't sufficient.
  const lldPrimaryActionMatch = source.match(/__lld_primaryAction\s*=\s*\{[^}]*name\s*:\s*["']([^"']+)["'][^}]*module\s*:\s*["']([^"']+)["'][^}]*\}/s)
    ?? source.match(/__lld_primaryAction\s*=\s*\{[^}]*module\s*:\s*["']([^"']+)["'][^}]*name\s*:\s*["']([^"']+)["'][^}]*\}/s);
  if (lldPrimaryActionMatch) {
    // Detect order: { name, module } or { module, name }
    const nameFirst = /__lld_primaryAction\s*=\s*\{[^}]*name/.test(source);
    primaryAction = nameFirst ? lldPrimaryActionMatch[1] : lldPrimaryActionMatch[2];
    const modRaw = nameFirst ? lldPrimaryActionMatch[2] : lldPrimaryActionMatch[1];
    primaryActionModule = (modRaw.startsWith("./") || modRaw.startsWith("../"))
      ? resolve(dirname(modulePath), modRaw)
      : modRaw;
  } else {
    const hasFetch = /\bfetch\b/.test(allSource) || /\bwithMockFetch\b/.test(allSource);
    if (hasFetch) {
      // Find exported async function that takes external results (search provider pattern)
      const providerMatch = allSource.match(/export\s+(?:const\s+(\w+)\s*=\s*async|async\s+function\s+(\w+))[^{]*\{[^}]*fetch/s);
      if (!providerMatch) {
        // Look for imported function used for searching -- capture where it's imported from
        const searchImportLine = allSource.match(/import\s*\{[^}]*(\bsearch\w*)\b[^}]*\}\s*from\s*['"`]([^'"`]+)['"`]/);
        if (searchImportLine) {
          primaryAction = searchImportLine[1];
          const raw = searchImportLine[2];
          primaryActionModule = (raw.startsWith("./") || raw.startsWith("../"))
            ? resolve(dirname(modulePath), raw)
            : raw;
        }
      } else {
        primaryAction = providerMatch[1] ?? providerMatch[2];
      }
    }
  }

  // Reverse-dependency scan: if no primaryAction found yet but the module has any schema,
  // scan sibling directories for a file that imports this module AND calls fetch -- that
  // file's first exported async function is primaryAction.
  if (!primaryAction && hasSchemas) {
    const modBase = basename(modulePath, extname(modulePath));
    const bases = [resolve(root), dirname(modulePath)];
    const searchDirs = ["../utils", "../helpers", "..", "."].map(d => resolve(dirname(modulePath), d));
    for (const dir of searchDirs) {
      if (!isContained(dir, bases)) continue;   // scan stays inside the project
      if (!existsSync(dir)) continue;
      let files: string[] = [];
      try { files = (await import("fs")).readdirSync(dir).filter((f: string) => /\.(js|ts)$/.test(f)); } catch { continue; }
      for (const file of files) {
        const fp = resolve(dir, file);
        if (fp === modulePath) continue;
        if (!isContained(fp, bases)) continue;
        try {
          const s = await readFile(fp, "utf-8");
          if (!s.includes(modBase) || !/\bfetch\b/.test(s)) continue;
          // Find the exported async function whose body directly calls fetch.
          // Bound each function's body by scanning to the NEXT top-level 'export' keyword.
          const exportFnRe = /export\s+(?:const\s+(\w+)\s*=\s*async|async\s+function\s+(\w+))/g;
          const allExports: Array<{ name: string; start: number }> = [];
          let efm2: RegExpExecArray | null;
          while ((efm2 = exportFnRe.exec(s)) !== null) {
            allExports.push({ name: efm2[1] ?? efm2[2], start: efm2.index });
          }
          let foundFn: string | undefined;
          for (let i = 0; i < allExports.length; i++) {
            const end = allExports[i + 1]?.start ?? s.length;
            const body = s.slice(allExports[i].start, end);
            if (/\bfetch\s*\(/.test(body)) { foundFn = allExports[i].name; break; }
          }
          if (foundFn) { primaryAction = foundFn; primaryActionModule = fp; break; }
        } catch { continue; }
      }
      if (primaryAction) break;
    }
  }

  return { primaryAction, primaryActionModule };
}
