import type {
  LLDDocument,
  LLDGroup,
  RawAssertion,
  TestCase,
  TestGroup,
  TestSuite,
} from "../types.ts";
import { tryDeterministic } from "./deterministic.ts";
import { getModuleInfo, matchGroupToExport, matchGroupToApi, type ExecutionOptions } from "../inference.ts";
import { extractFacts, deriveInline, resolveMethodCall, type AstFacts, type InlineDerived } from "../ast/index.ts";
import { findBrowser } from "../browser.ts";

/** Everything a single assertion needs to resolve into a test case. Every field here is read by
 *  deterministic grammar matching or AST derivation -- both offline, both reproducible. There is
 *  no model call anywhere in this pipeline: a claim either matches a known pattern or stays
 *  pending, and which of those happens is a function of the document and the implementation
 *  source alone. Two machines on the same commit derive the same suite. */
interface TranslateContext {
  groupSetup?: string;
  groupMethod?: string;
  astFacts?: AstFacts;
  /** The claim a perspective hangs under, when translating a perspective.
   *
   *  A perspective is written as a follow-on to its parent and inherits vocabulary from it: "does an
   *  Icon constructed without text receive the icon-only class?" names no class, because the claim
   *  above it already said the element receives the `icon` class. Translating each perspective in
   *  isolation threw that away, and across one real corpus 42 of 71 pending perspectives had a parent
   *  carrying backticked identifiers the perspective itself never repeats. The author had written
   *  down what the test needed; the reader could see it and the deriver could not. */
  parentClaim?: string;
  /** This group asked to run in a real browser, and one is available. Both halves matter: a scenario
   *  marked for the browser on a machine without one must stay pending, not quietly run under
   *  happy-dom and report a layout measurement of zero as an answer. */
  browser?: boolean;
  /** Absolute path of the module under test, for the browser path to bundle. */
  modulePath?: string;
}

// ── Shared resolution applicator ──────────────────────────────────────
// Single implementation used by both the explicit-method path and the
// inferred-method path. Prevents the three-way copy-paste from diverging.
function applyResolvedToCase(
  tc: TestCase,
  resolved: InlineDerived,
  canOverride: (tc: TestCase) => boolean
): void {
  if (!canOverride(tc)) return;
  tc.action.method = resolved.method;
  tc.action.args   = resolved.callArgs;
  tc.source        = "ast-derived";
  if (resolved.captures && (resolved.inspectCode || resolved.extraCallMethod)) {
    tc.action.captures = resolved.captures;
    if (resolved.extraCallMethod) {
      tc.action.extraCalls = [{
        method:   resolved.extraCallMethod,
        args:     resolved.extraCallArgs as unknown[],
        captures: resolved.extraCallCaptures ?? "r",
      }];
    }
    if (resolved.inspectCode) tc.assertion = { type: "inspect", code: resolved.inspectCode };
  } else if (resolved.inspectCode && !resolved.captures) {
    tc.action.method = undefined;
    tc.assertion = { type: "inspect", code: resolved.inspectCode };
  } else if (resolved.outcomeType) {
    tc.assertion = {
      type: resolved.outcomeType === "throws"      ? "throws"
          : resolved.outcomeType === "schema-drop" ? "schema-drop"
          : "resolves",
    };
  }
}

/** The `__lld_api` lookup both method-resolution paths share: find the api line whose name is
 *  `method`, read the description after its ` | `, and resolve a call from it -- null when there is
 *  no such line, no description, or nothing resolvable.
 *
 *  Held in one place on purpose. The two callers (a group's explicit `**method:**`, and a method
 *  inferred from claim text) had their own copy of this three-step lookup, and copies of the exact
 *  logic that decides which call a claim checks are how this translator twice kept a claim's text
 *  as a test's name while checking something else. The override *policy* differs between the two and
 *  stays with each; only the lookup is shared. */
