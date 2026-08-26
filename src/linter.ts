import { readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, relative, isAbsolute } from "path";
import { getModuleExports, type ExecutionOptions } from "./inference.ts";
import { translate } from "./translator/index.ts";
import { matchIsGeneralizing } from "./ast/index.ts";
import { parseFile } from "./parser.ts";

export interface LintIssue {
  level: "error" | "warning";
  line: number;
  message: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  errors: number;
  warnings: number;
}

interface GroupState {
  name: string; line: number;
  hasMethod: boolean; hasSetup: boolean; assertions: number;
  methodName?: string; methodLine?: number;
  moduleOverride?: string;
}

/** Mutable scan state threaded through lintFile's phases. */
interface LintState {
  lines: string[];
  absPath: string;
  err: (line: number, message: string) => void;
  warn: (line: number, message: string) => void;
  hasTitle: boolean;
  hasModule: boolean;
  moduleRaw: string;
  hasGroup: boolean;
  currentGroup: GroupState | null;
  seenAssertions: Map<string, number>; // text -> first line
  claimLines: Map<string, number>; // every bullet (claim or perspective) text -> first line, for post-parse warnings
  // Collect all method annotations for stale-check after parsing
  methodAnnotations: Array<{ name: string; line: number; modulePath: string }>;
  // Claims the grammar can't reach, pending an AST-derivation check after parsing
  underivableCandidates: Array<{ line: number; text: string; modulePath: string; nextCarriesPerspectives: boolean }>;
}

/** Does the claim carry an outcome arrow? Both spellings -- the parser normalises `->` to `→`,
 *  but the linter reads the file as written, so it has to accept either. */
function hasOutcomeArrow(assertion: string): boolean {
  return assertion.includes("->") || assertion.includes("→");
}

/** Does the claim name a call? `addItem("s", "x")`, `_subject("key")`, `login(...)`.
 *  Mirrors parser.ts's parseCallExpr: an identifier immediately followed by `(`. */
