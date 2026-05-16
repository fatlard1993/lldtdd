import { writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, extname, dirname } from "path";
import { tmpdir } from "os";
import type { Adapter, AdapterOptions } from "./interface.ts";
import type { TestSuite, TestGroup, TestCase, RunResult, CaseResult } from "../types.ts";

export class BunAdapter implements Adapter {
  readonly name = "bun";

  async run(suite: TestSuite, _options: AdapterOptions = {}): Promise<RunResult> {
    const moduleExists = suite.modulePath.length > 0 && existsSync(suite.modulePath);
    const start = Date.now();

    if (!moduleExists) return allPending(suite, Date.now() - start);

    const tmpFile = join(tmpdir(), `lldtdd-${Date.now()}.test.ts`);

    try {
      const _gen = generateTestFile(suite);
      await writeFile(tmpFile, _gen);
      if (process.env.LLDTDD_DEBUG_GEN) await writeFile(process.env.LLDTDD_DEBUG_GEN, _gen);

      const proc = Bun.spawn(["bun", "test", "--timeout", "120000", tmpFile], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      });

      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      return parseOutput(suite, out + err, Date.now() - start);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  }
}

// ── Code generation ───────────────────────────────────────────────────

// Build a stable alias name for a module path: "lld/helpers/bookmarks.js" → "Bookmarks"
function moduleAlias(path: string): string {
  const stem = basename(path, extname(path));
  return stem.charAt(0).toUpperCase() + stem.slice(1).replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

function generateTestFile(suite: TestSuite): string {
  const needsMock = suite.groups.some(g =>
    g.cases.some(tc =>
      tc.assertion.type === "called" ||
      tc.assertion.type === "calledWith" ||
      tc.assertion.type === "notCalled" ||
      (tc.assertion.type === "inspect" && tc.assertion.code?.includes("mock("))
    )
  );
  // Detect if the primary module is a default-exporting CRUD module
  // If so: default import, inline lifecycle, inline EntityRegistry
  const facts = suite.moduleAstFacts;
  const isCrudDefault = facts?.isDefaultCrud && suite.modulePath.length > 0;

  // isCrudDefault, lifecycleOptions, and isSelfDatabase all emit top-level beforeAll + beforeEach
  const isSelfDbEarly = facts?.isSelfDatabase;
  const hasTopLevelLifecycle = isCrudDefault || !!facts?.lifecycleOptions || !!isSelfDbEarly;
  const needsBeforeAll  = hasTopLevelLifecycle || suite.groups.some(g => !!g.beforeAll);
  const needsBeforeEach = hasTopLevelLifecycle || suite.groups.some(g => !!g.beforeEach || !!g.setup);
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

  const lines: string[] = [
    `import { ${imports.join(", ")} } from "bun:test";`,
  ];

  if (isCrudDefault) {
    // Default import for the CRUD object (Subject.create, Subject.read, etc.)
    lines.push(`import Subject from ${JSON.stringify(suite.modulePath)};`);

    // Import related entity modules detected from FK relationships
    const relatedPaths = facts?.relatedEntityPaths ?? {};
    for (const [entity, path] of Object.entries(relatedPaths)) {
      if (existsSync(path)) lines.push(`import _${entity} from ${JSON.stringify(path)};`);
    }

    // Import database module for lifecycle
    if (facts?.databaseModulePath && existsSync(facts.databaseModulePath)) {
      lines.push(`import _database from ${JSON.stringify(facts.databaseModulePath)};`);
    }

    // Inline runtime utilities needed
    const runtimePath = new URL("../runtime.ts", import.meta.url).pathname;
    const fixturesPath = new URL("../fixtures.ts", import.meta.url).pathname;
    lines.push(`import { createDbLifecycle, createEntityRegistry, withSeedAndRead, withIsolationTest, withFaultInjection, withOrderTracking, withSchemaEvolution, withShapeComparison, withMockFetch } from ${JSON.stringify(runtimePath)};`);
    lines.push(`import { ENTITY_FIXTURES, FIELD_VALUES } from ${JSON.stringify(fixturesPath)};`);
    // Import primaryAction from its module if known (e.g. searchProvider from utils/search.js)
    if (facts?.primaryAction && facts?.primaryActionModule && existsSync(facts.primaryActionModule)) {
      lines.push(`import { ${facts.primaryAction} } from ${JSON.stringify(facts.primaryActionModule)};`);
    }

    // Inline lifecycle
    const collections = facts?.entityTypes.filter(e => existsSync(facts?.relatedEntityPaths[e] ?? "")).concat([facts?.schemas[0]?.collection ?? ""].filter(Boolean)) ?? [];
    const allCollections = [...new Set([facts?.schemas[0]?.collection, ...Object.values(relatedPaths).map(p => basename(p, ".js"))].filter(Boolean))];
    lines.push(`const { initDb: _initDb, reset: _reset } = createDbLifecycle(_database, ${JSON.stringify(allCollections)});`);

    // Inline EntityRegistry
    const registryEntries = [`"${facts?.schemas[0]?.collection?.replace(/s$/, "") ?? "entity"}": Subject`];
    for (const [entity] of Object.entries(relatedPaths)) {
      registryEntries.push(`"${entity}": _${entity}`);
    }
    lines.push(`const _registry = createEntityRegistry({ ${registryEntries.join(", ")} });`);

    lines.push(``);

    // Generate the describe block with top-level lifecycle for the default CRUD case
    // _initDb and _reset are local consts — call them directly, not as Subject methods
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
    if (facts?.constructorModulePath && existsSync(facts.constructorModulePath)) {
      lines.push(`import _SubjectCtor from ${JSON.stringify(facts.constructorModulePath)};`);
    }
    // When inline test code uses _PipelineStage (function-chain modules), import it directly.
    // Primary module: check facts directly.
    if (facts?.pipelineStageModulePath && existsSync(facts.pipelineStageModulePath)) {
      lines.push(`import * as _PipelineStage from ${JSON.stringify(facts.pipelineStageModulePath)};`);
    } else {
      // Per-group overrides: scan assertions for _PipelineStage references, use group modulePath
      for (const group of suite.groups) {
        const modulePath = group.modulePath ?? suite.modulePath;
        const hasPipelineCode = group.cases.some(tc => tc.assertion.code?.includes("_PipelineStage."));
        if (hasPipelineCode && existsSync(modulePath)) {
          lines.push(`import * as _PipelineStage from ${JSON.stringify(modulePath)};`);
          break;
        }
      }
    }

    // Inline lifecycle when the primary module has createDbLifecycle options in AstFacts.
    // This eliminates the need for the module to export initDb/reset — the adapter wires them up.
    const lcOpts = facts?.lifecycleOptions;
    // isSelfDatabase: the primary module IS the database — import it as _database directly
    const isSelfDb = facts?.isSelfDatabase;
    // hasInlineLifecycle: either explicit lifecycle options OR isSelfDatabase (which implies
    // collections=[] and a derived prefix — no __lld_lifecycle annotation needed)
    const hasInlineLifecycle = !!(isSelfDb || (lcOpts && (facts?.databaseModulePath && existsSync(facts.databaseModulePath))));
    if (hasInlineLifecycle) {
      const runtimePath = new URL("../runtime.ts", import.meta.url).pathname;
      const fixturesPath = new URL("../fixtures.ts", import.meta.url).pathname;
      if (isSelfDb) {
        lines.push(`import _database from ${JSON.stringify(suite.modulePath)};`);
      } else {
        lines.push(`import _database from ${JSON.stringify(facts!.databaseModulePath!)};`);
      }
      lines.push(`import { createDbLifecycle, createEntityRegistry, withSeedAndRead, withIsolationTest, withFaultInjection, withOrderTracking, withSchemaEvolution, withShapeComparison, withMockFetch } from ${JSON.stringify(runtimePath)};`);
      lines.push(`import { ENTITY_FIXTURES, FIELD_VALUES } from ${JSON.stringify(fixturesPath)};`);
      if (facts?.primaryAction && facts?.primaryActionModule && existsSync(facts.primaryActionModule)) {
        lines.push(`import { ${facts.primaryAction} } from ${JSON.stringify(facts.primaryActionModule)};`);
      }
      // Derive collections and prefix: explicit lcOpts win; isSelfDatabase defaults to [] and a basename prefix
      const cols   = lcOpts?.collections ?? [];
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
      lines.push(...generateGroup(group, "  ", alias, lifecycleAlias, hasInlineLifecycle));
    }
  }

  lines.push(`});`);
  return lines.join("\n");
}

function generateGroup(group: TestGroup, indent: string, subjectAlias = "Subject", lifecycleAlias = subjectAlias, suppressLifecycle = false): string[] {
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
    lines.push(`${inner}let _subject: any;`);
    lines.push(`${inner}beforeEach(() => { _subject = ${subjectAlias}.${group.setup}; });`);
    lines.push(`${inner}`);
  }
  // mock-http: install a fetch stub for all tests in this group
  if (group.mockHttp !== undefined) {
    const body = JSON.stringify(group.mockHttp);
    lines.push(`${inner}beforeEach(() => { (global as any).fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(${body}) }); });`);
    lines.push(`${inner}afterEach(() => { delete (global as any).fetch; });`);
    lines.push(`${inner}`);
  }

  for (const tc of group.cases) {
    lines.push(...caseToCode(tc, inner, !!group.setup, subjectAlias));
    // Perspectives run as sibling tests immediately after their parent
    for (const ptc of tc.perspectives ?? []) {
      lines.push(...caseToCode(ptc, inner, !!group.setup, subjectAlias));
    }
  }

  lines.push(`${indent}});`);
  return lines;
}

