#!/usr/bin/env bun

import { resolve } from "path";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { loadConfig, runFiles, streamFiles } from "./runner.ts";
import { lintFile } from "./linter.ts";
import { suggestFile, applyInferences } from "./suggest.ts";
import { parseFile, parse } from "./parser.ts";
import { extractFacts } from "./ast.ts";
import { detectDrift } from "./drift.ts";
import { runMutations } from "./mutate.ts";
import { getModuleExports } from "./inference.ts";
import { translate } from "./translator/index.ts";
import { BunAdapter } from "./adapters/bun.ts";
import { glob } from "glob";

const [, , command, ...args] = process.argv;

// Color helpers — disabled when NO_COLOR is set or stdout is not a TTY
const _color = !process.env.NO_COLOR && !!process.stdout.isTTY;
const c = {
  bold:   (s: string) => _color ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    (s: string) => _color ? `\x1b[2m${s}\x1b[0m`  : s,
  red:    (s: string) => _color ? `\x1b[31m${s}\x1b[0m` : s,
  green:  (s: string) => _color ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s: string) => _color ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:   (s: string) => _color ? `\x1b[36m${s}\x1b[0m` : s,
  gray:   (s: string) => _color ? `\x1b[90m${s}\x1b[0m` : s,
};

const HELP = `
lldtdd — Low Level Design Test Driver

Commands:
  run [-v] [pattern]        Run assertions, drift check, and mutation testing (default: **/*.lld.md)
  lint [pattern]            Check LLD files for structure and style issues
  suggest [--apply] <file>  Show (or apply) auto-inferred method decorations
  drift <file.lld.md>       Detect structural changes since HEAD that may invalidate claims
  mutate <file.lld.md>      Find claims that don't catch real implementation mutations
  help                      Show this message

Flags:
  -v, --verbose             Show derived test for each assertion (source, call, assertion type)
`.trim();

/** Structured result returned by runAndCheck — no process.exit called. */
export interface RunOutcome {
  passed: number;
  failed: number;
  skipped: number;
  survivingMutations: number;
  hadDrift: boolean;
  exitCode: 0 | 1;
}