function hasInlineCall(assertion: string): boolean {
  return /(?:^|[\s`])\w+\s*\(/.test(assertion);
}

/** Whether the *next* sibling bullet is the one carrying perspectives.
 *
 *  This is the attachment bug's signature. A perspective binds to the bullet directly above it, so a
 *  reason written as a bullet between a claim and its check silently takes the check: the claim reads
 *  pending and the reason reads verified, and nothing fails. The claim above is what this linter
 *  already reports as underivable, which makes it the right place to say what the likely fix is --
 *  the author usually needs to move a sentence out of the list, not invent a new perspective. */
function nextSiblingHasPerspectives(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const raw = lines[j];
    if (!raw.trim()) continue;
    if (/^\s{2,}-\s/.test(raw)) return false;   // perspectives here belong to the claim at i
    if (/^-\s/.test(raw)) return hasPerspectivesAfter(lines, j);
    return false;                                // an annotation or a new heading ends the run
  }
  return false;
}

function hasPerspectivesAfter(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const raw = lines[j];
    if (!raw.trim()) continue;
    if (/^\s{2,}-\s/.test(raw)) return true;
    return false; // next content is a sibling bullet, an annotation, or a new heading
  }
  return false;
}

/** A `> path` or `**module:**` value relative to the document, or repo-relative otherwise.
 *
 *  Returns null for a pointer that resolves outside both the project root and the document's own
 *  directory -- the same containment contract parser.ts's resolveModulePointer enforces by
 *  throwing, restated here because that helper is not exported and the linter resolves pointers
 *  at sites the parser never sees (the stale-method check reads these paths directly). A null
 *  keeps every downstream read inside the boundary; the caller decides how to report it. */
function resolveModulePath(ref: string, absPath: string): string | null {
  const root = process.cwd();
  const resolved = ref.startsWith("./") || ref.startsWith("../")
    ? resolve(dirname(absPath), ref)
    : resolve(root, ref);
  const inside = (base: string) => {
    const rel = relative(base, resolved);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  return inside(root) || inside(dirname(absPath)) ? resolved : null;
}

/** The one sentence both the parser's refusal and the linter's own report contain, so a document
 *  whose pointer escapes is reported once however many resolution sites see it. */
const CONTAINMENT_MESSAGE = /outside the project root/;

/** Close out the group in progress: flag it if empty, and queue its method annotation
 *  for the stale check. Runs both at each `## ` boundary and after the last line. */
function finalizeGroup(state: LintState): void {
  const group = state.currentGroup;
  if (!group) return;
  if (group.assertions === 0) {
    state.warn(group.line, `Group "${group.name}" has no assertions`);
  }
  if (group.methodName && group.methodLine) {
    const effectiveModule = group.moduleOverride ?? (state.moduleRaw
      ? resolveModulePath(state.moduleRaw, state.absPath) ?? ""
      : "");
    if (effectiveModule) {
      state.methodAnnotations.push({
        name: group.methodName,
        line: group.methodLine,
        modulePath: effectiveModule,
      });
    }
  }
}

// Unicode arrows are valid in assertion lines (parser normalises both → and ->)
// Only flag → in prose (non-assertion, non-annotation) lines
function lintCharacterPolicy(t: string, ln: number, warn: LintState["warn"], err: LintState["err"]): void {
  const isAssertionLine = t.startsWith("- ") || t.startsWith("  - ");
  const isAnnotationLine = t.startsWith("**");
  if (!isAssertionLine && !isAnnotationLine && t.includes("→"))
    warn(ln, 'Unicode arrow in prose -- use -> in assertion lines for consistency');
  if (t.includes("\u2014")) err(ln, 'Em-dash found: use -- or rephrase');

  // Deprecated ASCII separator " - prose" in assertions (context-aware)
  if (t.startsWith("- ") && !t.includes("->") && / - [a-z]/.test(t)) {
    warn(ln, 'Possible deprecated " - " prose separator: use // instead');
  }
}

/** Returns true when the line was structural (title, module pointer, or group heading)
 *  and the scan should move on. */
function lintStructure(state: LintState, t: string, ln: number): boolean {
  if (t.startsWith("# ") && !t.startsWith("## ")) {
    state.hasTitle = true;
    return true;
  }

  if (!state.hasModule && t.startsWith("> ")) {
    state.hasModule = true;
    state.moduleRaw = t.slice(2).trim();
    return true;
  }

  if (t.startsWith("## ")) {
    finalizeGroup(state);
    state.hasGroup = true;
    state.currentGroup = { name: t.slice(3).trim(), line: ln, hasMethod: false, hasSetup: false, assertions: 0 };
    return true;
  }

  return false;
}

/** Returns true when the line was an annotation and the scan should move on. */
function lintAnnotationSyntax(state: LintState, t: string, ln: number, group: GroupState): boolean {
  if (/^\*\*method:\*\*/i.test(t)) {
    if (!t.match(/^\*\*method:\*\*\s*`[^`]+`/i)) {
      state.err(ln, '**method:** value must be backtick-wrapped: **method:** `methodName`');
    } else {
      const methodName = t.match(/^\*\*method:\*\*\s*`([^`]+)`/i)?.[1];
      if (methodName) {
        group.methodName = methodName;
        group.methodLine = ln;
      }
    }
    group.hasMethod = true;
    return true;
  }

  if (/^\*\*module:\*\*/i.test(t)) {
    const modRaw = t.match(/^\*\*module:\*\*\s*`([^`]+)`/i)?.[1];
    if (modRaw) {
      const resolved = resolveModulePath(modRaw, state.absPath);
      if (resolved === null) {
        state.err(ln, `**module:** \`${modRaw}\` resolves outside the project root; refusing to read it`);
      } else {
        group.moduleOverride = resolved;
      }
    }
    return true;
  }
  if (/^\*\*setup:\*\*/i.test(t)) {
    if (!t.match(/^\*\*setup:\*\*\s*`[^`]+`/i))
      state.err(ln, '**setup:** value must be backtick-wrapped: **setup:** `createFoo()`');
    group.hasSetup = true;
    return true;
  }
  if (/^\*\*beforeall:\*\*/i.test(t)) {
    if (!t.match(/^\*\*beforeall:\*\*\s*`[^`]+`/i))
      state.err(ln, '**beforeAll:** value must be backtick-wrapped');
    return true;
  }
  if (/^\*\*beforeeach:\*\*/i.test(t)) {
    if (!t.match(/^\*\*beforeeach:\*\*\s*`[^`]+`/i))
      state.err(ln, '**beforeEach:** value must be backtick-wrapped');
    return true;
  }
  if (/^\*\*mock-http:\*\*/i.test(t)) {
    // The parser JSON.parses this value and silently drops it on failure (no mock installed, no
    // error), so a malformed entry makes every claim relying on the mock quietly mislead. Catch it
    // here, where the safety net is supposed to live.
    const raw = t.match(/^\*\*mock-http:\*\*\s*`(.+?)`/i)?.[1];
    if (!raw) {
      state.err(ln, '**mock-http:** value must be backtick-wrapped JSON: **mock-http:** `{ "url": "...", "body": {...} }`');
    } else {
      try { JSON.parse(raw); }
      catch { state.err(ln, `**mock-http:** value is not valid JSON, so the parser silently drops it and no mock is installed: \`${raw.slice(0, 50)}\``); }
    }
    return true;
  }

  return false;
}