function caseToCode(tc: TestCase, indent: string, hasSetup: boolean, subjectAlias = "Subject"): string[] {
  const desc = JSON.stringify(tc.description);

  // Spy assertions require a setup that provides _subject; without it, we can't inject the spy
  const isSpy = tc.assertion.type === "called" || tc.assertion.type === "calledWith" || tc.assertion.type === "notCalled";
  if (isSpy && !hasSetup) return [`${indent}it.todo(${desc}); // needs setup to inject spy`];

  // Determine the callable expression
  // inspect with complete code body is always runnable — no real method needed
  const hasCompleteCode = tc.assertion.type === "inspect" && !!tc.assertion.code && !tc.action.captures;
  const isSchemaDrop    = tc.assertion.type === "schema-drop"    && !!tc.action.method;
  const isFaultResilience = tc.assertion.type === "fault-resilience" && !!tc.assertion.faultTarget;
  const canRun = hasCompleteCode || isSchemaDrop || isFaultResilience
    || (tc.source !== "needs-fixture" && (tc.action.method !== undefined || hasSetup));
  if (!canRun) return [`${indent}it.todo(${desc});`];

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

  const caller = hasSetup
    ? tc.action.method
      ? `_subject.${tc.action.method}`
      : `_subject`
    : `${subjectAlias}.${tc.action.method}`;

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
    if (tc.action.extraCall) {
      const ec = tc.action.extraCall;
      const ecArgs = ec.args !== undefined
        ? ec.args.map(emitArg).join(", ")
        : "";
      const ecCaller = hasSetup ? `_subject.${ec.method}` : `${subjectAlias}.${ec.method}`;
      lines.push(`${indent}  const ${ec.captures} = await ${ecCaller}(${ecArgs});`);
    }
    if (tc.assertion.type === "inspect" && tc.assertion.code) {
      // Strip a leading duplicate captures binding from the inspect code.
      // The AI sometimes generates "const <captures> = await call; ..." when captures
      // is already bound on the line above, causing a duplicate declaration error.
      const cap = tc.action.captures;
      const dupePat = new RegExp(`^\\s*const\\s+${cap}\\s*=\\s*await[^;]+;\\s*`);
      const cleanCode = tc.assertion.code.replace(dupePat, "");
      if (cleanCode.trim()) lines.push(`${indent}  ${cleanCode}`);
    }
    lines.push(`${indent}});`);
    return lines;
  }

  // Standard assertion
  lines.push(...assertionCode(tc, call, indent + "  ", repeat));
  lines.push(`${indent}});`);
  return lines;
}

