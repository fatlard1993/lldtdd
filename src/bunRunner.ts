import { writeFile, unlink, mkdir, rmdir, lstat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { TestSuite, TestGroup, TestCase, RunResult, CaseResult, CaseStatus, AssertionStep } from "./types.ts";
import { trackTempFile, untrackTempFile } from "./tempFiles.ts";

// The one import statement generated test files receive from lldtdd itself: path and binding
// list both defined once, here. No example or self-hosted document exercises the db-lifecycle
// codegen path that emits this import, so a stale duplicate would ship unnoticed. There is
// exactly one definition, and bunRunner.test.ts asserts every binding in it actually resolves.
export const RUNTIME_MODULE_PATH = new URL("./runtime.ts", import.meta.url).pathname;
export const RUNTIME_EXPORTS = [
  "createDbLifecycle", "createEntityRegistry", "withSeedAndRead", "withIsolationTest",
  "withFaultInjection", "withOrderTracking", "withMountedComponent",
  "withMockFetch", "subscribeSpy",
] as const;
const RUNTIME_IMPORT = `import { ${RUNTIME_EXPORTS.join(", ")} } from ${JSON.stringify(RUNTIME_MODULE_PATH)};`;

// `inBrowser` lives in its own module rather than in runtime.ts, and is imported separately, because
// importing it drags in a CDP client and a bundler call. A document with no browser groups should not
// load any of that, and the vast majority have none.
const BROWSER_MODULE_PATH = new URL("./browser.ts", import.meta.url).pathname;
const BROWSER_IMPORT = `import { inBrowser } from ${JSON.stringify(BROWSER_MODULE_PATH)};`;

/** Generates a bun:test file for a translated+synthesized suite, runs it as a subprocess, and
 * parses the result. This is the only test-execution path: there is no pluggable-adapter
 * abstraction, deliberately -- one runtime, one code path. */
export async function runSuite(suite: TestSuite): Promise<RunResult> {
  const moduleExists = suite.modulePath.length > 0 && existsSync(suite.modulePath);
  const start = Date.now();

  if (!moduleExists) return allPending(suite, Date.now() - start);

  // DOM-component suites import "@happy-dom/global-registrator" by package name, which only
  // resolves via node_modules when the generated file lives inside this project's directory
  // tree -- the OS tmpdir has no node_modules ancestry to walk up to. Non-DOM suites (the vast
  // majority) keep using the OS tmpdir exactly as before.
  const needsDom = !!suite.moduleAstFacts?.componentClass;
  const tmpDir = needsDom ? join(process.cwd(), ".lldtdd-tmp") : tmpdir();
  if (needsDom) {
    // This path writes inside the user's project rather than the OS tmpdir, and the directory
    // name is fixed, so a repo can ship `.lldtdd-tmp` as a symlink and `mkdir(recursive)` would
    // accept it and follow it on every write. A scratch directory is ours to create or not at all.
    const existing = await lstat(tmpDir).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new Error(`${tmpDir} is a symlink; refusing to write scratch files through it`);
    }
    await mkdir(tmpDir, { recursive: true });
  }
  const tmpFile = join(tmpDir, `lldtdd-${randomUUID()}.test.ts`);

  try {
    const _gen = generateTestFile(suite);
    // Registered before the write, so an interrupt mid-write cannot leave a file nothing is
    // tracking. The DOM path is the one that matters here: its scratch file has to live inside the
    // project to reach node_modules, so an interrupted run would otherwise strand it in the user's
    // own source tree rather than the OS tmpdir.
    trackTempFile(tmpFile);
    await writeFile(tmpFile, _gen);
    if (process.env.LLDTDD_DEBUG_GEN) await writeFile(process.env.LLDTDD_DEBUG_GEN, _gen);

    const proc = Bun.spawn(["bun", "test", "--timeout", "120000", tmpFile], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return parseOutput(suite, out + err, Date.now() - start, exitCode);
  } finally {
    await unlink(tmpFile).catch(() => {});
    untrackTempFile(tmpFile);
    // The DOM path has to put its scratch file inside the project to reach node_modules, so it
    // also has to clean up after itself -- leaving a directory behind in someone else's repo is
    // litter. rmdir only removes an empty directory, which makes this safe when suites overlap:
    // whoever finishes last removes it, and anyone still holding a file makes the call a no-op.
    if (needsDom) await rmdir(tmpDir).catch(() => {});
  }
}

// ── Code generation ───────────────────────────────────────────────────

// Build a stable alias name for a module path: "lld/helpers/bookmarks.js" → "Bookmarks"
function moduleAlias(path: string): string {
  const stem = basename(path, extname(path));
  return stem.charAt(0).toUpperCase() + stem.slice(1).replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

// Emits `import <spec> from "path";` when path is set and exists on disk -- the shape behind
// every side-channel import generated code can reach (_SubjectCtor, _database, _Companion,
// per-entity FK imports, primaryAction, _PipelineStage...). Returns whether it imported,
// since a couple of call sites need to know that to decide on a fallback.
function pushImport(
  lines: string[],
  path: string | undefined,
  kind: "default" | "namespace" | "named",
  spec: string | string[]
): boolean {
  if (!path || !existsSync(path)) return false;
  const specText = kind === "default" ? (spec as string)
    : kind === "namespace" ? `* as ${spec as string}`
    : `{ ${(spec as string[]).join(", ")} }`;
  lines.push(`import ${specText} from ${JSON.stringify(path)};`);
  return true;
}

/** Every case in the suite, perspectives included.
 *
 *  Scanning only `g.cases` is a bug generator: a perspective is where GRAMMAR tells authors to
 *  put the concrete, checkable form of a claim, so it is the *likeliest* place for a spy or a
 *  mock to appear, not an edge case. `needsMock` missed them, and a spy written as a perspective
 *  generated a file referencing an undefined `mock` -- the whole file then failed to load, which
 *  `parseOutput` reports as every claim failing, for a reason the author has no way to see. */
function allCases(suite: TestSuite): TestCase[] {
  return suite.groups.flatMap(g => g.cases.flatMap(tc => [tc, ...(tc.perspectives ?? [])]));
}

/** Assertion types whose subject is a registered callback rather than a return value. Three
 *  places need to know this -- import decisions, code emission, and result classification -- and
 *  they were three separate inline disjunctions; naming it once is what keeps them agreeing. */
const SPY_ASSERTIONS: readonly string[] = ["called", "calledWith", "notCalled"];

function isSpyAssertion(tc: TestCase): boolean {
  return SPY_ASSERTIONS.includes(tc.assertion.type);
}

/** Whether a claim gets a test of its own.
 *
 *  Two places need this answer and they must give the same one: `caseToCode` decides whether to
 *  emit `it(...)` or `it.todo(...)`, and `caseResult` decides whether a missing result means
 *  "pending" or "this claim had a test and it passed". Separate inline disjunctions drift, and
 *  either direction of drift is a lie:
 *
 *    - a classifier that accepts `action.captures` when the emitter does not sends a case with
 *      captures but no method down the `it.todo` path and then classifies it as a *pass*: a
 *      claim reported green with no test behind it, which is the one thing this project is built
 *      to prevent.
 *    - fault-resilience keyed off `assertion.faultTarget` in the emitter but `action.method` in
 *      the classifier lets `faultTarget` alone fall through the emitter's fault-resilience
 *      branch, which requires `action.method` (see below), and generate `Subject.undefined()`.
 *
 *  Every question is resolved toward the stricter answer: emitting a broken test, or calling a
 *  claim verified when nothing ran, are both worse than reporting it pending. */
export function hasDirectTest(tc: TestCase, hasSetup: boolean): boolean {
  // A spy has to reach the code under test somehow: a group `**setup:**` builds `_subject` and the
  // spy rides along, or the claim writes `spy` in its own arguments and the call passes it
  // directly. Recognizing only the first would report a module-level callback claim as pending.
  if (isSpyAssertion(tc) && !hasSetup && !reservedArgsUsed(tc).includes("spy")) return false;

  // A complete inspect body carries its own call, so it needs no resolved method. `captures` means
  // the body expects a value the generated call has to produce, which it cannot do here.
  const hasCompleteCode = tc.assertion.type === "inspect" && !!tc.assertion.code && !tc.action.captures;

  // Both of these emit a call through `tc.action.method`; without one there is nothing to call.
  const isSchemaDrop      = tc.assertion.type === "schema-drop"      && !!tc.action.method;
  const isFaultResilience = tc.assertion.type === "fault-resilience" && !!tc.action.method;

  return hasCompleteCode || isSchemaDrop || isFaultResilience
    || (tc.source !== "pending" && (tc.action.method !== undefined || hasSetup));
}

function generateTestFile(suite: TestSuite): string {
  const cases = allCases(suite);
  const needsSpy = cases.some(isSpyAssertion);
  const needsMock = needsSpy
    || cases.some(tc => tc.assertion.type === "inspect" && tc.assertion.code?.includes("mock("));
  // Detect if the primary module is a default-exporting CRUD module
  // If so: default import, inline lifecycle, inline EntityRegistry
  const facts = suite.moduleAstFacts;
  const isCrudDefault = facts?.isDefaultCrud && suite.modulePath.length > 0;

  // Decided once and used twice below -- for the bun:test import list and for the emission. Written
  // separately the two drift, and a file that declares a lifecycle it never imported dies on
  // `beforeAll is not defined`. A module that reaches a database through imported entities needs it
  // initialized too, so this does not require the module to call createDbLifecycle itself.
  const derivedCollections = [...new Set((facts?.schemas ?? []).map(s => s.collection).filter(Boolean))] as string[];
  const dbReachable = !!(facts?.databaseModulePath && existsSync(facts.databaseModulePath));
  const hasDerivedDbLifecycle = dbReachable && (!!facts?.lifecycleOptions || derivedCollections.length > 0);
  const isSelfDbEarly = facts?.isSelfDatabase;
  const hasTopLevelLifecycle = isCrudDefault || hasDerivedDbLifecycle || !!isSelfDbEarly;
  const needsBeforeAll  = hasTopLevelLifecycle || suite.groups.some(g => !!g.beforeAll);
  const needsBeforeEach = hasTopLevelLifecycle
    || suite.groups.some(g => !!g.beforeEach || !!g.setup || g.mockHttp !== undefined);
  const needsAfterEach  = suite.groups.some(g => g.mockHttp !== undefined);

  const imports = ["describe", "it", "expect"];
  if (needsBeforeAll) imports.push("beforeAll");
  if (needsBeforeEach) imports.push("beforeEach");
  if (needsAfterEach) imports.push("afterEach");
  if (needsMock) imports.push("mock");

  // Collect unique module paths; main module is always "Subject"
  const aliasMap = new Map<string, string>();
  aliasMap.set(suite.modulePath, "Subject");
  for (const group of suite.groups) {
    const path = group.modulePath;
    if (path && !aliasMap.has(path)) aliasMap.set(path, moduleAlias(path));
  }

  // DOM-component suites (constructor classes with a `.elem`) need a real `document` -- register
  // happy-dom only in this suite's own subprocess, not repo-wide. A project-level bunfig.toml
  // preload was tried first and rejected: it applies to every generated test file including
  // non-DOM ones, and broke the CLI's own self-hosting tests (nested `bun run`/`bun test`
  // subprocess spawns interacting badly with a registered global document). Scoping the
  // registration to only the suites that need it avoids that blast radius entirely.
  const needsDom = !!facts?.componentClass;

  // Guarded: a target repo may already register happy-dom itself (its own bunfig.toml preload)
  // -- GlobalRegistrator.register() throws on a second call in the same process, so only
  // register when nothing has claimed `document` yet.
  const lines: string[] = [
    ...(needsDom ? [
      `if (typeof document === "undefined") {`,
      `  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");`,
      `  GlobalRegistrator.register();`,
      `}`,
    ] : []),
    `import { ${imports.join(", ")} } from "bun:test";`,
  ];

  // Companion module: an auxiliary import (e.g. a base class) that generated inline code can
  // reference as `_Companion` -- for modules under test that are generic over another module
  // rather than being directly constructible themselves.
  pushImport(lines, suite.companionModulePath, "default", "_Companion");

  // Emit the runtime import once, from one place. Gated to the database-lifecycle branches it was
  // unreachable for a suite needing a runtime helper without a database (spy claims via
  // `subscribeSpy`); one call site also keeps the duplicate-import bug the header describes from
  // returning.
  let runtimeImported = false;
  const ensureRuntimeImport = () => {
    if (runtimeImported) return;
    lines.push(RUNTIME_IMPORT);
    runtimeImported = true;
  };
  if (needsSpy) ensureRuntimeImport();

  // Any pattern family can emit a runtime helper in its inline code, not just the three branches
  // below that were written knowing they needed one. Deciding it by scanning the generated cases --
  // against the same RUNTIME_EXPORTS list the import statement is built from -- means a new family
  // gets the import by construction, instead of its author discovering at runtime that
  // `withMockFetch` is undefined in a file that otherwise looks correct.
  if (cases.some(tc => tc.assertion.code && RUNTIME_EXPORTS.some(n => tc.assertion.code!.includes(n)))) {
    ensureRuntimeImport();
  }

  // Same scan, separate import: `inBrowser` pulls in a devtools client and a bundler call, so a
  // document that never asked for a browser must not load it.
  if (cases.some(tc => tc.assertion.code?.includes("inBrowser("))) lines.push(BROWSER_IMPORT);

  if (isCrudDefault) {
    // Default import for the CRUD object (Subject.create, Subject.read, etc.)
    lines.push(`import Subject from ${JSON.stringify(suite.modulePath)};`);

    // Import related entity modules detected from FK relationships
    const relatedPaths = facts?.relatedEntityPaths ?? {};
    for (const [entity, path] of Object.entries(relatedPaths)) {
      pushImport(lines, path, "default", `_${entity}`);
    }

    // Import database module for lifecycle
    pushImport(lines, facts?.databaseModulePath, "default", "_database");

    // A `**module:**` override on a group inside a CRUD document names a module this branch would
    // otherwise never import: the related-entity list above only covers modules the schema points
    // at through a foreign key. The group's cases are still emitted against that module's alias,
    // so the file referenced a binding it never declared and every claim in the group died on
    // `X is not defined` -- a reference error reported as a failing claim.
    for (const group of suite.groups) {
      const path = group.modulePath;
      if (!path || path === suite.modulePath) continue;
      const alias = aliasMap.get(path);
      if (!alias || alias === "Subject") continue;
      if (Object.values(relatedPaths).includes(path)) continue;
      lines.push(`import * as ${alias} from ${JSON.stringify(path)};`);
    }

    // Inline runtime utilities needed
    ensureRuntimeImport();
    // Import primaryAction from its module if known (e.g. searchProvider from utils/search.js)
    if (facts?.primaryAction) pushImport(lines, facts.primaryActionModule, "named", [facts.primaryAction]);

    // Inline lifecycle
    const allCollections = [...new Set([facts?.schemas[0]?.collection, ...Object.values(relatedPaths).map(p => basename(p, ".js"))].filter(Boolean))];
    lines.push(`const { initDb: _initDb, reset: _reset } = createDbLifecycle(_database, ${JSON.stringify(allCollections)});`);

    // Inline EntityRegistry. Keys come from the module's own source (collection names, FK entity
    // names), so they go through JSON.stringify like every other source-derived string this file
    // quotes -- raw interpolation let a crafted name break out of the literal.
    const registryEntries = [`${JSON.stringify(facts?.schemas[0]?.collection?.replace(/s$/, "") ?? "entity")}: Subject`];
    for (const [entity] of Object.entries(relatedPaths)) {
      registryEntries.push(`${JSON.stringify(entity)}: _${entity}`);
    }
    lines.push(`const _registry = createEntityRegistry({ ${registryEntries.join(", ")} });`);

    lines.push(``);

    // Generate the describe block with top-level lifecycle for the default CRUD case
    // _initDb and _reset are local consts -- call them directly, not as Subject methods
    lines.push(`describe(${JSON.stringify(suite.title)}, () => {`);
    lines.push(`  beforeAll(async () => { await _initDb(); });`);
    lines.push(`  beforeEach(() => { _reset(); });`);
    lines.push(``);
    for (const group of suite.groups) {
      const alias = (group.modulePath && aliasMap.get(group.modulePath)) ?? "Subject";
      lines.push(...generateGroup(group, "  ", alias));
    }
  } else {
    // Standard namespace import for the primary module
    // For group-level module overrides that are default CRUD exports, use default import
    const defaultCrudOverrides = new Set(
      suite.groups.filter(g => g.moduleIsDefaultCrud && g.modulePath).map(g => g.modulePath!)
    );

    for (const [path, alias] of aliasMap) {
      if (defaultCrudOverrides.has(path)) {
        lines.push(`import ${alias} from ${JSON.stringify(path)};`);
      } else {
        lines.push(`import * as ${alias} from ${JSON.stringify(path)};`);
      }
    }
    // When inline test code uses _SubjectCtor (constructor-pattern modules), import it directly
    // from the resolved source rather than relying on Subject.default (which requires a re-export).
    const hasSubjectCtor = pushImport(lines, facts?.constructorModulePath, "default", "_SubjectCtor");
    // When inline test code uses _PipelineStage (function-chain modules), import it directly.
    // Primary module: check facts directly.
    const pipelineStageImported = pushImport(lines, facts?.pipelineStageModulePath, "namespace", "_PipelineStage");
    if (!pipelineStageImported) {
      // Per-group overrides: scan assertions for _PipelineStage references, use group modulePath
      for (const group of suite.groups) {
        const modulePath = group.modulePath ?? suite.modulePath;
        const hasPipelineCode = group.cases.some(tc => tc.assertion.code?.includes("_PipelineStage."));
        if (hasPipelineCode && pushImport(lines, modulePath, "namespace", "_PipelineStage")) break;
      }
    }

    // Inline lifecycle when the primary module has createDbLifecycle options in AstFacts.
    // This eliminates the need for the module to export initDb/reset -- the adapter wires them up.
    const lcOpts = facts?.lifecycleOptions;
    // isSelfDatabase: the primary module IS the database -- import it as _database directly
    const isSelfDb = facts?.isSelfDatabase;
    // Same decision as hasTopLevelLifecycle above, which is why it is read from there rather
    // than recomputed: what gets emitted and what gets imported must not be able to disagree.
    const hasInlineLifecycle = hasTopLevelLifecycle && !isCrudDefault;
    if (hasInlineLifecycle) {
      pushImport(lines, isSelfDb ? suite.modulePath : facts!.databaseModulePath!, "default", "_database");
      ensureRuntimeImport();
        if (facts?.primaryAction) pushImport(lines, facts.primaryActionModule, "named", [facts.primaryAction]);
      // Derive collections and prefix: explicit lcOpts win; isSelfDatabase defaults to [] and a basename prefix
      const cols   = lcOpts?.collections ?? (isSelfDb ? [] : derivedCollections);
      const prefix = lcOpts?.prefix ?? `lld-${basename(suite.modulePath, extname(suite.modulePath)).toLowerCase().slice(0, 6)}-`;
      const prefixPart = prefix ? `, { prefix: ${JSON.stringify(prefix)} }` : "";
      lines.push(`const { initDb: _initDb, reset: _reset } = createDbLifecycle(_database, ${JSON.stringify(cols)}${prefixPart});`);
    }
    lines.push(``);
    lines.push(`describe(${JSON.stringify(suite.title)}, () => {`);
    if (hasInlineLifecycle) {
      lines.push(`  beforeAll(async () => { await _initDb(); });`);
      lines.push(`  beforeEach(() => { _reset(); });`);
      lines.push(``);
    }
    const primaryAlias = aliasMap.get(suite.modulePath) ?? "Subject";
    for (const group of suite.groups) {
      const alias = (group.modulePath && aliasMap.get(group.modulePath)) ?? "Subject";
      // Lifecycle calls (beforeAll/beforeEach) belong to the primary module even for override groups.
      // When inline lifecycle is active, skip per-group beforeAll/beforeEach for the primary lifecycle.
      const lifecycleAlias = group.modulePath ? primaryAlias : alias;
      lines.push(...generateGroup(group, "  ", alias, lifecycleAlias, hasInlineLifecycle, hasSubjectCtor));
    }
  }

  lines.push(`});`);

  // Mutation testing hands us a mutant copy of the module and expects the suite to run against it.
  // Swapping `suite.modulePath` alone was not enough: the default import comes from AST facts
  // captured at translate time, and a browser claim embeds the module path inside its own assertion
  // code. Both kept pointing at the original file, so `new Subject(...)` -- which the translator
  // rewrites to `_SubjectCtor` -- constructed the *unmutated* class. Every mutant survived, for every
  // document, which reads as "these claims are weak" when the harness was simply never testing them.
  //
  // The substitution happens here, on the finished file, rather than at each emission site. The bug
  // was that one site out of several was missed; a single choke point cannot drift that way again.
  //
  // It is bounded, not a whole-file split/join: only two emission shapes ever carry the module
  // path -- import specifiers (`from "..."`) and browser-claim bootstraps (`inBrowser("..."`), both
  // of which quote it via JSON.stringify. The unbounded version also rewrote the path wherever it
  // appeared inside a claim's own string literals (a description, an expected value), silently
  // corrupting the assertion so it failed against every mutant for a reason the author never wrote.
  const source = lines.join("\n");
  if (!suite.substitutedFor || suite.substitutedFor === suite.modulePath) return source;
  const quoted = JSON.stringify(suite.substitutedFor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(
    new RegExp(`(from |inBrowser\\()${quoted}`, "g"),
    (_, pre) => pre + JSON.stringify(suite.modulePath)
  );
}

function generateGroup(group: TestGroup, indent: string, subjectAlias = "Subject", lifecycleAlias = subjectAlias, suppressLifecycle = false, hasSubjectCtor = false): string[] {
  const lines: string[] = [`${indent}describe(${JSON.stringify(group.name)}, () => {`];
  const inner = indent + "  ";

  if (group.beforeAll && !suppressLifecycle) {
    lines.push(`${inner}beforeAll(async () => { await ${lifecycleAlias}.${group.beforeAll}; });`);
    lines.push(`${inner}`);
  }
  if (group.beforeEach && !suppressLifecycle) {
    lines.push(`${inner}beforeEach(() => { ${lifecycleAlias}.${group.beforeEach}; });`);
    lines.push(`${inner}`);
  }
  if (group.setup) {
    // A `new X(...)` setup constructs the module's default export, not a named export, so it must
    // not be prefixed with the namespace alias -- `Subject.new Toggle({...})` is a syntax error that
    // fails the whole generated file to load.
    const ctorSetup = group.setup.match(/^new\s+\w+\s*\(/);
    const subjectExpr = ctorSetup
      ? group.setup.replace(/^new\s+\w+/, "new _SubjectCtor")
      : `${subjectAlias}.${group.setup}`;
    lines.push(`${inner}let _subject: any;`);
    lines.push(`${inner}beforeEach(() => { _subject = ${subjectExpr}; });`);
    lines.push(`${inner}`);
  }
  // mock-http: install a fetch stub for all tests in this group.
  // Includes status/headers alongside ok/json -- code that branches on response.status or reads
  // response.headers.get(...) (content-type sniffing, etc.) needs a realistic Response shape,
  // not just the { ok, json } pair a bare-minimum stub would provide.
  //
  // A plain mock value is the 200/application/json success body. A *descriptor* -- an object with
  // `body` plus a numeric `status` and/or a string `contentType` -- models a specific response, so a
  // claim can reach an error path or a non-JSON body that a fixed success stub cannot. This mirrors
  // `withMockFetch` in runtime.ts (same descriptor shape); the values are known here at codegen time.
  if (group.mockHttp !== undefined) {
    const mh = group.mockHttp as unknown;
    const isDesc = typeof mh === "object" && mh !== null && "body" in mh
      && (typeof (mh as { status?: unknown }).status === "number"
        || typeof (mh as { contentType?: unknown }).contentType === "string");
    const status = isDesc ? ((mh as { status?: number }).status ?? 200) : 200;
    const contentType = isDesc ? ((mh as { contentType?: string }).contentType ?? "application/json") : "application/json";
    const body = JSON.stringify(isDesc ? (mh as { body: unknown }).body : mh);
    const ok = status < 400;
    // Save and restore rather than delete: `delete global.fetch` removes Bun's own, so a later
    // group in the same generated file that reaches for fetch finds nothing there.
    lines.push(`${inner}let _priorFetch: unknown;`);
    lines.push(`${inner}beforeEach(() => { _priorFetch = (global as any).fetch; (global as any).fetch = () => Promise.resolve({ ok: ${ok}, status: ${status}, headers: new Headers({ "content-type": ${JSON.stringify(contentType)} }), json: () => Promise.resolve(${body}), text: () => Promise.resolve(typeof (${body}) === "string" ? (${body}) : JSON.stringify(${body})), blob: () => Promise.resolve(${body}) }); });`);
    lines.push(`${inner}afterEach(() => { (global as any).fetch = _priorFetch; });`);
    lines.push(`${inner}`);
  }

  for (const tc of group.cases) {
    lines.push(...caseToCode(tc, inner, !!group.setup, subjectAlias, hasSubjectCtor));
    // Perspectives run as sibling tests immediately after their parent
    for (const ptc of tc.perspectives ?? []) {
      lines.push(...caseToCode(ptc, inner, !!group.setup, subjectAlias, hasSubjectCtor));
    }
  }

  lines.push(`${indent}});`);
  return lines;
}

function caseToCode(tc: TestCase, indent: string, hasSetup: boolean, subjectAlias = "Subject", hasSubjectCtor = false): string[] {
  const desc = JSON.stringify(tc.description);

  // A spy assertion needs some way to get the spy into the code under test. A group `**setup:**`
  // is one way -- it builds `_subject` and the spy rides along. A claim that writes `spy` in its
  // own argument list is another, and it needs no setup at all: the declaration is emitted below
  // and the identifier is passed straight to the call. Requiring setup for both turned every
  // module-level callback claim (`GET(url, { onResponse: spy }) -> spy called`) into a todo,
  // which reports as pending -- indistinguishable from "no rule reaches this claim".
  const isSpy = isSpyAssertion(tc);
  if (isSpy && !hasSetup && !reservedArgsUsed(tc).includes("spy")) {
    return [`${indent}it.todo(${desc}); // needs setup to inject spy`];
  }

  if (!hasDirectTest(tc, hasSetup)) return [`${indent}it.todo(${desc});`];

  // Re-derived for branch selection below. `hasDirectTest` decided *whether* a test is emitted;
  // these decide *which* shape it takes, and both are already implied by it.
  const isSchemaDrop      = tc.assertion.type === "schema-drop"      && !!tc.action.method;
  const isFaultResilience = tc.assertion.type === "fault-resilience" && !!tc.action.method;

  // fault-resilience: "a failed X does not stall Y"
  // The helper function body encodes the fault injection using withFaultInjection from runtime.
  // The claim identifies the pattern; the group method provides the callable.
  // Full inline generation requires vocabulary matching to resolve the internal target path.
  if (isFaultResilience && tc.action.method) {
    const fn = hasSetup ? `_subject.${tc.action.method}` : `${subjectAlias}.${tc.action.method}`;
    return [
      `${indent}it(${desc}, async () => {`,
      `${indent}  const result = await ${fn}();`,
      `${indent}  expect(result).toBe(true);`,
      `${indent}});`,
    ];
  }

  // schema-drop: inject a sentinel unknown field, assert it is absent from the result
  // When AST-derived field names are known, also assert declared fields ARE present
  if (isSchemaDrop && tc.action.method) {
    const fn = hasSetup ? `_subject.${tc.action.method}` : `${subjectAlias}.${tc.action.method}`;
    const lines = [
      `${indent}it(${desc}, async () => {`,
      `${indent}  const __r = await ${fn}({ __lld_extra__: "x" });`,
      `${indent}  expect(__r.__lld_extra__).toBeUndefined();`,
    ];
    // Stronger: verify declared fields are present (requires AST field list)
    for (const field of tc.assertion.knownFields ?? []) {
      lines.push(`${indent}  expect(__r).toHaveProperty(${JSON.stringify(field)});`);
    }
    lines.push(`${indent}});`);
    return lines;
  }

  // A method literally named "_subject" means the setup-bound value IS the callable (a
  // function returned by the setup expression, called directly) -- not a "_subject" property
  // on it. Inline call syntax like `_subject("key")` parses its callee text as the method
  // name, so this collision is real whenever a claim calls the bound value by its own name.
  // A method reachable only as a static member of the default-exported class (e.g. a
  // `MyClass.isMyClass`-style static check) isn't on the namespace import (`Subject.method` is
  // undefined -- static members aren't re-exported the way named functions are). Falls back to
  // `_SubjectCtor.method` -- resolved at runtime, not generation time, so it costs nothing when
  // `Subject.method` already works, and only matters for suites that actually imported
  // `_SubjectCtor` (constructor-pattern modules).
  //
  // The choice has to select the RECEIVER, not the detached function -- `(cond ? obj.method :
  // other.method)(args)` calls the extracted reference with `this` unbound, which breaks any
  // method (CRUD object methods routinely do) that reads `this` internally. Selecting between
  // `${subjectAlias}` and `_SubjectCtor` as the receiver keeps the call syntax as
  // `receiver.method(args)`, so `this` stays bound to whichever one is actually used.
  const namespaceCaller = `${subjectAlias}.${tc.action.method}`;
  const staticCaller = hasSubjectCtor
    ? `(typeof ${namespaceCaller} === "function" ? ${subjectAlias} : _SubjectCtor).${tc.action.method}`
    : namespaceCaller;
  const caller = hasSetup
    ? (tc.action.method && tc.action.method !== "_subject")
      ? `_subject.${tc.action.method}`
      : `_subject`
    : staticCaller;

  const callArgs = tc.action.args !== undefined
    ? tc.action.args.map(emitArg).join(", ")
    : tc.action.argDescription
    ? `/* ${tc.action.argDescription} */`
    : "";
  const call = `${caller}(${callArgs})`;
  const lines: string[] = [`${indent}it(${desc}, async () => {`];

  for (const step of tc.setup) {
    lines.push(`${indent}  // ${step.type}: ${step.description}`);
  }

  // Reserved handler bindings (`spy`, `thrower`) must exist before any call that registers them.
  for (const name of reservedArgsUsed(tc)) {
    lines.push(`${indent}  ${RESERVED_ARGS[name].declare}`);
  }

  // repeat prefix → run setup loop N times, then assert on the N+1th call
  const repeat = tc.action.repeat;
  if (repeat) {
    lines.push(`${indent}  for (let _i = 0; _i < ${repeat}; _i++) {`);
    lines.push(`${indent}    try { await ${call}; } catch {}`);
    lines.push(`${indent}  }`);
  }

  // Captures mode: bind result, optionally run second call, emit assertion code
  if (tc.action.captures) {
    lines.push(`${indent}  const ${tc.action.captures} = await ${call};`);
    // Each chained call in written order. Every capture is bound before the next call is emitted,
    // so a later call can reference an earlier one by name ("create(A) captures r then
    // update({ id: r.id })") and so the emitted sequence matches the order the claim states.
    for (const ec of tc.action.extraCalls ?? []) {
      const ecArgs = ec.args !== undefined
        ? ec.args.map(emitArg).join(", ")
        : "";
      const ecNamespaceCaller = `${subjectAlias}.${ec.method}`;
      const ecStaticCaller = hasSubjectCtor
        ? `(typeof ${ecNamespaceCaller} === "function" ? ${subjectAlias} : _SubjectCtor).${ec.method}`
        : ecNamespaceCaller;
      const ecCaller = hasSetup
        ? (ec.method !== "_subject" ? `_subject.${ec.method}` : `_subject`)
        : ecStaticCaller;
      lines.push(`${indent}  const ${ec.captures} = await ${ecCaller}(${ecArgs});`);
    }
    if (tc.assertion.type === "inspect" && tc.assertion.code) {
      // Strip a leading duplicate captures binding from the inspect code. An AST pattern that
      // builds a self-contained inspect body can open with "const <captures> = await call; ..."
      // while captures is already bound on the line above -- emitting both is a duplicate
      // declaration and the generated file won't compile.
      const cap = tc.action.captures;
      const dupePat = new RegExp(`^\\s*const\\s+${cap}\\s*=\\s*await[^;]+;\\s*`);
      const cleanCode = tc.assertion.code.replace(dupePat, "");
      if (cleanCode.trim()) lines.push(`${indent}  ${cleanCode}`);
    } else if (isSpy) {
      // A chained claim that registered `spy` itself: the calls above already subscribed and
      // triggered in the order the author wrote, so assert on the spy directly rather than
      // re-subscribing it the way the unchained path has to.
      lines.push(`${indent}  ${spyExpectation(tc)}`);
    } else if (tc.assertion.type !== "resolves") {
      // Every other assertion type reaching here would emit a body with no `expect` in it, and
      // bun reports an expectation-free test as passing -- a green with nothing behind it, which
      // is the one outcome this file must never produce. No grammar path currently gets here
      // (`captures` forces inspect-style outcome matching, and every AST pattern that sets
      // `captures` also sets `inspectCode`), so this is a guard on future edits, not a live bug.
      // `resolves` is excluded because it is already honestly proven: the `await`s above throw
      // out of the test if the call fails.
      throw new Error(
        `bunRunner: no assertion emitted for captures + "${tc.assertion.type}" -- ` +
        `this would generate a test that passes without checking anything (claim: ${tc.description})`
      );
    }
    lines.push(`${indent}});`);
    return lines;
  }

  // Standard assertion. A spy claim that named `spy` in its own call has already registered it;
  // the auto-subscribing path below would declare a second `_spy` and shadow the author's.
  if (isSpy && reservedArgsUsed(tc).includes("spy")) {
    // Awaited: a callback registered on an async call fires after the call settles, and asserting
    // on the spy in the same tick asks whether it was called before it could have been. The
    // negative form (`not called`) passed either way, which is the worse half of the bug -- it
    // would have gone on passing for a handler that was in fact called.
    lines.push(`${indent}  await ${call};`);
    lines.push(`${indent}  ${spyExpectation(tc)}`);
    lines.push(`${indent}});`);
    return lines;
  }

  lines.push(...assertionCode(tc, call, indent + "  ", subjectAlias));
  lines.push(`${indent}});`);
  return lines;
}

function assertionCode(tc: TestCase, call: string, indent: string, subjectAlias: string): string[] {
  const a = tc.assertion;

  switch (a.type) {
    case "throws": {
      // When the claim names a specific error class ("-> `CartError`"), verify THAT class was
      // thrown, not just that something was -- a bare .toThrow() can't distinguish the declared
      // error from an unrelated one (e.g. a removed guard letting a later line throw a plain
      // TypeError instead), so a real regression can hide behind a still-green test. Guarded at
      // runtime (not assumed at generation time) since the class must be a real, exported member
      // of the subject module to safely reference here -- if it isn't, `.toThrow(undefined)`
      // degrades to the same untargeted check this replaces, never a new false failure.
      if (a.errorClass) {
        const ref = `${subjectAlias}.${a.errorClass}`;
        return [`${indent}await expect(async () => { await ${call}; }).toThrow(typeof ${ref} === "function" ? ${ref} : undefined); // expected: ${a.errorClass}`];
      }
      return [`${indent}await expect(async () => { await ${call}; }).toThrow();`];
    }

    case "equals": {
      const lines = [
        `${indent}const _result = await ${call};`,
        `${indent}expect(_result).toEqual(${JSON.stringify(a.expected)});`,
      ];
      for (const neg of a.negations ?? []) lines.push(`${indent}expect(_result).not.toBe(${emitNeg(neg)});`);
      return lines;
    }

    case "resolves":
      return [`${indent}await expect(async () => { await ${call}; }).not.toThrow();`];

    case "shape":
    case "property": {
      if (a.description === "allowed") {
        const lines = [
          `${indent}const _result = await ${call};`,
          `${indent}expect(_result.allowed).toBe(${JSON.stringify(a.expected ?? true)});`,
        ];
        for (const neg of a.negations ?? []) lines.push(`${indent}expect(_result).not.toBe(${emitNeg(neg)});`);
        return lines;
      }
      if (a.description === "typeof-function") {
        return [
          `${indent}const _result = await ${call};`,
          `${indent}expect(typeof _result).toBe("function");`,
        ];
      }
      if (a.description === "typeof-object") {
        return [
          `${indent}const _result = await ${call};`,
          `${indent}expect(_result).not.toBeNull();`,
          `${indent}expect(typeof _result).toBe("object");`,
        ];
      }
      const lines = [
        `${indent}const _result = await ${call};`,
        `${indent}expect(_result).toBeDefined(); // ${a.description ?? ""}`,
      ];
      for (const neg of a.negations ?? []) lines.push(`${indent}expect(_result).not.toBe(${emitNeg(neg)});`);
      return lines;
    }

    case "called": {
      const count = a.callCount;
      return spyLines(tc, call, indent, count ? `toHaveBeenCalledTimes(${count})` : "toHaveBeenCalled()");
    }

    case "calledWith": {
      // The event the spy should have received is the last argument of the claim's own call --
      // `publish("topic", evt)` on a topic-keyed bus, `notify(evt)` on a topic-less one. When the
      // claim names no arguments there is nothing to compare against; the old `_event = {}`
      // placeholder is kept for that case precisely because the call never publishes it, so the
      // claim fails honestly instead of asserting against a value the author never wrote.
      const args = tc.action.args;
      const eventExpr = args && args.length > 0 ? emitArg(args[args.length - 1]) : "_event";
      return [
        `${indent}const _spy = mock(() => {});`,
        ...(eventExpr === "_event" ? [`${indent}const _event = {};`] : []),
        `${indent}subscribeSpy(_subject, _spy, ${spyTopic(tc)});`,
        `${indent}${call};`,
        `${indent}expect(_spy).toHaveBeenCalledWith(${eventExpr});`,
      ];
    }

    case "notCalled": {
      return [
        `${indent}const _spy = mock(() => {});`,
        `${indent}const _sub = subscribeSpy(_subject, _spy, ${spyTopic(tc)});`,
        `${indent}_sub.unsubscribe();`,
        `${indent}${call};`,
        `${indent}expect(_spy).not.toHaveBeenCalled();`,
      ];
    }

    case "inspect": {
      if (a.code) {
        // Same invariant the captures path enforces: a body with no expect(...) in it passes
        // without checking anything. Every inspect-code producer emits one today, so like its
        // sibling this guards future edits structurally rather than fixing a live bug.
        if (!/\bexpect\s*\(/.test(a.code)) {
          throw new Error(
            `bunRunner: inspect code contains no expect() -- ` +
            `this would generate a test that passes without checking anything (claim: ${tc.description})`
          );
        }
        const codeLines = a.code.split("\n").map(line => `${indent}${line.trim()}`).filter(Boolean);
        // If the code references _result, it needs a binding first
        if (a.code.includes("_result")) {
          return [`${indent}const _result = await ${call};`, ...codeLines];
        }
        // Otherwise it's a self-contained body
        return codeLines;
      }
      return [`${indent}expect(await ${call}).toBeDefined();`];
    }

    case "contains": {
      // Substring / marker assertion: result (or result.field) contains a string
      // "→ contains "text"" -- expected is the substring; negations["contains"] → .not.toContain
      const isNegated = a.negations?.includes("contains");
      const target = `await ${call}`;
      if (typeof a.expected === "string") {
        const matcher = isNegated ? "not.toContain" : "toContain";
        return [`${indent}expect(${target}).${matcher}(${JSON.stringify(a.expected)});`];
      }
      // No specific string -- just assert the result is a string that can be inspected
      return [
        `${indent}const _result = await ${call};`,
        `${indent}expect(typeof _result === "string" || (typeof _result === "object" && _result !== null)).toBe(true); // verify output is inspectable for sentinel`,
      ];
    }

    case "absent": {
      // Field is absent / undefined / null -- conditional presence assertion
      // When used with captures: asserting result.field is undefined/null
      // When used on a direct call: asserting the result itself is null/undefined
      const target = `await ${call}`;
      return [
        `${indent}const _result = ${target};`,
        `${indent}expect(_result == null).toBe(true); // field is absent (undefined or null)`,
      ];
    }

    default:
      return [`${indent}expect(await ${call}).toBeDefined(); // unknown assertion type`];
  }
}

/** The channel a spy should be attached to, so it lands where the claim's own call publishes.
 *
 *  This is the channel the old implementation lacked. "handler called" / "called with" / "not
 *  called" assumed a topic-less `subscribe(handler)` shape (the common EventTarget-style case);
 *  a topic-keyed `subscribe(topic, handler)` API received the spy in the `topic` position, left
 *  the handler position undefined, and so the spy legitimately never fired -- the claim failed on
 *  a premise its author never wrote. eventBus's `createEventBus()` is what surfaced it.
 *
 *  The claim's first argument is the topic for any call shaped `publish(topic, event)`. Whether
 *  it is *used* as one is decided at runtime by `subscribeSpy`, off the implementation's own
 *  `subscribe.length` -- so a topic-less subscribe ignores it and keeps its previous behavior
 *  exactly, and neither shape needs the author to say which one they have. */
function spyTopic(tc: TestCase): string {
  const first = tc.action.args?.[0];
  return first === undefined ? "undefined" : emitArg(first);
}

function spyLines(tc: TestCase, call: string, indent: string, matcher: string): string[] {
  return [
    `${indent}const _spy = mock(() => {});`,
    `${indent}subscribeSpy(_subject, _spy, ${spyTopic(tc)});`,
    `${indent}${call};`,
    `${indent}expect(_spy).${matcher};`,
  ];
}

/** The bare expectation for a spy assertion, with no subscribe of its own.
 *
 *  Used when the claim registered `spy` through its own call chain -- there the ordering of
 *  subscribe and publish *is* the claim ("subscribing after a publish receives nothing"), so
 *  the runner must not insert a subscribe of its own and quietly reorder it. */
function spyExpectation(tc: TestCase): string {
  const a = tc.assertion;
  if (a.type === "notCalled") return `expect(_spy).not.toHaveBeenCalled();`;
  if (a.type === "calledWith") {
    // The event is the last argument of the last call in the chain -- for a spy claim that is
    // the publish/notify step, whatever number of setup calls preceded it.
    const chain = tc.action.extraCalls ?? [];
    const args = (chain.length > 0 ? chain[chain.length - 1].args : undefined) ?? tc.action.args;
    const evt = args && args.length > 0 ? emitArg(args[args.length - 1]) : "undefined";
    return `expect(_spy).toHaveBeenCalledWith(${evt});`;
  }
  return a.callCount
    ? `expect(_spy).toHaveBeenCalledTimes(${a.callCount});`
    : `expect(_spy).toHaveBeenCalled();`;
}

// ── Output parsing ────────────────────────────────────────────────────

function parseOutput(suite: TestSuite, output: string, duration: number, exitCode: number): RunResult {
  // Every claim reported as failed, with `crashed` set -- the module is broken so nothing was
  // verified. "failed" and "crashed" are not the same fact: mutation testing needs the difference
  // (see RunResult.crashed), and the reporter uses `error` to say *why* instead of showing a wall
  // of bare failures.
  function crashAll(reason?: string): RunResult {
    const allFailed = suite.groups.flatMap(g => g.cases.map(tc => ({
      description: tc.description, status: "fail" as const,
      perspectives: (tc.perspectives ?? []).map(p => ({ description: p.description, status: "fail" as const })),
    })));
    return { suiteName: suite.title, modulePath: suite.modulePath, passed: 0, indirect: 0, shallow: 0,
      failed: allFailed.length, pending: 0, cases: allFailed, duration, crashed: true, error: reason };
  }

  // A short reason pulled from bun's error block, for the crash report.
  function crashReason(): string | undefined {
    const m = output.match(/error: (Cannot find module .*|Could not resolve .*)/i)
      || output.match(/(Unhandled error between tests)/i);
    const reason = m?.[1]?.trim();
    // A DOM suite on a machine without the registrator dies on resolving
    // "@happy-dom/global-registrator", and the generic reason reads as the user's module being
    // broken. It is lldtdd's own optional peer dependency, so name the real cause and the fix.
    if (reason && /(Cannot find module|Could not resolve).*@happy-dom\/global-registrator/i.test(reason)) {
      return "missing @happy-dom/global-registrator, lldtdd's optional peer dependency for DOM component claims"
        + " -- install it with `bun add -d @happy-dom/global-registrator`";
    }
    return reason;
  }

  // bun only prints individual lines for (fail) -- passing tests are in the summary only.
  // When a module-level error occurs ("Unhandled error between tests", an unresolved import, a
  // syntax error), bun emits 0 pass/0 fail with an error block and no test ever runs.
  const hasModuleCrash = /Unhandled error between tests/i.test(output)
    || /error: (?:Cannot find module|Could not resolve)/i.test(output)
    || /0 pass\s*\n.*0 fail\s*\n.*1 error/s.test(output);
  if (hasModuleCrash) return crashAll(crashReason());

  const failed = new Set<string>();
  const errorByDesc = new Map<string, string>();

  // Failure lines are matched against the descriptions this suite actually generated, rather than
  // split on " > " and hoping the tail is the test name.
  //
  // Bun prints `(fail) <describe> > <test>`, and splitting on the last " > " looked equivalent right
  // up until a claim contained that sequence itself. A scenario asserting
  // `i.elem.offsetHeight > before` was recorded under the description "before", matched nothing, and
  // -- because a case with a test is otherwise assumed to have passed -- the claim was reported green
  // while its assertion was failing. Matching against known descriptions cannot make that mistake:
  // the longest one that the line ends with is the test that failed.
  const knownDescriptions = allCases(suite)
    .map(tc => tc.description)
    .sort((a, b) => b.length - a.length);

  // A line that carries no signal for a human reading a failure: bun's source echo (`8 | ...`),
  // its caret pointer, stack frames, the file header, and the run/summary lines. Everything left
  // between one failure and the previous is the error itself (`error: expect(...).toBe`, the
  // Expected/Received pair, or a thrown message).
  const isNoise = (t: string): boolean =>
    !t || /^\d+\s*\|/.test(t) || /^\^+$/.test(t) || /^at\s/.test(t)
    || /\.tsx?:\s*$/.test(t) || /^bun test v/.test(t)
    || /^\d+\s+(?:pass|fail|todo|skip)\b/.test(t) || /^Ran \d+ test/.test(t);
  const isBoundary = (t: string): boolean =>
    /^\(fail\)/.test(t) || /^\d+\s+(?:pass|fail|todo|skip)\b/.test(t)
    || /\.tsx?:\s*$/.test(t) || /^bun test v/.test(t);

  const lines = output.split("\n");
  const unmatchedFailures: string[] = [];
  let prevFail = -1;
  for (let i = 0; i < lines.length; i++) {
    const fail = lines[i].trim().match(/^\(fail\)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?m?s\])?$/);
    if (!fail) continue;
    const name = fail[1].trim();
    const match = knownDescriptions.find(d => name === d || name.endsWith(` > ${d}`));
    if (!match) { unmatchedFailures.push(name); prevFail = i; continue; }
    failed.add(match);
    // bun prints a failure's detail *above* its (fail) line, so the block runs from just after the
    // previous failure up to this one. Scan that window forward, drop the noise, keep the message,
    // cap it -- the reporter shows the expected/received, not a trace.
    const block: string[] = [];
    for (let j = prevFail + 1; j < i && block.length < 4; j++) {
      const t = lines[j].trim();
      if (isBoundary(t) || isNoise(t)) continue;
      block.push(t);
    }
    if (block.length && !errorByDesc.has(match)) errorByDesc.set(match, block.join("\n"));
    prevFail = i;
  }

  // The primary pass signal is the *absence* of a (fail) line, so the danger this parser guards
  // against is a failure it never saw being reported as a pass. Three ways that can happen, all
  // escalated to a loud crash rather than a silent green:
  //   1. a (fail) line whose test name matched no known description
  //   2. bun's own summary counts more failures than we attributed (its (fail) format changed)
  //   3. the process exited nonzero and we attributed nothing that would explain it
  const reportedFailMatch = output.match(/^\s*(\d+)\s+fail\b/m);
  const reportedFail = reportedFailMatch ? parseInt(reportedFailMatch[1], 10) : null;
  const reportedPassMatch = output.match(/^\s*(\d+)\s+pass\b/m);
  const reportedPass = reportedPassMatch ? parseInt(reportedPassMatch[1], 10) : null;
  if (unmatchedFailures.length > 0) return crashAll();
  if (reportedFail !== null && reportedFail > failed.size) return crashAll();
  if (exitCode !== 0 && failed.size === 0 && (reportedFail === null || reportedFail === 0)) {
    return crashAll(crashReason() ?? `bun test exited ${exitCode} with no attributable failure`);
  }

  // Fewer tests ran than were generated -- the suite did not finish. The exit-nonzero guard above
  // misses the worst case of this: a subject module that calls `process.exit(0)` at import (or any
  // early clean exit) makes `bun test` exit 0 having run *nothing*, and with no (fail) line the cases
  // below would otherwise be reported as passed. A green a CI gate cannot tell from success is the
  // exact failure this tool exists to refuse, so a run that did not execute every test it emitted is
  // a crash, not a pass. `hasDirectTest` is the same predicate the generator uses to decide `it()`
  // vs `it.todo()`, so this counts precisely the tests that were meant to execute.
  let expectedRun = 0;
  for (const g of suite.groups) {
    const setup = !!g.setup;
    for (const tc of g.cases) {
      if (hasDirectTest(tc, setup)) expectedRun++;
      for (const p of tc.perspectives ?? []) if (hasDirectTest(p, setup)) expectedRun++;
    }
  }
  const reportedRun = (reportedPass ?? 0) + (reportedFail ?? 0);
  if (expectedRun > 0 && reportedRun < expectedRun) {
    return crashAll(crashReason() ?? `bun test ran ${reportedRun} of ${expectedRun} generated tests -- the suite exited before finishing (a subject that calls process.exit at import does this)`);
  }

  // A passing assertion that verifies almost nothing. Two shapes reach here:
  //   - a bare `-> resolves` (no value, no error class, no shape) -- green for any implementation
  //     that runs at all. `resolves with {shape}` keeps a description and is not this.
  //   - a `contains`/sentinel claim with no concrete substring: the emitted check only confirms the
  //     result is a string or object, so it is green for any inspectable return. A claim that names
  //     a marker but no marker text has not been verified to contain it.
  // Both read as `◐ shallow`, not a full green. See CaseStatus.shallow.
  const isNoThrowOnly = (a: AssertionStep): boolean =>
    (a.type === "resolves" && !a.description && !(a.negations && a.negations.length > 0)) ||
    (a.type === "contains" && typeof a.expected !== "string");

  function caseResult(tc: TestCase, setup: boolean): CaseResult {
    // Same predicate the generator used, so "no result reported" can only ever mean the one thing.
    const direct = hasDirectTest(tc, setup);
    const hasPerspectives = (tc.perspectives?.length ?? 0) > 0;

    const perspectives = tc.perspectives?.map(p => caseResult(p, setup));
    const perspectivesAnyFail = perspectives?.some(p => p.status === "fail") ?? false;
    const perspectivesPending = perspectives?.some(p => p.status === "pending") ?? false;
    // The claim's evidence base is entirely no-throw only when every perspective carrying it is.
    const perspectivesAllShallow = !!perspectives?.length && perspectives.every(p => p.status === "shallow");

    if (!direct && !hasPerspectives) {
      return { description: tc.description, status: "pending", perspectives };
    }

    if (!direct) {
      // No test of this claim; its perspectives carry all the evidence. Reported as `indirect`
      // rather than `pass` so the distinction survives into the output -- but if every perspective
      // is itself a no-throw check, the claim's whole evidence base is shallow, and it says so.
      const status: CaseStatus = perspectivesAnyFail ? "fail"
        : perspectivesPending ? "pending"
        : perspectivesAllShallow ? "shallow"
        : "indirect";
      return { description: tc.description, status, perspectives };
    }

    // Has direct test; a failing perspective also fails the claim. A passing claim whose own
    // assertion is no-throw-only is `shallow`, not `pass` -- a real green that verifies nothing but
    // "it ran". A stronger perspective does not launder that: the claim's *own* test still checked
    // only no-throw, and the perspective rows carry their own (stronger) status beside it.
    if (failed.has(tc.description) || perspectivesAnyFail) {
      const error = failed.has(tc.description) ? errorByDesc.get(tc.description) : undefined;
      return { description: tc.description, status: "fail", error, perspectives };
    }
    const status: CaseStatus = isNoThrowOnly(tc.assertion) ? "shallow" : "pass";
    return { description: tc.description, status, perspectives };
  }

  const cases: CaseResult[] = suite.groups.flatMap(g =>
    g.cases.map(tc => caseResult(tc, !!g.setup))
  );

  // Count includes perspectives
  function countStatus(results: CaseResult[], s: CaseResult["status"]): number {
    return results.reduce((n, c) => {
      const self = c.status === s ? 1 : 0;
      const nested = countStatus(c.perspectives ?? [], s);
      return n + self + nested;
    }, 0);
  }

  return {
    suiteName: suite.title,
    modulePath: suite.modulePath,
    passed: countStatus(cases, "pass"),
    failed: countStatus(cases, "fail"),
    pending: countStatus(cases, "pending"),
    indirect: countStatus(cases, "indirect"),
    shallow: countStatus(cases, "shallow"),
    cases,
    duration,
  };
}

// Emit a negation value for `.not.toBe(X)` -- handles null/undefined/boolean keywords
function emitNeg(s: string): string {
  const t = s.trim().toLowerCase();
  if (t === "null") return "null";
  if (t === "undefined") return "undefined";
  if (t === "true") return "true";
  if (t === "false") return "false";
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^an?\s+empty\s+object$/i.test(s)) return "{}";
  return JSON.stringify(s);
}

/** Reserved argument identifiers: the callbacks a claim needs to *name* but can't write.
 *
 *  A claim about a callback API has to talk about the handler it registers -- "a throwing handler
 *  does not stop the next one", "subscribing after a publish receives nothing". The handler is
 *  the subject of the claim, so the document has to be able to say it, but an `.lld.md` file is
 *  not a place to write function bodies: the moment a claim carries real code it stops being a
 *  design statement and becomes a test, which is the line this whole format exists to hold.
 *
 *  Two names, both fixed, both meaning exactly one thing:
 *    spy      a recording no-op -- ask whether it was called, and with what
 *    thrower  a handler that throws -- the fault a resilience claim is about
 *
 *  They stay a closed set on purpose: "any identifier becomes a mock" would make the derived
 *  suite stop being a function of documented rules.
 *
 *  What it does not do is keep code out of a document. `parser.ts` emits an argument it cannot
 *  parse as an `__expr` passthrough, and scenario steps are emitted verbatim by design -- a
 *  document that says `new Thing()` gets `new Thing()`. Keeping this list short is about the
 *  derivation staying predictable, not about containment: an `.lld.md` is executable input, and
 *  the README says so where a reader will see it before running one. */
const RESERVED_ARGS: Record<string, { binding: string; declare: string }> = {
  spy:     { binding: "_spy",     declare: `const _spy = mock(() => {});` },
  thrower: { binding: "_thrower", declare: `const _thrower = () => { throw new Error("lld: handler failure"); };` },
};

/** Matches a reserved identifier used as a value: not a property key (`spy:`), not a member
 *  access (`x.spy`), not part of a longer word (`spyOn`). */
function reservedNameUsedAsValue(name: string, expr: string): boolean {
  return new RegExp(`(?<![.\\w])${name}\\b(?!\\s*:)`).test(expr);
}

/** Reserved identifiers this case names, in declaration order, deduplicated.
 *
 *  An argument reaches here either as the bare identifier or buried in an expression -- a callback
 *  is normally written as one property of an options object (`{ enabled: false, onResponse: spy }`),
 *  and an object holding a bare identifier is not JSON, so the parser hands the whole literal
 *  through as one expression. Scanning only the top level missed those, and the emitted call then
 *  referenced a `spy` that was never declared. */
function reservedArgsUsed(tc: TestCase): string[] {
  const seen = new Set<string>();
  const scan = (args: unknown[] | undefined) => {
    for (const a of args ?? []) {
      if (typeof a === "object" && a !== null && "__expr" in a) {
        const expr = (a as { __expr: string }).__expr;
        if (expr in RESERVED_ARGS) { seen.add(expr); continue; }
        for (const name of Object.keys(RESERVED_ARGS)) {
          if (reservedNameUsedAsValue(name, expr)) seen.add(name);
        }
      }
    }
  };
  scan(tc.action.args);
  for (const ec of tc.action.extraCalls ?? []) scan(ec.args);
  return [...seen];
}

function emitArg(a: unknown): string {
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  if (typeof a === "object" && a !== null && "__expr" in a) {
    const expr = (a as { __expr: string }).__expr;
    if (RESERVED_ARGS[expr]) return RESERVED_ARGS[expr].binding;
    // The identifier can also sit inside a larger expression, most often as one property of an
    // options object. Rewrite it to the declared binding there too, or the emitted call names
    // something that does not exist.
    let out = expr;
    for (const [name, { binding }] of Object.entries(RESERVED_ARGS)) {
      if (reservedNameUsedAsValue(name, out)) {
        out = out.replace(new RegExp(`(?<![.\\w])${name}\\b(?!\\s*:)`, "g"), binding);
      }
    }
    return out;
  }
  if (Array.isArray(a)) return `[${a.map(emitArg).join(", ")}]`;
  return JSON.stringify(a);
}


function allPending(suite: TestSuite, duration: number): RunResult {
  function pendingCase(tc: TestCase): CaseResult {
    return {
      description: tc.description,
      status: "pending",
      perspectives: tc.perspectives?.map(pendingCase),
    };
  }
  const cases: CaseResult[] = suite.groups.flatMap(g => g.cases.map(pendingCase));
  const pending = cases.reduce((n, c) => n + 1 + (c.perspectives?.length ?? 0), 0);
  return { suiteName: suite.title, modulePath: suite.modulePath, passed: 0, failed: 0, indirect: 0, shallow: 0, pending, cases, duration };
}