// A top-level claim with no outcome arrow, no inline call, and no perspectives has nothing
// concrete in it for the grammar to check. Left unflagged, prose like "does not affect the
// source balance" would sit in a verified-looking document while nothing about the claim
// had been tested, so the linter is the place to say so.
//
// But "the grammar can't" is not yet "nothing can" -- an AST pattern may still derive a real
// test from the module's structure, which is how examples/toggle.lld.md's bare claims turn
// green. Warning on those would be telling the author to fix something that already works,
// so the candidates collected here are re-checked against actual derivation in
// lintUnderivableClaims, and only the ones nothing can reach are reported.
function collectUnderspecifiedClaim(state: LintState, i: number, ln: number, assertion: string, group: GroupState): void {
  if (!hasOutcomeArrow(assertion) && !hasInlineCall(assertion) && !hasPerspectivesAfter(state.lines, i)) {
    state.underivableCandidates.push({
      line: ln,
      text: assertion,
      modulePath: group.moduleOverride ?? "",
      nextCarriesPerspectives: nextSiblingHasPerspectives(state.lines, i),
    });
  }
}

// A claim written with a `*` or `+` marker is legal Markdown but invisible to the parser, which
// reads only `-`. Unflagged, the line does not go pending or fail -- it vanishes, which for a
// tool whose whole promise is "your claims are checked" is the one failure worse than a red one.
function lintAssertionBullet(state: LintState, t: string, ln: number, i: number, group: GroupState): void {
  const nearMiss = t.match(/^([*+])\s+\S/);
  if (nearMiss) {
    state.err(ln, `Claim uses a "${nearMiss[1]}" bullet, which the parser ignores -- use "- " or the claim is silently dropped`);
    return;
  }
  if (!t.startsWith("- ")) return;

  const assertion = t.slice(2).trim();
  group.assertions++;
  // Key by the same arrow-normalized form the parser produces (parser.ts turns `->` into `→`
  // before building descriptions), so a post-parse lookup by `tc.description` finds the line.
  const normalized = assertion.replace(/ *-> */g, " → ");
  if (!state.claimLines.has(normalized)) state.claimLines.set(normalized, ln);

  // Backtick-outcome trap: in this grammar backticks around an outcome mean an error class
  // (`AuthError`) or a `{shape}` -- there is no backticked-value form. So `-> `1`` or `-> `null``
  // matches neither and silently pends, while `-> 1` / `-> null` are ordinary value assertions that
  // pass. Backticking a value is a newcomer's likeliest first mistake, because the README teaches
  // backticked outcomes first; left alone it drops the claim to pending while it still reads as
  // written, so the safety net has to name it.
  const outcomeMatch = assertion.match(/(?:->|→)\s*(.+)$/);
  if (outcomeMatch) {
    const backticked = outcomeMatch[1].trim().match(/^`([^`]*)`$/);
    if (backticked) {
      const inner = backticked[1].trim();
      const isErrorClass = /^(?:[A-Z]\w*)?(?:Error|Exception|Fault)(?:\(.*\))?$/.test(inner);
      if (!isErrorClass && !inner.startsWith("{")) {
        state.warn(ln, `Outcome \`${inner}\` is backticked, which in this grammar means an error class (\`AuthError\`) or a \`{shape}\` -- a backticked value matches neither and silently pends. Drop the backticks to assert the value: "-> ${inner}"`);
      }
    }
  }

  // Duplicate detection: only flag top-level assertions (perspectives may intentionally
  // repeat the same test under different parent claims)
  const isIndented = /^\s{2,}-\s/.test(state.lines[i]);
  if (!isIndented) {
    if (state.seenAssertions.has(assertion)) {
      state.warn(ln, `Duplicate assertion (first at line ${state.seenAssertions.get(assertion)}): "${assertion.slice(0, 60)}"`);
    } else {
      state.seenAssertions.set(assertion, ln);
    }

    collectUnderspecifiedClaim(state, i, ln, assertion, group);
  }
}

