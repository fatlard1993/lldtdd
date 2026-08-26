// The full `run` pipeline: parse → translate → synthesize → execute, plus the drift and mutation
// passes that follow it, plus the terminal reporting for all of the above.
//
// This lives beside cli.ts rather than inside it because pipeline.ts -- the package's library
// entry point -- needs these entry points, and cli.ts is a program: it destructures process.argv
// at module scope and exists to be executed. A library import should not have to reach through
// a program to find the pipeline. cli.ts is now purely argv parsing and command dispatch.
//
// Reporting is controlled by `opts.silent`. Library callers pass it and get a RunOutcome with no
// output; the CLI leaves it off and gets the human-readable run.
//
// Three files in this directory have run-ish names and none of them do each other's job:
//   run.ts        this file -- orchestrates the stages and reports the result
//   bunRunner.ts  generates a bun:test file for one suite and executes it in a subprocess
//   runtime.ts    helpers that generated test files import at *their* runtime, not ours

import { resolve } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { parse, parseFile } from "./parser.ts";
import { detectDrift, hasDriftBaseline } from "./drift.ts";
import { runMutations, summarizeMutations } from "./mutate.ts";
import { translate } from "./translator/index.ts";
import { findBrowser } from "./browser.ts";
import { runSuite } from "./bunRunner.ts";
import type { CaseStatus, CaseResult, LLDDocument, RunResult, TestCase } from "./types.ts";

// Color helpers -- disabled when NO_COLOR is set or stdout is not a TTY
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

/** Glyph and emphasis for a claim's outcome. Cases and perspectives render identically, and
 *  keeping one definition is what stops the two from drifting apart as states are added. */
function statusGlyph(status: CaseStatus): string {
  if (status === "pass")     return c.green("✓");
  if (status === "indirect") return c.cyan("⊙");
  if (status === "shallow")  return c.yellow("◐");
  if (status === "fail")     return c.red("✗");
  return c.dim("○");
}

function statusText(status: CaseStatus, description: string): string {
  if (status === "fail") return c.bold(description);
  if (status === "pending") return c.dim(description);
  return description;
}

/** Prints a captured failure block (bun's expected/received), each line indented, so a red claim
 *  says what actually happened instead of only that it failed. */
function printError(error: string, indent: string): void {
  for (const line of error.split("\n")) console.log(`${indent}${c.red(line)}`);
}

/** Structured result returned by runAndCheck -- no process.exit called. */
export interface RunOutcome {
  passed: number;
  failed: number;
  pending: number;
  /** Claims whose only evidence is their perspectives -- a success, counted apart from `passed`. */
  indirect: number;
  /** Passing claims whose only assertion is no-throw (`-> resolves`) -- green, but verifying nothing
   *  but "it ran". Counted apart from `passed` so a weak green is visible. */
  shallow: number;
  survivingMutations: number;
  /** Mutants that never loaded, so nothing was learned from them. Reported separately from
   *  survivors because they are a different fact: a survivor means the claims are weak, an
   *  errored mutant means the probe itself did not happen. */
  erroredMutations: number;
  hadDrift: boolean;
  exitCode: 0 | 1;
}

