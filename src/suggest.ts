import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { parse } from "./parser.ts";
import { getModuleExports, matchGroupToExport } from "./inference.ts";

export interface SuggestionGroup {
  name: string;
  line: number;
  hasMethod: boolean;
  hasSetup: boolean;
  inferred: { method: string; confidence: string } | null;
}

export interface SuggestResult {
  file: string;
  modulePath: string;
  moduleExists: boolean;
  groups: SuggestionGroup[];
}

export async function suggestFile(filePath: string): Promise<SuggestResult> {
  const raw = await readFile(filePath, "utf-8");
  const content = raw.replace(/ *-> */g, " → "); // normalize for parser
  const doc = parse(content, filePath);

  const moduleExists = existsSync(doc.module);
  const exports = await getModuleExports(doc.module);

  const groups: SuggestionGroup[] = [];
  const lines = raw.split("\n");

  for (const group of doc.groups) {
    const lineNum = lines.findIndex(l => l.trim() === `## ${group.name}`) + 1;
    const inferred =
      !group.method && !group.setup && exports.length > 0
        ? matchGroupToExport(group.name, exports)
        : null;

    groups.push({
      name: group.name,
      line: lineNum,
      hasMethod: !!group.method,
      hasSetup: !!group.setup,
      inferred,
    });
  }

  return { file: filePath, modulePath: doc.module, moduleExists, groups };
}

// Apply auto-applicable suggestions (exact + camel confidence) to the file
export async function applyInferences(filePath: string): Promise<number> {
  const result = await suggestFile(filePath);
  let content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  let applied = 0;

  // Apply in reverse order so line numbers stay valid
  const toApply = result.groups
    .filter(g => g.inferred && g.inferred.confidence !== "partial")
    .reverse();

  for (const group of toApply) {
    const groupLine = lines.findIndex(l => l.trim() === `## ${group.name}`);
    if (groupLine < 0) continue;

    // Insert **method:** after the ## heading line
    lines.splice(groupLine + 1, 0, `**method:** \`${group.inferred!.method}\``);
    applied++;
  }

  if (applied > 0) {
    await writeFile(filePath, lines.join("\n"));
  }

  return applied;
}