async function lintDocumentLevel(state: LintState, opts: ExecutionOptions): Promise<void> {
  if (!state.hasTitle)  state.err(1, 'Missing document title: # Title');
  if (!state.hasModule) state.err(1, 'Missing module pointer: > path/to/module');
  if (!state.hasGroup)  state.warn(1, 'No groups defined: add ## Section headings');

  if (state.moduleRaw) {
    const modPath = resolveModulePath(state.moduleRaw, state.absPath);
    if (modPath === null) {
      state.err(1, `Module pointer \`${state.moduleRaw}\` resolves outside the project root; refusing to read it`);
    } else if (!existsSync(modPath)) {
      state.err(1, `Module not found: ${state.moduleRaw}`);
    }
  }

  // Stale annotation check: verify **method:** names exist as actual exports OR __lld_api declarations.
  // Methods declared in __lld_api are valid virtual methods -- the translator derives their calls
  // from the description vocabulary even when no function body exists.
  const exportCache = new Map<string, Set<string>>();
  const apiCache    = new Map<string, Set<string>>();

  for (const ann of state.methodAnnotations) {
    if (!existsSync(ann.modulePath)) continue;

    if (!exportCache.has(ann.modulePath)) {
      const exports = await getModuleExports(ann.modulePath, opts);
      exportCache.set(ann.modulePath, new Set(exports));
    }
    if (!apiCache.has(ann.modulePath)) {
      try {
        const src = await readFile(ann.modulePath, "utf-8");
        const apiMatch = src.match(/export\s+const\s+__lld_api\s*=\s*`([^`]*)`/s);
        const apiNames = new Set<string>();
        if (apiMatch) {
          for (const m of apiMatch[1].matchAll(/^\s+(?:_subject\.)?(\w+)\s*\(/gm)) apiNames.add(m[1]);
        }
        apiCache.set(ann.modulePath, apiNames);
      } catch { apiCache.set(ann.modulePath, new Set()); }
    }

    const exports = exportCache.get(ann.modulePath)!;
    const apiDecls = apiCache.get(ann.modulePath)!;
    if (exports.size > 0 && !exports.has(ann.name) && !apiDecls.has(ann.name)) {
      state.err(ann.line, `**method:** \`${ann.name}\` not found in module -- was it renamed? Available: ${[...exports].filter(e => !e.startsWith("__")).slice(0, 6).join(", ")}`);
    }
  }
}

