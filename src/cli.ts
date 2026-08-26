#!/usr/bin/env bun

// Argument parsing and command dispatch. The `run` pipeline itself lives in run.ts so that
// pipeline.ts can import it without importing a program -- see the header there.

import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { lintFile } from "./linter.ts";
import { suggestFile, applyInferences } from "./suggest.ts";
import { parseFile } from "./parser.ts";
import { extractFacts } from "./ast/index.ts";
import { detectDrift, hasDriftBaseline } from "./drift.ts";
import { runMutations, summarizeMutations } from "./mutate.ts";
import { translate } from "./translator/index.ts";
import { runSuite } from "./bunRunner.ts";
import { runAndCheck, DEFAULT_GLOB_IGNORE } from "./run.ts";
import { glob } from "glob";

const [, , command, ...args] = process.argv;
export const HELP = `
lldtdd -- runnable Low Level Design docs: design documents whose claims execute as tests

Commands:
  run [-v] [--no-mutate] [--fail-on-pending] [--fail-on-weak] [pattern]
                            Run assertions, drift check, and mutation testing (default: **/*.lld.md)
  lint [--execute] [pattern]
                            Check LLD files for structure and style issues
  suggest [--apply] [--execute] <file>
                            Show (or apply) auto-inferred method decorations
  drift <file.lld.md>       Detect structural changes since HEAD that may invalidate claims
  mutate <file.lld.md>      Find claims that don't catch real implementation mutations
  help                      Show this message

Flags:
  -v, --verbose             Show derived test for each assertion (source, call, assertion type)
  --no-mutate               Skip mutation testing (run: assertions + drift only, faster)
  --fail-on-pending         run only: exit non-zero if any claim is pending, not just on failure.
                            For a mature corpus that has reached 0 pending and wants to stay there.
  --fail-on-weak            run only: exit non-zero if any claim passes on no-throw only (◐) --
                            green that checked nothing the code returned or did. Ratchets strength.
  --execute                 lint/suggest only: load the module under test for sharper
                            inference. This runs its top-level code and calls its zero-arg
                            exports in this process. Without it, both commands only read source.

Which commands run your code:
  run and mutate execute the module under test -- that is what they are for.
  lint, suggest, and drift only read it, unless you pass --execute.

Exit codes:
  run exits non-zero only when a verified claim fails. Drift and surviving
  mutations are reported but advisory. An unrecognized command exits 1.
`.trim();

/** Prints one line and exits non-zero. For user mistakes -- a bad path, a missing argument -- where
 *  a stack trace names the reader's internals instead of what the user typed. */
function fail(message: string): never {
  console.error(`lldtdd: ${message}`);
  process.exit(1);
}

/** Resolves a document path the user named, failing cleanly if it isn't there. */
function resolveDocArg(filePath: string | undefined, usage: string): string {
  if (!filePath) fail(`usage: ${usage}`);
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) fail(`no such document: ${filePath}`);
  if (statSync(abs).isDirectory()) fail(`expected a document, got a directory: ${filePath}`);
  return abs;
}

/** A bare directory named where a document or glob was expected means "everything under it".
 *  Without the expansion the glob matches the directory itself and the reader dies of EISDIR,
 *  which names this tool's file handling instead of what the user meant -- and what they meant
 *  is unambiguous. */
function expandDirPattern(pattern: string, cwd: string): string {
  const abs = resolve(cwd, pattern);
  return existsSync(abs) && statSync(abs).isDirectory()
    ? `${pattern.replace(/\/+$/, "")}/**/*.lld.md`
    : pattern;
}

/** Runs this CLI as a subprocess and reports what the calling shell would see.
 *
 *  This is the anchor that lets `lld/cli.lld.md` make checkable claims about the command surface
 *  itself. Exit codes and dispatch are properties of the spawned program, not of any function a
 *  claim could call in-process -- the same reasoning as `runDocument` in run.ts, one level up. */