/** Runs the pipeline on a pre-built list of {doc, lldFile} pairs. Core of runAndCheck. */
async function runDocs(
  items: Array<{ doc: LLDDocument; lldFile: string }>,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean; mutate?: boolean; failOnPending?: boolean; failOnWeak?: boolean } = {}
): Promise<RunOutcome> {
  const verbose = opts.verbose ?? false;
  const changedFiles = gitChangedFiles(cwd);
  let totalPassed = 0;
  let totalFailed = 0;
  let totalPending = 0;
  let totalIndirect = 0;
  let totalShallow = 0;
  let totalSurvivedMutations = 0;
  let totalErroredMutations = 0;
  let browserGatedPending = 0;
  let hadDrift = false;
  // Modules whose fact extraction degraded (see DegradedExtraction), by relative path → stages.
  // Kept across the loop so the pending list below can name them once each.
  const degradedModules = new Map<string, Set<string>>();
  const results: RunResult[] = [];

  const { synthesize } = await import("./synthesis/index.ts");

  for (const { doc, lldFile: file } of items) {
    const translated = await translate(doc, { execute: true });
    const suite = await synthesize(translated);
    const suiteRel = suite.modulePath.replace(cwd + "/", "");
    if (!opts.silent) {
      const header = verbose ? `\n${c.bold(suite.title)}  ${c.dim(suiteRel)}` : `\n${c.bold(suite.title)}`;
      console.log(header);
    }
    // Pendings the machine may own, like the missing browser below: a stage ts-morph gave up on
    // fell back to empty facts, so a claim that would have derived stays pending instead.
    for (const d of translated.moduleAstFacts?.degraded ?? []) {
      const modRel = suite.modulePath.replace(cwd + "/", "");
      const stages = degradedModules.get(modRel) ?? new Set();
      stages.add(d.stage);
      degradedModules.set(modRel, stages);
    }

    const r = await runSuite(suite);
    r.modulePath = suite.modulePath;
    r.groups = translated.groups;
    r.lldFile = file; // may be "" for in-memory docs; mutations skipped when empty
    results.push(r);

    const casesByDesc = new Map<string, TestCase>();
    if (verbose && r.groups) {
      for (const g of r.groups) {
        for (const tc of g.cases) {
          casesByDesc.set(tc.description, tc);
          for (const p of tc.perspectives ?? []) casesByDesc.set(p.description, p);
        }
      }
    }

    if (!opts.silent) {
      // When the module never loaded, every claim below reads as ✗ for one reason. Name it once,
      // up top, so the wall of failures isn't mistaken for a wall of broken assertions.
      if (r.crashed) {
        const reason = r.error ? `: ${r.error}` : "";
        console.log(`  ${c.red("module did not load -- no claim was verified")}${c.dim(reason)}`);
      }
      for (const cr of r.cases) {
        console.log(`  ${statusGlyph(cr.status)} ${statusText(cr.status, cr.description)}`);
        if (verbose) printTestCaseDetail(casesByDesc.get(cr.description), "    ");
        if (cr.error) printError(cr.error, "    ");
        for (const p of cr.perspectives ?? []) {
          console.log(`    ${statusGlyph(p.status)} ${statusText(p.status, p.description)}`);
          if (verbose) printTestCaseDetail(casesByDesc.get(p.description), "      ");
          if (p.error) printError(p.error, "      ");
        }
      }
      // A document whose module pointer resolves to nothing reports exactly like one written
      // before its implementation -- every claim pending, exit 0. Both are legitimate states and
      // the run cannot tell the author which one they are in, so it names the file it looked for.
      // A typo'd pointer is otherwise invisible until someone wonders why nothing ever turns green.
      if (r.modulePath && !existsSync(r.modulePath)) {
        console.log(`  ${c.dim(`module not found: ${r.modulePath.replace(cwd + "/", "")}`)}`);
      }
      const indirectNote = r.indirect > 0 ? c.cyan(`, ${r.indirect} via perspectives`) : "";
      const shallowNote = r.shallow > 0 ? c.yellow(`, ${r.shallow} no-throw only`) : "";
      const pendingNote = r.pending > 0 ? c.dim(`, ${r.pending} pending`) : "";
      const passedStr = r.passed > 0 ? c.green(`${r.passed} passed`) : `${r.passed} passed`;
      const failedStr = r.failed > 0 ? c.red(`${r.failed} failed`) : `${r.failed} failed`;
      console.log(`  ${passedStr}, ${failedStr}${indirectNote}${shallowNote}${pendingNote} ${c.dim(`(${r.duration}ms)`)}`);
      // Zero claims + zero pending is "0 passed, 0 failed" -- indistinguishable from a clean pass,
      // but it usually means the document didn't parse as one (wrong bullet, no groups, empty file).
      // `run` can't diagnose structure; `lint` can, so point there rather than exit green in silence.
      if (r.cases.length === 0 && r.pending === 0) {
        const rel = file ? ` ${file.replace(cwd + "/", "")}` : "";
        console.log(`  ${c.yellow("no claims found")} ${c.dim(`-- run \`lldtdd lint${rel}\` to check the document's structure`)}`);
      }
    }
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalPending += r.pending;
    totalIndirect += r.indirect;
    totalShallow += r.shallow;

    // Pendings caused by the machine, not the document: a group marked **browser:** true stays
    // pending when no browser is found (see browser.ts). Counted here, named once in the pending
    // list below, so "N pending" does not read as unwritten claims when the cause is a missing
    // Chrome. Translated groups are positional with doc.groups, so the doc's flag maps directly.
    if (r.pending > 0 && r.groups && !(await findBrowser())) {
      r.groups.forEach((g, i) => {
        if (doc.groups[i]?.browser !== true) return;
        const descs = new Set(g.cases.map(tc => tc.description));
        browserGatedPending += r.cases.filter(cr => cr.status === "pending" && descs.has(cr.description)).length;
      });
    }

    if (r.groups) {
      const allClaims = r.groups.flatMap(g =>
        g.cases.flatMap(tc => [tc.description, ...(tc.perspectives ?? []).map(p => p.description)])
      );
      const modules = new Set<string>([r.modulePath, ...r.groups.flatMap(g => g.modulePath ? [g.modulePath] : [])]);
      let driftChecked = 0;
      let driftCompared = 0; // modules that actually had a HEAD baseline to compare against
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
          // A null report is two different facts: "compared, nothing drifted" and "no baseline to
          // compare against". Only the first is a green check; the second is a check that never ran,
          // and "unchanged vs HEAD" would be a badge for a comparison that didn't happen.
          const baseline = hasDriftBaseline(mod);
          if (baseline) driftCompared++;
          if (verbose && !opts.silent) {
            console.log(baseline
              ? `  ${c.green("✓")} ${c.dim("drift")}  ${c.dim(modRel)}  ${c.dim("·  function signatures unchanged vs HEAD")}`
              : `  ${c.dim("-")} ${c.dim("drift")}  ${c.dim(modRel)}  ${c.dim("·  no baseline vs HEAD")}`);
          }
          continue;
        }

        hadDrift = true;
        driftFailed++;
        driftCompared++;
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

      if (!opts.silent && !verbose && driftFailed === 0) {
        if (driftCompared > 0) console.log(`  ${c.green("✓")} ${c.dim("drift")}`);
        else if (driftChecked > 0) console.log(`  ${c.dim("-")} ${c.dim("drift")}  ${c.dim("·  no baseline")}`);
      }
    }

    // `--no-mutate` overrides everything; `**mutate:** false` is the document's own opt-out.
    const mutationWanted = opts.mutate !== false && doc.mutate !== false;
    // Shallow greens count as runnable tests here: they pass, so there is something to mutate
    // against, and mutation is exactly what exposes that they catch nothing.
    if (mutationWanted && r.failed === 0 && (r.passed + r.shallow) > 0 && r.modulePath && existsSync(r.modulePath) && file) {
      const mutSuite = await translate(doc, { execute: true }); // reuse already-parsed doc
      const testRunner = async (mutatedPath: string) =>
        runSuite({ ...mutSuite, modulePath: mutatedPath, substitutedFor: mutSuite.modulePath });
      const rel = r.modulePath.replace(cwd + "/", "");
      const mutations = await runMutations(r.modulePath, testRunner);
      const { survived, errored, clean } = summarizeMutations(mutations);

      totalSurvivedMutations += survived.length;
      totalErroredMutations  += errored.length;

      if (!opts.silent) {
        const notes = [
          survived.length > 0 ? c.yellow(`${survived.length} survived`) : null,
          errored.length  > 0 ? c.yellow(`${errored.length} could not run`) : null,
        ].filter(Boolean).join(c.dim(", "));

        if (verbose) {
          if (mutations.length === 0) {
            console.log(`  ${c.dim("○")} ${c.dim("mutations")}  ${c.dim(rel)}  ${c.dim("no mutable patterns found")}`);
          } else {
            const headerIcon = clean ? c.green("✓") : c.red("✗");
            const count = c.dim(`${mutations.length} probed`);
            const detail = notes ? `  ${c.dim("·")}  ${notes}` : "";
            console.log(`  ${headerIcon} ${c.dim("mutations")}  ${c.dim(rel)}  ${count}${detail}`);
            for (const m of mutations) {
              const fn = m.functionName ? `${m.functionName}()` : "";
              const icon = m.outcome === "survived" ? c.red("✗")
                : m.outcome === "errored" ? c.yellow("!")
                : c.green("✓");
              console.log(`      ${icon}  ${c.dim(fn ? fn + "  " : "")}${c.dim(m.description)}`);
            }
          }
        } else if (mutations.length > 0) {
          const icon = clean ? c.green("✓") : c.red("✗");
          console.log(`  ${icon} ${c.dim("mutations")}${notes ? c.dim("  ·  ") + notes : ""}`);
        }

        for (const m of survived) {
          const fn = m.functionName ? `${m.functionName}()` : "unknown";
          console.log(`      ${c.yellow("△")} ${c.bold(fn)}  ${c.dim(mutationBehavior(m.description))}`);
          const best = m.uncoveredBy.find(cr => cr.endsWith("?")) ?? m.uncoveredBy[0];
          if (best) console.log(`        ${c.dim("→")} add a perspective to: ${c.cyan(`"${best}"`)}`);
          else      console.log(`        ${c.dim("→")} no related claim found -- consider adding a group for ${c.cyan(fn)}`);
        }

        if (errored.length > 0) {
          console.log(`      ${c.yellow("!")} ${c.bold(`${errored.length} mutant${errored.length === 1 ? "" : "s"} failed to load`)}  ${c.dim("(not counted as caught)")}`);
          console.log(`        ${c.dim("→")} run ${c.cyan(`lldtdd mutate ${rel.replace(/\.[jt]sx?$/, "")}.lld.md`)} to see why`);
        }
      }
    }
  }

  if (!opts.silent && results.length > 1) {
    const indirectNote = totalIndirect > 0 ? c.cyan(`, ${totalIndirect} via perspectives`) : "";
    const shallowNote = totalShallow > 0 ? c.yellow(`, ${totalShallow} no-throw only`) : "";
    const pendingNote = totalPending > 0 ? c.dim(`, ${totalPending} pending`) : "";
    const passedStr = totalPassed > 0 ? c.green(`${totalPassed} passed`) : `${totalPassed} passed`;
    const failedStr = totalFailed > 0 ? c.red(`${totalFailed} failed`) : `${totalFailed} failed`;
    console.log(`\n${c.bold("Total:")} ${passedStr}, ${failedStr}${indirectNote}${shallowNote}${pendingNote}`);
    if (totalIndirect > 0) {
      console.log(c.dim(`  ${c.cyan("⊙")} = the claim itself had no test; its perspectives carry the evidence`));
    }
    if (totalShallow > 0) {
      console.log(c.dim(`  ${c.yellow("◐")} = passes on no-throw only; the call ran but nothing it returned or did was checked`));
    }
  }

  // Shallow greens are listed by name for the same reason pending is: they are the claims most
  // likely to be mistaken for verified when they are not. A reader scanning "0 failed" needs to
  // see which greens only proved the code didn't crash.
  if (!opts.silent && totalShallow > 0) {
    console.log(`\n${c.yellow("No-throw only")} ${c.dim("(passes but checks nothing returned -- add a perspective that asserts the behavior):")}`);
    const listShallow = (crs: CaseResult[], suiteName: string) => {
      for (const cr of crs) {
        if (cr.status === "shallow") console.log(`  ${c.yellow("◐")} ${c.dim(`[${suiteName}]`)} ${cr.description}`);
        if (cr.perspectives?.length) listShallow(cr.perspectives, suiteName);
      }
    };
    for (const r of results) listShallow(r.cases, r.suiteName);
  }

  if (!opts.silent && totalPending > 0) {
    console.log(`\n${c.yellow("Pending:")}`);
    for (const r of results) {
      for (const cr of r.cases.filter(cr => cr.status === "pending")) {
        console.log(`  ${c.dim("○")} ${c.dim(`[${r.suiteName}]`)} ${cr.description}`);
      }
    }
    if (browserGatedPending > 0) {
      console.log(`  ${c.dim(`${browserGatedPending} claim(s) pending: no browser found (install Chrome/Chromium to run browser claims)`)}`);
    }
    for (const [mod, stages] of degradedModules) {
      console.log(`  ${c.dim(`extraction degraded in ${mod}: ${[...stages].join(", ")} (derivation may be incomplete; a pending here may be the parser giving up, not the claim being vague)`)}`);
    }
  }

  if (!opts.silent && totalSurvivedMutations > 0) {
    console.log(`\n${c.yellow(`${totalSurvivedMutations} surviving mutation(s)`)} ${c.dim("(advisory)")} -- add perspectives to strengthen these claims`);
  }

  if (!opts.silent && totalErroredMutations > 0) {
    console.log(`\n${c.yellow(`${totalErroredMutations} mutation(s) could not be evaluated`)} ${c.dim("(advisory)")} -- the mutant failed to load, so these say nothing about claim strength either way`);
  }

  // A pending claim exits 0 by default: a document written before its implementation is a
  // legitimate, intended starting state, not a build failure. `--fail-on-pending` is an opt-in
  // ratchet for a repo that wants the stricter contract: "every claim here resolves, and a
  // regression that demotes one to pending must fail the build". Left off, the exit-code
  // contract below is unchanged.
  if (!opts.silent && opts.failOnPending && totalPending > 0) {
    console.log(`\n${c.red(`${totalPending} pending claim(s)`)} -- --fail-on-pending is set, so this is a failure`);
  }

  // A no-throw-only green exits 0 by default: it is a real pass (the code ran), and a document may
  // legitimately choose to make only a liveness claim about some behavior. `--fail-on-weak` opts
  // into the stricter contract -- "every green here checks something the code returned or did" -- the
  // same shape of ratchet as `--fail-on-pending`, for a corpus that has earned its strength and
  // wants to keep it. Left off, the exit-code contract below is unchanged.
  if (!opts.silent && opts.failOnWeak && totalShallow > 0) {
    console.log(`\n${c.red(`${totalShallow} no-throw-only claim(s)`)} -- --fail-on-weak is set, so this is a failure`);
  }

  // Only a failing assertion fails the run (plus pending/weak, when their flags are set). Drift and
  // surviving mutations are both reported and both advisory: they say "this document may need
  // attention", which is a judgment call for the author, not a fact the tool can settle. A surviving
  // mutation in particular is often a claim that is deliberately silent about a behavior -- treating
  // that as a build failure pressures authors into writing coverage-shaped claims, which is exactly
  // what an LLD is not for.
  const failed = totalFailed > 0
    || (!!opts.failOnPending && totalPending > 0)
    || (!!opts.failOnWeak && totalShallow > 0);
  return {
    passed: totalPassed,
    failed: totalFailed,
    pending: totalPending,
    indirect: totalIndirect,
    shallow: totalShallow,
    survivingMutations: totalSurvivedMutations,
    erroredMutations: totalErroredMutations,
    hadDrift,
    exitCode: (failed ? 1 : 0) as 0 | 1,
  };
}

/** Directories the default glob skips.
 *
 *  A `fixtures/` directory holds documents that exist to be run *by* something else -- a test, or
 *  a claim in another document -- and several of them are deliberately broken, because that is
 *  what they are for. Sweeping them into the suite means a document written to fail makes the
 *  whole run fail. This project worked around that for a while by hand-tuning the glob in CI and
 *  in the pre-commit hook to a single level; that workaround existing in two places is what
 *  showed the convention belonged in the tool instead.
 *
 *  Naming a fixture path explicitly still runs it -- the exclusion applies to the glob, not to a
 *  literal path, which is what makes `runDocument("lld/fixtures/failing.lld.md")` work. */
export const DEFAULT_GLOB_IGNORE = ["node_modules/**", "**/fixtures/**"];

/** Runs one document by path and returns its outcome, with no output and no mutation pass.
 *
 *  This is the anchor that lets lldtdd's own documents make checkable claims about the runner --
 *  `runDocument("lld/fixtures/failing.lld.md") captures r → r.exitCode === 1` is a claim the
 *  grammar can derive a test from. Without it the exit-code contract could only be described in
 *  prose and left pending, which is precisely the state a document is supposed to get you out of.
 *
 *  Mutation is off because the caller is already inside a run; nesting a mutation pass inside a
 *  claim would re-enter the whole pipeline for every mutant. */
export async function runDocument(lldPath: string): Promise<RunOutcome> {
  return runAndCheck(lldPath, process.cwd(), { silent: true, mutate: false });
}

/** As `runDocument`, but with the mutation pass left on.
 *
 *  Separate rather than a flag because a claim in a document names a function and passes
 *  literals -- there is nowhere to put an options object. The two contracts that need mutation to
 *  have actually run (that it runs without a separate invocation, and that a survivor does not
 *  change the exit code) are checkable through this. */
export async function runDocumentWithMutations(lldPath: string): Promise<RunOutcome> {
  return runAndCheck(lldPath, process.cwd(), { silent: true, mutate: true });
}

/** File-based entry point: resolves glob/path and calls runDocs. */
export async function runAndCheck(
  pattern: string | undefined,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean; mutate?: boolean; failOnPending?: boolean; failOnWeak?: boolean } = {}
): Promise<RunOutcome> {
  const { glob: globFn } = await import("glob");
  const isLiteralPath = pattern && !/[*?{}[\]!]/.test(pattern);
  const lldFiles = isLiteralPath
    ? [resolve(cwd, pattern)]
    : await globFn(pattern ?? "**/*.lld.md", { cwd, absolute: true, ignore: DEFAULT_GLOB_IGNORE });

  // A named path that isn't there is a mistake worth naming. Left to `parseFile` it surfaced as a
  // raw ENOENT stack trace, which tells the user where the reader is rather than what they typed.
  if (isLiteralPath && !existsSync(lldFiles[0])) {
    throw new Error(`no such document: ${pattern}`);
  }

  // An empty glob is not an error -- a repo may simply have no documents yet -- but it must say so.
  // Reporting nothing at all and exiting 0 reads as "everything passed".
  if (lldFiles.length === 0) {
    if (!opts.silent) console.log("No .lld.md files found.");
    return { passed: 0, failed: 0, pending: 0, indirect: 0, shallow: 0, survivingMutations: 0, erroredMutations: 0, hadDrift: false, exitCode: 0 };
  }

  const items = await Promise.all(lldFiles.map(async f => ({ doc: await parseFile(f, cwd), lldFile: f })));
  return runDocs(items, cwd, opts);
}

/** Content-based entry point: parses LLD content in-memory, no file required. */
export async function runContentAndCheck(
  content: string,
  cwd: string,
  opts: { verbose?: boolean; silent?: boolean; mutate?: boolean; failOnPending?: boolean; failOnWeak?: boolean } = {}
): Promise<RunOutcome> {
  const doc = parse(content, resolve(cwd, "inline.lld.md"), cwd);
  return runDocs([{ doc, lldFile: "" }], cwd, opts);
}


function gitChangedFiles(cwd: string): Set<string> | null {
  try {
    const out = execSync("git diff --name-only HEAD 2>/dev/null", { encoding: "utf-8", cwd }).trim();
    if (!out) return new Set(); // git works but nothing changed
    return new Set(out.split("\n").map(f => resolve(cwd, f)));
  } catch {
    return null; // not a git repo or git unavailable -- run drift on everything
  }
}

function printTestCaseDetail(tc: TestCase | undefined, indent: string): void {
  if (!tc) return;

  // Source tag -- color by origin
  const rawTag = tc.source === "pending" ? "[pending]"
    : tc.source === "deterministic"             ? "[grammar]"
    : tc.source === "ast-derived"               ? "[ast]"
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
    for (const ec of tc.action.extraCalls ?? []) {
      const ecArgs = (ec.args ?? []).map(a =>
        typeof a === "object" && a !== null && "__expr" in a
          ? (a as { __expr: string }).__expr
          : JSON.stringify(a)
      ).join(", ");
      action += `  ${c.dim("then")}  ${c.cyan(ec.method)}(${c.dim(ecArgs)}) ${c.dim("→")} ${ec.captures}`;
    }
  } else if (tc.assertion.type === "inspect" && tc.assertion.code) {
    const raw = tc.assertion.code.split("\n").find(l => l.trim())?.trim() ?? "";
    action = c.dim(raw);
  } else if (tc.action.argDescription) {
    action = c.dim(`(${tc.action.argDescription})`);
  }

  // Assertion summary -- color by type
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