// The candidates are claims with nothing concrete in them -- no outcome arrow, no inline call,
// no perspectives. Whether that actually leaves them pending is not something this file gets
// to decide: derivation has several paths (the grammar, `deriveInline`'s AST patterns, and
// group-method resolution through a module's `__lld_api`), and a linter that reimplements a
// subset of them will confidently warn about claims that derive fine. It did exactly that --
// it consulted `deriveInline` alone and flagged claims that resolve via the group-method path.
//
// So it asks the real pipeline instead. Anything the translator marks `pending` is
// pending; anything else is not. One source of truth, no drift.
async function lintUnderivableClaims(state: LintState, filePath: string, opts: ExecutionOptions): Promise<void> {
  const docModule = state.moduleRaw ? resolveModulePath(state.moduleRaw, state.absPath) : "";

  // A document written before its implementation is *supposed* to be entirely pending; the checks
  // below only make sense against a real module, so they need it to exist. Translating is the price
  // of asking the real pipeline rather than reimplementing a subset of it -- paid once, here.
  if (!docModule || !existsSync(docModule)) return;

  const suite = await translate(await parseFile(filePath), opts);

  // A degraded stage ran on empty facts (see DegradedExtraction), so a pending claim below can
  // mean the parser gave up rather than the claim being vague -- the reader cannot tell which
  // unless the tool says so.
  for (const d of suite.moduleAstFacts?.degraded ?? []) {
    state.warn(1, `AST extraction degraded in stage \`${d.stage}\` (${d.reason}) -- derivation ran on partial facts, so a pending claim below may be the parser giving up, not the claim being vague`);
  }

  // No-throw-only claims: a derived assertion that only checks the call didn't throw (`-> resolves`
  // with no value or shape). It passes for any implementation that runs at all -- the same weak
  // green the runner marks `◐ shallow`. Flagged at authoring so the author can decide: if the
  // claim means more than "it runs", the perspective has to say what. Warns on leaf cases (a claim
  // or perspective with nothing further under it), where no-throw is the whole of the evidence.
  // Kept in step with the runner's own shallow predicate (bunRunner.ts): a bare `-> resolves`, or a
  // `contains`/sentinel claim with no substring to look for. One definition of "weak green" would be
  // better than two, but the runner's runs per-suite in the subprocess parser and this one runs at
  // authoring time; they must agree, so any change to one belongs in the other.
  const isNoThrowOnly = (a: { type: string; description?: string; negations?: string[]; expected?: unknown }): boolean =>
    (a.type === "resolves" && !a.description && !(a.negations && a.negations.length > 0)) ||
    (a.type === "contains" && typeof a.expected !== "string");
  const scanWeak = (cases: typeof suite.groups[number]["cases"]): void => {
    for (const tc of cases) {
      const kids = tc.perspectives ?? [];
      if (kids.length > 0) { scanWeak(kids); continue; }
      if (tc.source !== "pending" && isNoThrowOnly(tc.assertion)) {
        const ln = state.claimLines.get(tc.description);
        if (ln !== undefined) {
          state.warn(ln, `Claim passes on no-throw only -- the call runs but nothing it returns or does is checked, so it stays green against any implementation that doesn't crash. Add a perspective that asserts the behavior: "${tc.description.slice(0, 50)}"`);
        }
      }
    }
  };
  scanWeak(suite.groups.flatMap(g => g.cases));

  if (state.underivableCandidates.length > 0) {
    // Some patterns pick probe values out of the module (a declared enum, say), so the same
    // source the deriver sees decides whether a match generalizes.
    const moduleSource = readFileSync(docModule, "utf-8");
    const sourceOf = new Map(
      suite.groups.flatMap(g => g.cases).map(tc => [tc.description, tc.source] as const)
    );

    for (const cand of state.underivableCandidates) {
      const source = sourceOf.get(cand.text);

      if (source === "pending") {
        const hint = cand.nextCarriesPerspectives
          ? ` -- the bullet below carries perspectives that may belong to this claim; if that bullet is a reason rather than a claim, move it into the section prose`
          : "";
        state.warn(cand.line, `Claim can only ever be pending -- no outcome (\`-> ...\`), no inline call, no perspectives, and nothing derives it: "${cand.text.slice(0, 50)}"${hint}`);
        continue;
      }

      // It derives -- but on nothing except how it happens to be worded. These candidates have no
      // concrete content of their own, so a pattern recognised the sentence. Reword the sentence
      // and the test disappears, silently, back to pending: the claim still reads as verified in
      // the document while nothing checks it any more.
      //
      // That is the inverse of a false pass, and it is why this warns rather than staying quiet.
      // Every pattern family that matches a bare claim keys off wording; the ones behind most of
      // these read no capture groups at all, so they are matching close to a whole sentence.
      // A perspective moves the anchor into the document, where editing the prose cannot break it.
      // ...unless the pattern that claimed it reads its own match. Those adapt to what they
      // captured, so the claim survives rewording within its vocabulary -- "the disabled attribute
      // is set on the element" and "the readonly attribute is set on the element" both derive.
      // Warning about those is a false alarm, and a warning nobody can act on is one people learn
      // to ignore.
      if (source === "ast-derived" && !matchIsGeneralizing(cand.text, moduleSource)) {
        state.warn(cand.line, `Claim derives a test only from its wording -- rewording it will silently drop it to pending. Add a perspective to anchor it: "${cand.text.slice(0, 50)}"`);
      }
    }
  }
}