function assertionCode(tc: TestCase, call: string, indent: string, afterRepeat?: number): string[] {
  const a = tc.assertion;

  switch (a.type) {
    case "throws": {
      const note = a.errorClass ? ` // expected: ${a.errorClass}` : "";
      return [`${indent}await expect(async () => { await ${call}; }).toThrow();${note}`];
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
      return spyLines(call, indent, count ? `toHaveBeenCalledTimes(${count})` : "toHaveBeenCalled()");
    }

    case "calledWith":
      return [
        `${indent}const _spy = mock(() => {});`,
        `${indent}const _event = {};`,
        `${indent}_subject.subscribe(/* topic */, _spy);`,
        `${indent}${call};`,
        `${indent}expect(_spy).toHaveBeenCalledWith(_event);`,
      ];

    case "notCalled": {
      return [
        `${indent}const _spy = mock(() => {});`,
        `${indent}const _unsub = _subject.subscribe(/* topic */, _spy);`,
        `${indent}_unsub();`,
        `${indent}${call};`,
        `${indent}expect(_spy).not.toHaveBeenCalled();`,
      ];
    }

    case "inspect": {
      if (a.code) {
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
      // "→ contains "text"" — expected is the substring; negations["contains"] → .not.toContain
      const isNegated = a.negations?.includes("contains");
      const target = `await ${call}`;
      if (typeof a.expected === "string") {
        const matcher = isNegated ? "not.toContain" : "toContain";
        return [`${indent}expect(${target}).${matcher}(${JSON.stringify(a.expected)});`];
      }
      // No specific string — just assert the result is a string that can be inspected
      return [
        `${indent}const _result = await ${call};`,
        `${indent}expect(typeof _result === "string" || (typeof _result === "object" && _result !== null)).toBe(true); // verify output is inspectable for sentinel`,
      ];
    }

    case "absent": {
      // Field is absent / undefined / null — conditional presence assertion
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

function spyLines(call: string, indent: string, matcher: string): string[] {
  return [
    `${indent}const _spy = mock(() => {});`,
    `${indent}_subject.subscribe(/* topic */, _spy);`,
    `${indent}${call};`,
    `${indent}expect(_spy).${matcher};`,
  ];
}

// ── Output parsing ────────────────────────────────────────────────────

function parseOutput(suite: TestSuite, output: string, duration: number): RunResult {
  // bun only prints individual lines for (fail) — passing tests are in the summary only.
  // When a module-level error occurs ("Unhandled error between tests"), bun emits 0 pass/0 fail
  // with an error block. Treat this as a total crash — mark all cases as failed so mutation
  // testing doesn't count a crashed run as "mutation survived".
  const hasModuleCrash = /Unhandled error between tests/i.test(output)
    || /0 pass\s*\n.*0 fail\s*\n.*1 error/s.test(output);
  if (hasModuleCrash) {
    const allCases = suite.groups.flatMap(g => g.cases.map(tc => ({
      description: tc.description, status: "fail" as const,
      perspectives: (tc.perspectives ?? []).map(p => ({ description: p.description, status: "fail" as const })),
    })));
    return { suiteName: suite.title, modulePath: suite.modulePath, passed: 0,
      failed: allCases.length, skipped: 0, cases: allCases, duration };
  }

  const failed = new Set<string>();

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const fail = trimmed.match(/^\(fail\)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?m?s\])?$/);
    if (fail) failed.add(lastSegment(fail[1]));
  }

  function caseResult(tc: TestCase, setup: boolean): CaseResult {
    const isSpy = tc.assertion.type === "called" || tc.assertion.type === "calledWith" || tc.assertion.type === "notCalled";
    const hasCompleteCode = tc.assertion.type === "inspect" && !!tc.assertion.code && !tc.action.captures;
    const isSchemaDrop      = tc.assertion.type === "schema-drop"      && !!tc.action.method;
    const isFaultResilience = tc.assertion.type === "fault-resilience" && !!tc.action.method;
    const hasPerspectives = (tc.perspectives?.length ?? 0) > 0;
    const hasDirectTest = hasCompleteCode || isSchemaDrop || isFaultResilience
      || (tc.source !== "needs-fixture"
        && (!!tc.action.method || setup || !!tc.action.captures)
        && !(isSpy && !setup));

    const perspectives = tc.perspectives?.map(p => caseResult(p, setup));
    const perspectivesAnyFail = perspectives?.some(p => p.status === "fail") ?? false;
    const perspectivesPending = perspectives?.some(p => p.status === "skip") ?? false;

    if (!hasDirectTest && !hasPerspectives) {
      return { description: tc.description, status: "skip", perspectives };
    }

    if (!hasDirectTest) {
      // Claim verified entirely through perspectives — no direct test needed
      const status = perspectivesAnyFail ? "fail" : perspectivesPending ? "skip" : "pass";
      return { description: tc.description, status, perspectives };
    }

    // Has direct test; failing perspective also fails the claim
    const status = (failed.has(tc.description) || perspectivesAnyFail) ? "fail" : "pass";
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
    skipped: countStatus(cases, "skip"),
    cases,
    duration,
  };
}

// Emit a negation value for `.not.toBe(X)` — handles null/undefined/boolean keywords
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

function emitArg(a: unknown): string {
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  if (typeof a === "object" && a !== null && "__expr" in a) return (a as { __expr: string }).__expr;
  if (Array.isArray(a)) return `[${a.map(emitArg).join(", ")}]`;
  return JSON.stringify(a);
}

function lastSegment(s: string): string {
  const parts = s.split(" > ");
  return parts[parts.length - 1].trim();
}

function allPending(suite: TestSuite, duration: number): RunResult {
  function pendingCase(tc: TestCase): CaseResult {
    return {
      description: tc.description,
      status: "skip",
      perspectives: tc.perspectives?.map(pendingCase),
    };
  }
  const cases: CaseResult[] = suite.groups.flatMap(g => g.cases.map(pendingCase));
  const skipped = cases.reduce((n, c) => n + 1 + (c.perspectives?.length ?? 0), 0);
  return { suiteName: suite.title, modulePath: suite.modulePath, passed: 0, failed: 0, skipped, cases, duration };
}