/** Runs the pipeline on a pre-built list of {doc, lldFile} pairs. Core of runAndCheck. */
async function runDocs(
  items: Array<{ doc: import("./types.ts").LLDDocument; lldFile: string }>,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean } = {}
): Promise<RunOutcome> {
  const verbose = opts.verbose ?? false;
  const changedFiles = gitChangedFiles(cwd);
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalSurvivedMutations = 0;
  let hadDrift = false;
  const results: import("./types.ts").RunResult[] = [];

  const { synthesize } = await import("./synthesis/index.ts");
  const runAdapter = new BunAdapter();

  for (const { doc, lldFile: file } of items) {
    const translated = await translate(doc);
    const suite = await synthesize(translated);
    const suiteRel = suite.modulePath.replace(cwd + "/", "");
    if (!opts.silent) {
      const header = verbose ? `\n${c.bold(suite.title)}  ${c.dim(suiteRel)}` : `\n${c.bold(suite.title)}`;
      console.log(header);
    }
    const r = await runAdapter.run(suite);
    r.modulePath = suite.modulePath;
    r.groups = translated.groups;
    r.lldFile = file; // may be "" for in-memory docs; mutations skipped when empty
    results.push(r);

    const casesByDesc = new Map<string, import("./types.ts").TestCase>();
    if (verbose && r.groups) {
      for (const g of r.groups) {
        for (const tc of g.cases) {
          casesByDesc.set(tc.description, tc);
          for (const p of tc.perspectives ?? []) casesByDesc.set(p.description, p);
        }
      }
    }

    if (!opts.silent) {
      for (const cr of r.cases) {
        const icon = cr.status === "pass" ? c.green("✓") : cr.status === "fail" ? c.red("✗") : c.dim("○");
        const desc = cr.status === "fail" ? c.bold(cr.description) : cr.status === "skip" ? c.dim(cr.description) : cr.description;
        console.log(`  ${icon} ${desc}`);
        if (verbose) printTestCaseDetail(casesByDesc.get(cr.description), "    ");
        if (!verbose && cr.status === "fail") {
          const tc = casesByDesc.get(cr.description);
          if (tc?.source === "ai" && tc.action.method) {
            const argStr = (tc.action.args ?? []).map(a => JSON.stringify(a)).join(", ");
            console.log(`    ${c.dim("synthesized:")} ${c.dim(tc.action.method)}(${c.dim(argStr)})`);
          }
        }
        if (cr.error) console.log(`    ${c.red(cr.error)}`);
        for (const p of cr.perspectives ?? []) {
          const picon = p.status === "pass" ? c.green("✓") : p.status === "fail" ? c.red("✗") : c.dim("○");
          const pdesc = p.status === "fail" ? c.bold(p.description) : p.status === "skip" ? c.dim(p.description) : p.status === "skip" ? c.dim(p.description) : p.description;
          console.log(`    ${picon} ${pdesc}`);
          if (verbose) printTestCaseDetail(casesByDesc.get(p.description), "      ");
          if (!verbose && p.status === "fail") {
            const ptc = casesByDesc.get(p.description);
            if (ptc?.source === "ai" && ptc.action.method) {
              const argStr = (ptc.action.args ?? []).map(a => JSON.stringify(a)).join(", ");
              console.log(`      ${c.dim("synthesized:")} ${c.dim(ptc.action.method)}(${c.dim(argStr)})`);
            }
          }
          if (p.error) console.log(`      ${c.red(p.error)}`);
        }
      }
      const pendingNote = r.skipped > 0 ? c.dim(`, ${r.skipped} pending`) : "";
      const passedStr = r.passed > 0 ? c.green(`${r.passed} passed`) : `${r.passed} passed`;
      const failedStr = r.failed > 0 ? c.red(`${r.failed} failed`) : `${r.failed} failed`;
      console.log(`  ${passedStr}, ${failedStr}${pendingNote} ${c.dim(`(${r.duration}ms)`)}`);
    }
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalSkipped += r.skipped;

    if (r.groups) {
      const allClaims = r.groups.flatMap(g =>
        g.cases.flatMap(tc => [tc.description, ...(tc.perspectives ?? []).map(p => p.description)])
      );
      const modules = new Set<string>([r.modulePath, ...r.groups.flatMap(g => g.modulePath ? [g.modulePath] : [])]);
      let driftChecked = 0;
      let driftFailed = 0;

      for (const mod of modules) {
        if (!mod || !existsSync(mod)) continue;
        const modRel = mod.replace(cwd + "/", "");
        const isChanged = changedFiles === null || changedFiles.has(mod);

        if (!isChanged) {
          if (verbose && !opts.silent) console.log(`  ${c.green("✓")} ${c.dim("drift")}  ${c.dim(modRel)}`);
          continue;
        }

        driftChecked++;
        const report = await detectDrift(mod, allClaims);
        if (!report) {
          if (verbose && !opts.silent) console.log(`  ${c.green("✓")} ${c.dim("drift")}  ${c.dim(modRel)}  ${c.dim("·  function signatures unchanged vs HEAD")}`);
          continue;
        }

        hadDrift = true;
        driftFailed++;
        if (!opts.silent) {
          console.log(`  ${c.red("✗")} ${c.dim("drift")}  ${c.dim(modRel)}  ${c.dim("·  function signatures changed vs HEAD")}`);
          for (const ch of report.changes) {
            const icon = ch.risk === "high" ? c.red("●") : ch.risk === "medium" ? c.yellow("●") : c.dim("○");
            console.log(`      ${icon}  ${c.dim(ch.type.padEnd(8))} ${ch.name}`);
            for (const d of ch.diffs) console.log(`               ${c.dim(d)}`);
          }
          for (const { change, affectedClaims } of report.impacts) {
            for (const claim of affectedClaims) console.log(`        ${c.dim(`[${change.name}]`)} "${claim}"`);
          }
        }
      }

      if (!opts.silent && !verbose && driftChecked > 0 && driftFailed === 0) {
        console.log(`  ${c.green("✓")} ${c.dim("drift")}`);
      }
    }

    if (r.failed === 0 && r.passed > 0 && r.modulePath && existsSync(r.modulePath) && file) {
      const mutSuite = await translate(doc); // reuse already-parsed doc
      const mutAdapter = new BunAdapter();
      const testRunner = async (mutatedPath: string) =>
        mutAdapter.run({ ...mutSuite, modulePath: mutatedPath });
      const rel = r.modulePath.replace(cwd + "/", "");
      const mutations = await runMutations(r.modulePath, testRunner);
      const survived = mutations.filter(m => m.survived);

      if (!opts.silent) {
        if (verbose) {
          if (mutations.length === 0) {
            console.log(`  ${c.dim("○")} ${c.dim("mutations")}  ${c.dim(rel)}  ${c.dim("no mutable patterns found")}`);
          } else {
            const headerIcon = survived.length === 0 ? c.green("✓") : c.red("✗");
            const count = c.dim(`${mutations.length} probed`);
            const survivedNote = survived.length > 0 ? `  ${c.dim("·")}  ${c.yellow(`${survived.length} survived`)}` : "";
            console.log(`  ${headerIcon} ${c.dim("mutations")}  ${c.dim(rel)}  ${count}${survivedNote}`);
            for (const m of mutations) {
              const fn = m.functionName ? `${m.functionName}()` : "";
              const icon = m.survived ? c.red("✗") : c.green("✓");
              console.log(`      ${icon}  ${c.dim(fn ? fn + "  " : "")}${c.dim(m.description)}`);
            }
          }
        } else if (mutations.length > 0) {
          const icon = survived.length === 0 ? c.green("✓") : c.red("✗");
          const detail = survived.length > 0 ? c.dim(`  ·  ${survived.length} survived`) : "";
          console.log(`  ${icon} ${c.dim("mutations")}${detail}`);
        }

        if (survived.length > 0) {
          totalSurvivedMutations += survived.length;
          for (const m of survived) {
            const fn = m.functionName ? `${m.functionName}()` : "unknown";
            console.log(`      ${c.yellow("△")} ${c.bold(fn)}  ${c.dim(mutationBehavior(m.description))}`);
            const best = m.uncoveredBy.find(cr => cr.endsWith("?")) ?? m.uncoveredBy[0];
            if (best) console.log(`        ${c.dim("→")} add a perspective to: ${c.cyan(`"${best}"`)}`);
            else      console.log(`        ${c.dim("→")} no related claim found — consider adding a group for ${c.cyan(fn)}`);
          }
        }
      } else {
        totalSurvivedMutations += survived.length;
      }
    }
  }

  if (!opts.silent && results.length > 1) {
    const pendingNote = totalSkipped > 0 ? c.dim(`, ${totalSkipped} pending`) : "";
    const passedStr = totalPassed > 0 ? c.green(`${totalPassed} passed`) : `${totalPassed} passed`;
    const failedStr = totalFailed > 0 ? c.red(`${totalFailed} failed`) : `${totalFailed} failed`;
    console.log(`\n${c.bold("Total:")} ${passedStr}, ${failedStr}${pendingNote}`);
  }

  if (!opts.silent && totalSkipped > 0) {
    console.log(`\n${c.yellow("Pending:")}`);
    for (const r of results) {
      for (const cr of r.cases.filter(cr => cr.status === "skip")) {
        console.log(`  ${c.dim("○")} ${c.dim(`[${r.suiteName}]`)} ${cr.description}`);
      }
    }
  }

  if (!opts.silent && totalSurvivedMutations > 0) {
    console.log(`\n${c.yellow(`${totalSurvivedMutations} surviving mutation(s)`)} — add perspectives to strengthen these claims`);
  }

  return {
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    survivingMutations: totalSurvivedMutations,
    hadDrift,
    exitCode: (totalFailed > 0 || totalSurvivedMutations > 0 ? 1 : 0) as 0 | 1,
  };
}