/** `opts.execute` lets the caller opt into loading the module under test for sharper export and
 *  scenario resolution. It is off by default: linting a document must not run its subject's code,
 *  because the whole point of reaching for `lint` instead of `run` is to look without touching. */
export async function lintFile(filePath: string, opts: ExecutionOptions = {}): Promise<LintResult> {
  const raw = await readFile(filePath, "utf-8");
  const issues: LintIssue[] = [];

  const state: LintState = {
    lines: raw.split("\n"),
    absPath: resolve(filePath),
    err:  (line, message) => issues.push({ level: "error",   line, message }),
    warn: (line, message) => issues.push({ level: "warning", line, message }),
    hasTitle: false,
    hasModule: false,
    moduleRaw: "",
    hasGroup: false,
    currentGroup: null,
    seenAssertions: new Map(),
    claimLines: new Map(),
    methodAnnotations: [],
    underivableCandidates: [],
  };

  for (let i = 0; i < state.lines.length; i++) {
    const ln = i + 1;
    const t  = state.lines[i].trim();

    lintCharacterPolicy(t, ln, state.warn, state.err);
    if (lintStructure(state, t, ln)) continue;
    if (!state.currentGroup) continue;
    if (lintAnnotationSyntax(state, t, ln, state.currentGroup)) continue;
    lintAssertionBullet(state, t, ln, i, state.currentGroup);
  }

  finalizeGroup(state);

  // parseFile inside lintUnderivableClaims applies the same containment contract by throwing,
  // and a group-level `**module:**` that escapes reaches it even after the linter refused the
  // annotation above. Lint's job is to report the document, not to die of it, so the refusal
  // becomes an ERROR here -- once, however many resolution sites saw the pointer.
  try {
    await lintDocumentLevel(state, opts);
    await lintUnderivableClaims(state, filePath, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!CONTAINMENT_MESSAGE.test(msg)) throw e;
    if (!issues.some(i => CONTAINMENT_MESSAGE.test(i.message))) {
      issues.push({ level: "error", line: 1, message: msg.replace(/^lldtdd: /, "") });
    }
  }

  const errors   = issues.filter(i => i.level === "error").length;
  const warnings = issues.filter(i => i.level === "warning").length;
  return { file: filePath, issues, errors, warnings };
}