function resolveFromApi(method: string, effectiveApi: string, groupFacts: AstFacts): InlineDerived | null {
  const apiLine = effectiveApi.split("\n").find(l => l.trim().split(/[\s(]/)[0] === method);
  if (!apiLine) return null;
  const description = apiLine.split("|")[1]?.trim() ?? "";
  return description ? resolveMethodCall(method, description, groupFacts) : null;
}

/** Whether this machine can run a browser claim. Cached: the answer cannot change mid-run, and a
 *  document with no browser groups must never pay for the question. */
let browserAvailable: boolean | undefined;
async function hasBrowser(): Promise<boolean> {
  browserAvailable ??= (await findBrowser()) !== null;
  return browserAvailable;
}

/** `execute` decides whether resolving this document may load and call the module under test.
 *  The runner passes it; `lint` and `suggest` do not, so translating for a report never runs
 *  the subject's code. See ExecutionOptions in src/inference.ts. */
export async function translate(doc: LLDDocument, opts: ExecutionOptions = {}): Promise<TestSuite> {
  const groups: TestGroup[] = [];

  // Pre-load module info (exports + optional __lld_api description) once for all groups
  const moduleInfo = await getModuleInfo(doc.module, opts);
  const moduleExports = moduleInfo.exports;

  // AST facts enriches the translator with implementation semantics. doc.root carries the same
  // containment boundary the parser applied to the module pointer, so transitively-read imports
  // cannot escape the project.
  const astFacts = await extractFacts(doc.module, opts, doc.root);

  for (const group of doc.groups) {
    const groupFacts = group.moduleOverride
      ? (await extractFacts(group.moduleOverride, opts, doc.root)) ?? astFacts
      : astFacts;
    const cases = await translateGroup(group, groupFacts, group.moduleOverride ?? doc.module);

    // Try to resolve the group method from __lld_api description → inline derivation
    // This replaces "Subject.namedHelper()" with the actual call the helper wraps
    // For module-override groups, the __lld_api lives in the override module, not the primary.
    const effectiveModuleInfo = group.moduleOverride
      ? await getModuleInfo(group.moduleOverride, opts)
      : moduleInfo;
    // Use __lld_api if present, otherwise fall back to AstFacts-derived vocabulary
    const overrideFacts = group.moduleOverride
      ? (await extractFacts(group.moduleOverride, opts, doc.root))
      : null;
    const effectiveApi = effectiveModuleInfo.api
      ?? (group.moduleOverride ? overrideFacts?.derivedApi : astFacts?.derivedApi);
    let methodResolved = false;
    if (group.method && effectiveApi && groupFacts) {
      const resolved = resolveFromApi(group.method, effectiveApi, groupFacts);
      if (resolved) {
        methodResolved = true;
        // A resolved call from `__lld_api` fills in a claim the grammar could not read. It must
        // never replace one the grammar *could*: a test that keeps the claim as its name while
        // checking a generic call instead is the exact false pass this project exists to prevent.
        //
        // Method-name equality cannot draw that line. A claim written as
        // `parse("…") captures r -> r.title === "The Title"` has `action.method === "parse"`,
        // equal to the group's annotation, yet is anything but an empty slot.
        //
        // `action.fromClaim` carries the distinction: the claim named its own call or its own
        // outcome. A bare vocabulary match stays overridable, because a family that recognises the
        // module's shape genuinely has a better body for it than the generic one.
        const canOverride = (tc: TestCase) =>
          !tc.action.fromClaim && (!tc.action.method || tc.action.method === group.method);
        for (const tc of cases) {
          applyResolvedToCase(tc, resolved, canOverride);
          for (const ptc of tc.perspectives ?? []) applyResolvedToCase(ptc, resolved, canOverride);
        }
      }
    }

    // Explicit group.method annotation fills in cases with no method
    if (group.method) {
      for (const tc of cases) {
        if (!tc.action.method) tc.action.method = group.method;
      }
    }

    // Auto-infer from module exports when no explicit annotation and no setup.
    // Only apply exact and camel matches -- partial matches need human review.
    if (!group.method && !group.setup && moduleExports.length > 0) {
      const inferred = matchGroupToExport(group.name, moduleExports);
      if (inferred && inferred.confidence !== "partial") {
        for (const tc of cases) {
          if (!tc.action.method) tc.action.method = inferred.method;
        }
      }
    }

    // __lld_api description matching -- infer method when no annotation and no export match.
    // Scores token overlap between (group name + claim text) and each api method description.
    // Only overrides genuinely unanchored cases (source = pending).
    let inferredMethod: string | undefined;
    if (!group.method && !group.setup && !methodResolved && effectiveApi && groupFacts) {
      const allClaimTexts = group.assertions.flatMap(a =>
        [a.raw, ...(a.perspectives ?? []).map(p => p.raw)]
      );
      const apiMatch = matchGroupToApi(group.name, allClaimTexts, effectiveApi);
      inferredMethod = apiMatch?.method;
      if (apiMatch) {
        const resolved = resolveFromApi(apiMatch.method, effectiveApi, groupFacts);
        if (resolved) {
          // Same rule as the annotated path above, and for the same reason. Specificity of the
          // resolved replacement is not the question; whether the author already said what to
          // check is. A resolved call is a fair replacement for a vocabulary match, because the
          // families' whole job is to recognise a module's shape, but a claim that named its own
          // call or outcome (`fromClaim`) is never rewritten.
          const hasSpecific = resolved.inspectCode !== undefined
            || (resolved.method !== undefined && resolved.outcomeType !== undefined);
          const canOverride = (tc: TestCase) =>
            !tc.action.fromClaim
            && (tc.source === "pending" || (tc.source === "deterministic" && hasSpecific));
          for (const tc of cases) {
            applyResolvedToCase(tc, resolved, canOverride);
            for (const ptc of tc.perspectives ?? []) applyResolvedToCase(ptc, resolved, canOverride);
          }
          // Fill in the inferred method for any cases still without one
          for (const tc of cases) {
            if (!tc.action.method) tc.action.method = apiMatch.method;
          }
          for (const ptc of cases.flatMap(tc => tc.perspectives ?? [])) {
            if (!ptc.action.method) ptc.action.method = apiMatch.method;
          }
        }
      }
    }

    // Resolve effective lifecycle (priority order):
    //   1. Group-level annotation (always wins)
    //   2. Override module's AstFacts lifecycle (when module override has its own lifecycle)
    //   3. Document-level default (covers all groups including overrides)
    //   4. Primary module's AstFacts lifecycle
    const effectiveBeforeAll  = group.beforeAll
      ?? (group.moduleOverride ? groupFacts?.lifecycle.beforeAll : undefined)
      ?? doc.defaultBeforeAll
      ?? groupFacts?.lifecycle.beforeAll;
    const effectiveBeforeEach = group.beforeEach
      ?? (group.moduleOverride ? groupFacts?.lifecycle.beforeEach : undefined)
      ?? doc.defaultBeforeEach
      ?? groupFacts?.lifecycle.beforeEach;

    // mockHttp: explicit annotation wins; fall back to AST-derived response shape
    // Only auto-inject when the group has a method that returns an array (search result type)
    const effectiveGroupMethod = group.method ?? inferredMethod;
    const effectiveMockHttp = group.mockHttp
      ?? (groupFacts?.mockResponseShape && effectiveGroupMethod
          && groupFacts.returnTypes[effectiveGroupMethod] === "array"
        ? groupFacts.mockResponseShape
        : undefined);

    groups.push({ name: group.name, setup: group.setup, beforeEach: effectiveBeforeEach, beforeAll: effectiveBeforeAll, method: group.method, modulePath: group.moduleOverride, moduleIsDefaultCrud: groupFacts?.isDefaultCrud && !!group.moduleOverride, mockHttp: effectiveMockHttp, cases });
  }

  return {
    title: doc.title,
    modulePath: doc.module,
    sourcePath: doc.sourcePath,
    groups,
    moduleAstFacts: astFacts ?? undefined,
    companionModulePath: doc.companionModule,
  };
}

async function translateGroup(
  group: LLDGroup,
  astFacts?: AstFacts | null,
  modulePath?: string
): Promise<TestCase[]> {
  const ctx: TranslateContext = {
    groupSetup: group.setup,
    groupMethod: group.method,
    astFacts: astFacts ?? undefined,
    browser: group.browser === true && await hasBrowser(),
    modulePath,
  };

  return Promise.all(
    group.assertions.map(async a => {
      const tc = await translateAssertion(a, ctx);

      // Translate perspective questions; they inherit the same group context
      if (a.perspectives?.length) {
        tc.perspectives = await Promise.all(
          a.perspectives.map(p => translateAssertion(p, { ...ctx, parentClaim: a.raw }))
        );
        // Inject group method into perspectives that have no inline call, same as parent
        if (group.method) {
          for (const ptc of tc.perspectives) {
            if (!ptc.action.method) ptc.action.method = group.method;
          }
        }
      }

      return tc;
    })
  );
}

function buildInlineCase(inline: import("../ast/index.ts").InlineDerived, description: string): TestCase {
  const action = {
    method: inline.method,
    args: inline.callArgs as unknown[],
    captures: inline.captures,
  };
  if (inline.outcomeType === "schema-drop") {
    return { description, setup: [], action, assertion: { type: "schema-drop", knownFields: inline.knownFields }, source: "ast-derived" };
  }
  if (inline.outcomeType === "resolves") {
    return { description, setup: [], action, assertion: { type: "resolves" }, source: "ast-derived" };
  }
  if (inline.captures && inline.inspectCode) {
    return { description, setup: [], action, assertion: { type: "inspect", code: inline.inspectCode }, source: "ast-derived" };
  }
  // Self-contained inspect body: no captures needed -- the code creates its own context and asserts
  if (inline.inspectCode && !inline.captures) {
    return { description, setup: [], action: { method: undefined, args: [] }, assertion: { type: "inspect", code: inline.inspectCode }, source: "ast-derived" };
  }
  return { description, setup: [], action, assertion: { type: "resolves" }, source: "ast-derived" };
}

function pendingCase(assertion: RawAssertion): TestCase {
  return {
    description: assertion.raw,
    setup: [],
    action: { argDescription: assertion.condition },
    assertion: { type: "resolves" },
    source: "pending",
  };
}

async function translateAssertion(
  assertion: RawAssertion,
  ctx: TranslateContext
): Promise<TestCase> {
  const det = tryDeterministic(assertion, ctx);
  if (det) {
    // Strengthen schema-drop with real field names from AST when available
    if (det.assertion.type === "schema-drop" && ctx.astFacts) {
      const primaryFields = ctx.astFacts.schemas[0]?.fields ?? [];
      det.assertion.knownFields = [...new Set(primaryFields)];
    }

    // Fault resilience: "a failed X does not stall Y" -- enrich with fault target from AstFacts
    if (det.assertion.type === "fault-resilience" && ctx.astFacts) {
      // `fetch` is a platform global, so a claim naming it identifies its own injection point
      // without the module having to declare one -- and a named platform fault wins over a declared
      // target, the precedence the check below preserves.
      const lowerRaw = assertion.raw.toLowerCase();
      const isFetchFault = ["fetch", "request", "http request", "network request"]
        .some(label => lowerRaw.includes(label));
      const targetPath = (isFetchFault ? "global.fetch" : undefined)
        ?? Object.entries(ctx.astFacts.faultTargets).find(([k]) =>
            lowerRaw.includes(k)
          )?.[1];
      if (targetPath) {
        det.assertion.faultTarget = targetPath;
        return det;
      }
      // No fault target found → fall through to inline derivation or pending
    }

    // Grammar matched but no group method → if AST can provide the callable, use it
    if (!assertion.callMethod && !ctx.groupMethod && ctx.astFacts) {
      const inline = deriveInline(assertion.raw, ctx.astFacts, ctx.parentClaim);
      if (inline) return buildInlineCase(inline, assertion.raw);
    }

    return det;
  }

  // When perspectives are present, they carry the verification -- the claim itself is the heading
  // they hang off, not something to check directly.
  //
  // Unless an AST pattern can derive a real test for the parent as well, in which case running it
  // is strictly better than pending and the perspectives still run alongside it. The grammar
  // declines bare parent prose, so the hand-off to AST derivation has to be explicit here or it
  // is lost: a claim like "interaction with the hue bar does not affect the saturation/lightness
  // position and vice versa" has a derivable test and a perspective, and would otherwise
  // silently drop to pending.
  if (assertion.perspectives?.length) {
    if (ctx.astFacts && !assertion.callMethod) {
      const inline = deriveInline(assertion.raw, ctx.astFacts, ctx.parentClaim);
      if (inline) return buildInlineCase(inline, assertion.raw);
    }
    return pendingCase(assertion);
  }

  // Question perspective derivation from return type semantics
  if (assertion.raw.endsWith("?") && ctx.groupMethod && ctx.astFacts) {
    const retType = ctx.astFacts.returnTypes[ctx.groupMethod];

    // Boolean-returning method → → true
    if (retType === "boolean" || retType === "bool") {
      return {
        description: assertion.raw,
        setup: [],
        action: { argDescription: assertion.raw },
        assertion: { type: "equals", expected: true },
        source: "ast-derived",
      };
    }

    // Array-returning method → captures r → Array.isArray(r)
    if (retType === "array") {
      return {
        description: assertion.raw,
        setup: [],
        action: { method: ctx.groupMethod, args: [], captures: "r" },
        assertion: { type: "inspect", code: "expect(Array.isArray(r)).toBe(true);" },
        source: "ast-derived",
      };
    }

    // Method with known default field → captures r → r.field === ""
    const df = ctx.astFacts.defaultFields[ctx.groupMethod];
    if (df && /\bdefault|empty\b/i.test(assertion.raw)) {
      return {
        description: assertion.raw,
        setup: [],
        action: { method: ctx.groupMethod, args: [], captures: "r" },
        assertion: { type: "inspect", code: `expect(r.${df.field}).toBe(${JSON.stringify(df.value)});` },
        source: "ast-derived",
      };
    }

    // Method with known result assertion from __lld_api → captures r → inspect
    // "result.category is a string" / "result.name === 'Renamed'" / "result.category is defined"
    const ra = ctx.astFacts.resultAssertions[ctx.groupMethod];
    if (ra) {
      return {
        description: assertion.raw,
        setup: [],
        action: { method: ctx.groupMethod, args: [], captures: "r" },
        assertion: { type: "inspect", code: ra },
        source: "ast-derived",
      };
    }
  }

  // AST-derived: the claim vocabulary maps directly to call expressions -- no helper file needed.
  if (ctx.astFacts && !assertion.callMethod) {
    const inline = deriveInline(assertion.raw, ctx.astFacts, ctx.parentClaim);
    if (inline) return buildInlineCase(inline, assertion.raw);
  }

  // Nothing matched: not the grammar, not an AST pattern. The claim stays pending.
  //
  // This is the terminal state on purpose. An earlier version handed unmatched claims to a model
  // to guess a test body from, and the guesses were the weakest cases in every suite -- most of
  // them collapsed to a bare "the call resolves", which passes for any function that doesn't
  // throw and so verified nothing. That path had to be demoted back to pending often enough that
  // it was easier to describe than to defend, and it made a run's result depend on which machine
  // and which model version produced it. A test runner that reports differently on two machines
  // is not reporting.
  //
  // So: a claim is verified by a rule the author can read in GRAMMAR.md, or it is pending. Pending
  // is a legitimate state -- it says "this intent is recorded but not yet checked", which is true
  // and useful. A green that came from a guess says something false.
  return pendingCase(assertion);
}