/** File-based entry point: resolves glob/path and calls runDocs. */
export async function runAndCheck(
  pattern: string | undefined,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean } = {}
): Promise<RunOutcome> {
  const { glob: globFn } = await import("glob");
  const isLiteralPath = pattern && !/[*?{}[\]!]/.test(pattern);
  const lldFiles = isLiteralPath
    ? [resolve(cwd, pattern)]
    : await globFn(pattern ?? "**/*.lld.md", { cwd, absolute: true, ignore: ["node_modules/**"] });
  const items = await Promise.all(lldFiles.map(async f => ({ doc: await parseFile(f), lldFile: f })));
  return runDocs(items, cwd, opts);
}

/** Content-based entry point: parses LLD content in-memory, no file required. */
export async function runContentAndCheck(
  content: string,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean } = {}
): Promise<RunOutcome> {
  const doc = parse(content, resolve(cwd, "inline.lld.md"));
  return runDocs([{ doc, lldFile: "" }], cwd, opts);
}

// Canonical scenario functions: document expected outcomes for known fixtures.
// Expression bodies (not blocks) so extractZeroArgScenarios can detect them.
// runPassingExample and runSurvivingMutationsExample use subprocess (circular import
// would block codegen-time extraction; see re-entry guard in ast.ts).
const _CWD = resolve(import.meta.dir, "..");
const _spawnRun = (lldPattern: string) => {
  const r = Bun.spawnSync(["bun", "run", import.meta.filename, "run", lldPattern],
    { cwd: _CWD, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout as Uint8Array);
  return { exitCode: r.exitCode as 0 | 1, hadMutations: out.includes("probed"), hadDrift: out.includes("drift") };
};

// Demonstrates runContentAndCheck with in-memory LLD content — no file required
export const runContentExample = () =>
  runContentAndCheck(
    `# Inline Test\n> examples/cart.ts\n\n## Cart loads\n- addItem("s", "sku-apple") → resolves`,
    _CWD, { silent: true }
  );

export const runPassingExample = () => _spawnRun("examples/auth.lld.md");
// Failing scenario: derived from framework internals — a wrong direct assertion on a known module.
// addItem returns a cart object, not null; the framework generates a failing test without a fixture file.
export const runFailingExample = () =>
  runContentAndCheck(
    `# Derived Failure\n> examples/cart.ts\n\n## Wrong return type\n- addItem("s1", "sku-apple") -> null`,
    _CWD, { silent: true }
  );
export const runSurvivingMutationsExample = () => _spawnRun("examples/cart.lld.md");

async function main() {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);

  switch (command ?? "run") {
    case "run": {
      const verbose = args.includes("--verbose") || args.includes("-v");
      const pattern = args.find(a => !a.startsWith("-"));
      const result = await runAndCheck(pattern, cwd, { verbose });
      process.exit(result.exitCode);
      break;
    }
    // Placeholder — actual run moved to runAndCheck above
    case "lint": {
      const pattern = args[0] ?? "**/*.lld.md";
      const files = await glob(pattern, { cwd, absolute: true, ignore: ["node_modules/**"] });

      if (files.length === 0) {
        console.log("No .lld.md files found.");
        break;
      }

      let totalErrors = 0;
      let totalWarnings = 0;

      for (const file of files) {
        const result = await lintFile(file);
        if (result.issues.length > 0) {
          const rel = file.replace(cwd + "/", "");
          console.log(`\n${rel}`);
          for (const issue of result.issues.sort((a, b) => a.line - b.line)) {
            const level = issue.level === "error" ? "error  " : "warning";
            console.log(`  ${level}  line ${String(issue.line).padStart(3)}  ${issue.message}`);
          }
        }
        totalErrors   += result.errors;
        totalWarnings += result.warnings;
      }

      if (totalErrors + totalWarnings === 0) {
        console.log(`${files.length} file${files.length === 1 ? "" : "s"} clean.`);
      } else {
        console.log(`\n${totalErrors} error${totalErrors !== 1 ? "s" : ""}, ${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""} across ${files.length} file${files.length === 1 ? "" : "s"}`);
      }

      process.exit(totalErrors > 0 ? 1 : 0);
    }

    case "suggest": {
      const apply = args[0] === "--apply";
      const filePath = apply ? args[1] : args[0];

      if (!filePath) {
        console.error("Usage: lldtdd suggest [--apply] <file.lld.md>");
        process.exit(1);
      }

      const absFile = resolve(cwd, filePath);
      const result = await suggestFile(absFile);

      if (!result.moduleExists) {
        console.log(`module not yet implemented: ${result.modulePath}`);
        console.log("(auto-inference requires the module to exist)");
      }

      let autoCount = 0;
      let manualCount = 0;

      for (const group of result.groups) {
        if (group.hasMethod || group.hasSetup) {
          console.log(`  ✓ ## ${group.name} — already annotated`);
        } else if (group.inferred) {
          const tag = group.inferred.confidence === "partial" ? "~" : "+";
          const action = apply && group.inferred.confidence !== "partial"
            ? "(applied)"
            : group.inferred.confidence === "partial" ? "(verify)" : "(auto)";
          console.log(`  ${tag} ## ${group.name} -> **method:** \`${group.inferred.method}\` ${action}`);
          if (group.inferred.confidence !== "partial") autoCount++;
          else manualCount++;
        } else {
          console.log(`  ○ ## ${group.name} — no match found, add **method:** manually`);
          manualCount++;
        }
      }

      if (apply && autoCount > 0) {
        const applied = await applyInferences(absFile);
        console.log(`\n${applied} annotation${applied !== 1 ? "s" : ""} applied to ${filePath}`);
      } else if (!apply && autoCount > 0) {
        console.log(`\n${autoCount} auto-applicable — run with --apply to write them`);
      }
      break;
    }

    case "helpers":
    case "derive":
    case "rhythm": {
      console.error(`The "${command}" command was removed. Helper files are no longer part of the lldtdd workflow — tests are derived directly from the implementation via AST analysis. Run \`lldtdd help\` to see current commands.`);
      process.exit(1);
    }

    case "drift": {
      const filePath = args[0];
      if (!filePath) { console.error("Usage: lldtdd drift <file.lld.md>"); process.exit(1); }

      const absFile = resolve(cwd, filePath);
      const doc = await parseFile(absFile);
      const allClaims = doc.groups.flatMap(g =>
        g.assertions.flatMap(a => [a.raw, ...(a.perspectives ?? []).map(p => p.raw)])
      );

      const modules = new Set<string>();
      if (doc.module) modules.add(doc.module);
      for (const g of doc.groups) if (g.moduleOverride) modules.add(g.moduleOverride);

      let anyDrift = false;
      for (const mod of modules) {
        const report = await detectDrift(mod, allClaims);
        if (!report) continue;
        anyDrift = true;
        const rel = mod.replace(cwd + "/", "");
        console.log(`\nDrift: ${rel}\n`);
        for (const c of report.changes) {
          const icon = c.risk === "high" ? "🔴" : c.risk === "medium" ? "🟡" : "○";
          console.log(`  ${icon} ${c.type.padEnd(8)} ${c.name}`);
          for (const d of c.diffs) console.log(`           ${d}`);
        }
        if (report.impacts.length > 0) {
          console.log("\n  Potentially affected claims:");
          for (const { change, affectedClaims } of report.impacts) {
            for (const claim of affectedClaims) {
              console.log(`    [${change.name}] "${claim}"`);
            }
          }
        }
      }
      if (!anyDrift) console.log("No structural drift detected since HEAD.");
      break;
    }

    case "mutate": {
      const filePath = args[0];
      if (!filePath) { console.error("Usage: lldtdd mutate <file.lld.md>"); process.exit(1); }

      const absFile = resolve(cwd, filePath);
      const doc = await parseFile(absFile);
      if (!doc.module) { console.log("No module pointer found."); break; }

      // Find the implementation module (one level deeper from the helper if possible)
      // The helper imports from the implementation — for now mutate the helper directly
      const modulePath = doc.module;
      console.log(`\nMutation test: ${modulePath.replace(cwd + "/", "")}\n`);

      // Generate and run lldtdd tests via the adapter
      const suite = await translate(doc);
      const adapter = new BunAdapter();

      const testRunner = async (mutatedPath: string) =>
        adapter.run({ ...suite, modulePath: mutatedPath });

      const results = await runMutations(modulePath, testRunner);

      let survived = 0;
      for (const r of results) {
        const icon = r.survived ? "🔴 SURVIVED" : "✓  killed  ";
        console.log(`  ${icon}  ${r.description}`);
        if (r.survived) {
          survived++;
          for (const claim of r.uncoveredBy) console.log(`      ○ ${claim}`);
        }
      }

      console.log(`\n${results.length} mutations — ${results.length - survived} killed, ${survived} survived`);

      // Complexity coverage advisory: flag high-complexity functions with limited mutation probes
      const facts = await extractFacts(modulePath);
      const highComplexity = (facts?.complexity ?? []).filter(f => f.mutationRisk !== "low");
      if (highComplexity.length > 0) {
        console.log(`\nComplexity advisory:`);
        for (const f of highComplexity) {
          console.log(`  ${f.mutationRisk === "high" ? "🔴" : "🟡"} ${f.name}: complexity ${f.complexity} — consider adding targeted perspectives`);
        }
      }

      if (survived > 0) {
        console.log(`\n⚠  ${survived} mutation(s) not caught — add perspectives to strengthen these claims`);
        process.exit(1);
      } else {
        console.log("✓ All mutations caught by LLD assertions");
      }
      break;
    }

    default:
      console.log(HELP);
  }
}