export function invokeCli(...argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", new URL(import.meta.url).pathname, ...argv], {
    cwd: process.cwd(),
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Fails on any -flag the current command doesn't define. Every flag here is boolean, so an
 *  unrecognized one is a typo -- and silently ignoring it does the opposite of what was asked:
 *  `--no-mutat` runs the mutation pass the user meant to skip, `--verbos` stays quiet. The command
 *  that rejects an unknown *command* has to reject an unknown flag too, or the care is half-applied. */
function rejectUnknownFlags(allowed: string[]): void {
  const unknown = args.filter(a => a.startsWith("-") && !allowed.includes(a));
  if (unknown.length > 0) fail(`unknown flag: ${unknown.join(", ")}  (run \`lldtdd help\`)`);
}

async function main() {
  const cwd = process.cwd();

  switch (command ?? "run") {
    case "run": {
      rejectUnknownFlags(["-v", "--verbose", "--no-mutate", "--fail-on-pending", "--fail-on-weak"]);
      const verbose = args.includes("--verbose") || args.includes("-v");
      const mutate = !args.includes("--no-mutate");
      const failOnPending = args.includes("--fail-on-pending");
      const failOnWeak = args.includes("--fail-on-weak");
      const named = args.find(a => !a.startsWith("-"));
      // A named-but-absent path is a typo, not a crash: report it the way the other commands do
      // rather than letting it reach the generic handler and pick up a debug-trace hint.
      if (named && !/[*?{}[\]!]/.test(named) && !existsSync(resolve(cwd, named))) {
        fail(`no such document: ${named}`);
      }
      const pattern = named ? expandDirPattern(named, cwd) : undefined;
      const result = await runAndCheck(pattern, cwd, { verbose, mutate, failOnPending, failOnWeak });
      process.exit(result.exitCode);
      break;
    }

    case "lint": {
      rejectUnknownFlags(["--execute"]);
      const execute = args.includes("--execute");
      const named = args.find(a => !a.startsWith("-"));
      // Same reasoning as `run` above: a named path that isn't there is a typo, and "no files
      // found" plus exit 0 is what a clean sweep also looks like.
      if (named && !/[*?{}[\]!]/.test(named) && !existsSync(resolve(cwd, named))) {
        fail(`no such document: ${named}`);
      }
      const pattern = named ? expandDirPattern(named, cwd) : "**/*.lld.md";
      // A literal file path skips the glob so the sweep's exclusions cannot veto it: naming
      // `lld/fixtures/x.lld.md` explicitly must lint that file, the same contract `run` keeps.
      const isLiteralFile = !/[*?{}[\]!]/.test(pattern) && existsSync(resolve(cwd, pattern));
      const files = isLiteralFile
        ? [resolve(cwd, pattern)]
        : await glob(pattern, { cwd, absolute: true, ignore: DEFAULT_GLOB_IGNORE });

      if (files.length === 0) {
        console.log("No .lld.md files found.");
        break;
      }

      let totalErrors = 0;
      let totalWarnings = 0;

      for (const file of files) {
        const result = await lintFile(file, { execute });
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
      // Flags are read positionally nowhere else, and a user who writes them in their habitual
      // trailing position should not silently get a dry run.
      rejectUnknownFlags(["--apply", "--execute"]);
      const apply = args.includes("--apply");
      const execute = args.includes("--execute");
      const filePath = args.find(a => !a.startsWith("-"));
      const absFile = resolveDocArg(filePath, "lldtdd suggest [--apply] [--execute] <file.lld.md>");
      const result = await suggestFile(absFile, { execute });

      if (!result.moduleExists) {
        console.log(`module not yet implemented: ${result.modulePath}`);
        console.log("(auto-inference requires the module to exist)");
      }

      let autoCount = 0;
      let manualCount = 0;

      for (const group of result.groups) {
        if (group.hasMethod || group.hasSetup) {
          console.log(`  ✓ ## ${group.name} -- already annotated`);
        } else if (group.inferred) {
          const tag = group.inferred.confidence === "partial" ? "~" : "+";
          const action = apply && group.inferred.confidence !== "partial"
            ? "(applied)"
            : group.inferred.confidence === "partial" ? "(verify)" : "(auto)";
          console.log(`  ${tag} ## ${group.name} -> **method:** \`${group.inferred.method}\` ${action}`);
          if (group.inferred.confidence !== "partial") autoCount++;
          else manualCount++;
        } else {
          console.log(`  ○ ## ${group.name} -- no match found, add **method:** manually`);
          manualCount++;
        }
      }

      if (apply && autoCount > 0) {
        const applied = await applyInferences(absFile, { execute });
        console.log(`\n${applied} annotation${applied !== 1 ? "s" : ""} applied to ${filePath}`);
      } else if (!apply && autoCount > 0) {
        console.log(`\n${autoCount} auto-applicable; run with --apply to write them`);
      }
      break;
    }

    case "drift": {
      rejectUnknownFlags([]);
      const absFile = resolveDocArg(args.find(a => !a.startsWith("-")), "lldtdd drift <file.lld.md>");
      const doc = await parseFile(absFile);
      const allClaims = doc.groups.flatMap(g =>
        g.assertions.flatMap(a => [a.raw, ...(a.perspectives ?? []).map(p => p.raw)])
      );

      const modules = new Set<string>();
      if (doc.module) modules.add(doc.module);
      for (const g of doc.groups) if (g.moduleOverride) modules.add(g.moduleOverride);

      let anyDrift = false;
      let anyChecked = false;
      for (const mod of modules) {
        // "no baseline" is not "no drift". A module never committed at HEAD, or one outside any git
        // repo, has nothing to compare against -- printing the green "no structural drift" badge for
        // it is exactly the pending-claim-wearing-a-green this tool exists to refuse. run.ts's inline
        // pass already makes this distinction (hasDriftBaseline); the standalone subcommand must too.
        if (!hasDriftBaseline(mod)) {
          console.log(`No baseline for ${mod.replace(cwd + "/", "")} -- it is not committed at HEAD (or lies outside any git repo), so drift could not be checked.`);
          continue;
        }
        anyChecked = true;
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
      if (anyChecked && !anyDrift) console.log("No structural drift detected since HEAD.");
      break;
    }

    case "mutate": {
      rejectUnknownFlags([]);
      const absFile = resolveDocArg(args.find(a => !a.startsWith("-")), "lldtdd mutate <file.lld.md>");
      const doc = await parseFile(absFile);
      if (!doc.module) { console.log("No module pointer found."); break; }

      const modulePath = doc.module;
      console.log(`\nMutation test: ${modulePath.replace(cwd + "/", "")}\n`);

      // Generate and run lldtdd tests -- synthesize so this matches what `lldtdd run`
      // actually verifies (its mutation gate synthesizes too).
      const { synthesize } = await import("./synthesis/index.ts");
      const suite = await synthesize(await translate(doc, { execute: true }));

      const testRunner = async (mutatedPath: string) =>
        runSuite({ ...suite, modulePath: mutatedPath, substitutedFor: suite.modulePath });

      // Mutation testing measures the claims, so there have to be claims that run. Against an
      // all-pending document every mutant trivially "survives" -- not because the claims are weak
      // but because there are none, and reporting that as a mutation score would be noise
      // dressed up as a finding. `run` gates its inline mutation pass the same way.
      const baseline = await runSuite(suite);
      // Order matters: a document with a failing claim also has zero passing ones, and telling
      // its author there is "nothing to mutate against" would point them at the wrong problem.
      if (baseline.failed > 0) {
        console.log(`${baseline.failed} claim(s) already fail against the unmutated implementation.\nMutation results would be meaningless until those pass; fix them first.`);
        process.exit(1);
      }
      if (baseline.passed + baseline.shallow === 0) {
        console.log(baseline.pending > 0
          ? `Nothing to mutate against: all ${baseline.pending} claim(s) in this document are pending.\nAnchor them with a **method:** or **setup:** annotation, or an inline call, and run again.`
          : `Nothing to mutate against: this document produced no runnable claims.`);
        break;
      }

      const results = await runMutations(modulePath, testRunner);

      for (const r of results) {
        const icon = r.outcome === "survived" ? "🔴 SURVIVED"
          : r.outcome === "errored" ? "⚠  no-load  "
          : "✓  killed  ";
        console.log(`  ${icon}  ${r.description}`);
        if (r.outcome === "survived") {
          for (const claim of r.uncoveredBy) console.log(`      ○ ${claim}`);
        }
      }

      const { survived, errored, killed, total } = summarizeMutations(results);
      const erroredNote = errored.length > 0 ? `, ${errored.length} could not run` : "";
      console.log(`\n${total} mutations: ${killed} killed, ${survived.length} survived${erroredNote}`);

      if (errored.length > 0) {
        console.log(`\n⚠  ${errored.length} mutant(s) never loaded, so they tell you nothing about claim strength.`);
        console.log(`   This usually means the module cannot be imported in isolation; check for a`);
        console.log(`   side-effecting import or a path that only resolves from a particular cwd.`);
      }

      // Complexity coverage advisory: flag high-complexity functions with limited mutation probes
      const facts = await extractFacts(modulePath);
      const highComplexity = (facts?.complexity ?? []).filter(f => f.mutationRisk !== "low");
      if (highComplexity.length > 0) {
        console.log(`\nComplexity advisory:`);
        for (const f of highComplexity) {
          console.log(`  ${f.mutationRisk === "high" ? "🔴" : "🟡"} ${f.name}: complexity ${f.complexity}; consider adding targeted perspectives`);
        }
      }

      if (survived.length > 0) {
        console.log(`\n⚠  ${survived.length} mutation(s) not caught; add perspectives to strengthen these claims`);
        process.exit(1);
      } else {
        console.log("✓ All mutations caught by LLD assertions");
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    // A mistyped command that prints help and exits 0 passes a CI step that meant to run
    // something. Asking for help is a success; failing to name a command is not.
    default:
      console.error(`lldtdd: unknown command: ${command}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(err => {
    // A stack trace names this tool's internals, which is the wrong thing to show someone who
    // mistyped a path. The stack is still one env var away for an actual bug.
    if (process.env.LLDTDD_DEBUG) console.error(err);
    else console.error(`lldtdd: ${err instanceof Error ? err.message : String(err)}\n  (set LLDTDD_DEBUG=1 for the stack trace)`);
    process.exit(1);
  });
}