function gitChangedFiles(cwd: string): Set<string> | null {
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const out = execSync("git diff --name-only HEAD 2>/dev/null", { encoding: "utf-8", cwd }).trim();
    if (!out) return new Set(); // git works but nothing changed
    return new Set(out.split("\n").map(f => resolve(cwd, f)));
  } catch {
    return null; // not a git repo or git unavailable — run drift on everything
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printTestCaseDetail(tc: import("./types.ts").TestCase | undefined, indent: string): void {
  if (!tc) return;

  // Source tag — color by origin
  const rawTag = tc.source === "needs-fixture" ? "[pending]"
    : tc.source === "deterministic"             ? "[grammar]"
    : tc.source === "ast-derived"               ? "[ast]"
    : tc.source === "ai"                        ? "[ai]"
    : `[${tc.source}]`;
  const sourceTag = c.gray(rawTag);

  // Action expression
  let action = "";
  if (tc.action.method) {
    const argStr = (tc.action.args ?? []).map(a =>
      typeof a === "object" && a !== null && "__expr" in a
        ? (a as { __expr: string }).__expr
        : JSON.stringify(a)
    ).join(", ");
    action = `${c.cyan(tc.action.method)}(${c.dim(argStr)})`;
    if (tc.action.captures) action += ` ${c.dim("→")} ${tc.action.captures}`;
    if (tc.action.extraCall) {
      const ecArgs = (tc.action.extraCall.args ?? []).map(a =>
        typeof a === "object" && a !== null && "__expr" in a
          ? (a as { __expr: string }).__expr
          : JSON.stringify(a)
      ).join(", ");
      action += `  ${c.dim("then")}  ${c.cyan(tc.action.extraCall.method)}(${c.dim(ecArgs)}) ${c.dim("→")} ${tc.action.extraCall.captures}`;
    }
  } else if (tc.assertion.type === "inspect" && tc.assertion.code) {
    const raw = tc.assertion.code.split("\n").find(l => l.trim())?.trim() ?? "";
    action = c.dim(raw);
  } else if (tc.action.argDescription) {
    action = c.dim(`(${tc.action.argDescription})`);
  }

  // Assertion summary — color by type
  const assertionColor: Record<string, (s: string) => string> = {
    resolves:        c.green,
    throws:          c.red,
    equals:          c.green,
    "schema-drop":   c.cyan,
    "fault-resilience": c.yellow,
    inspect:         c.cyan,
    called:          c.gray,
    calledWith:      c.gray,
    notCalled:       c.gray,
  };
  const colorFn = assertionColor[tc.assertion.type] ?? ((s: string) => s);
  let assertion = colorFn(tc.assertion.type);
  if (tc.assertion.type === "equals")
    assertion += c.dim(`: ${JSON.stringify(tc.assertion.expected)}`);
  if (tc.assertion.type === "inspect" && tc.assertion.code) {
    const firstLine = tc.assertion.code.split("\n").find(l => l.trim())?.trim() ?? "";
    assertion += c.dim(`: ${firstLine}`);
  }
  if (tc.assertion.type === "schema-drop" && tc.assertion.knownFields?.length)
    assertion += c.dim(`: [${tc.assertion.knownFields.join(", ")}]`);
  if (tc.assertion.type === "fault-resilience" && tc.assertion.faultTarget)
    assertion += c.dim(`: ${tc.assertion.faultTarget}`);

  console.log(`${indent}${sourceTag}  ${action}  ${c.dim("→")}  ${assertion}`);
}

function mutationBehavior(description: string): string {
  if (/return value.*null/i.test(description)) return "return value is never asserted";
  if (/=== → !==/i.test(description))           return "equality result is never asserted";
  if (/throw guard negated/i.test(description))  return "error condition is never asserted";
  if (/guard removed/i.test(description))        return "null/undefined guard is never asserted";
  if (/return true.*false/i.test(description))   return "boolean return value is never asserted";
  if (/return false.*true/i.test(description))   return "boolean return value is never asserted";
  return description;
}

// Only run as a process entry point — not when imported as a module.
// This guard makes the module safe to import for testing runAndCheck etc.
if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
