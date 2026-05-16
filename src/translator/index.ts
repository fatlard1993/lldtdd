import type {
  LLDDocument,
  LLDGroup,
  RawAssertion,
  TestCase,
  TestGroup,
  TestSuite,
} from "../types.ts";
import { tryDeterministic } from "./deterministic.ts";
import { translateWithAI, type AIContext } from "./ai.ts";
import { cacheKey, get, set, flush } from "./cache.ts";
import { getModuleExports, getModuleInfo, matchGroupToExport, matchGroupToApi } from "../inference.ts";
import { extractFacts, hintsFor, deriveInline, resolveMethodCall, type AstFacts, type InlineDerived } from "../ast.ts";

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
      tc.action.extraCall = {
        method:   resolved.extraCallMethod,
        args:     resolved.extraCallArgs as unknown[],
        captures: resolved.extraCallCaptures ?? "r",
      };
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

export async function translate(doc: LLDDocument): Promise<TestSuite> {
  const groups: TestGroup[] = [];

  // Pre-load module info (exports + optional __lld_api description) once for all groups
  const moduleInfo = await getModuleInfo(doc.module);
  const moduleExports = moduleInfo.exports;

  // AST facts enriches the translator with implementation semantics
  const astFacts = await extractFacts(doc.module);

  for (const group of doc.groups) {
    const effectiveModule = group.moduleOverride ?? doc.module;
    const groupFacts = group.moduleOverride
      ? (await extractFacts(group.moduleOverride)) ?? astFacts
      : astFacts;
    const cases = await translateGroup(group, doc, moduleExports, moduleInfo.api ?? astFacts?.derivedApi, groupFacts);

    // Try to resolve the group method from __lld_api description → inline derivation
    // This replaces "Subject.namedHelper()" with the actual call the helper wraps
    // For module-override groups, the __lld_api lives in the override module, not the primary.
    const effectiveModuleInfo = group.moduleOverride
      ? await getModuleInfo(group.moduleOverride)
      : moduleInfo;
    // Use __lld_api if present, otherwise fall back to AstFacts-derived vocabulary
    const overrideFacts = group.moduleOverride
      ? (await extractFacts(group.moduleOverride))
      : null;
    const effectiveApi = effectiveModuleInfo.api
      ?? (group.moduleOverride ? overrideFacts?.derivedApi : astFacts?.derivedApi);
    let methodResolved = false;
    if (group.method && effectiveApi && groupFacts) {
      const apiLine = effectiveApi.split("\n").find(l => {
        const name = l.trim().split(/[\s(]/)[0];
        return name === group.method;
      });
      if (apiLine) {
        const description = apiLine.split("|")[1]?.trim() ?? "";
        const resolved = description ? resolveMethodCall(group.method, description, groupFacts) : null;
        if (resolved) {
          methodResolved = true;
          // Override when: no method yet, method matches group annotation, or AI made a replaceable guess
          const canOverride = (tc: TestCase) =>
            !tc.action.method || tc.action.method === group.method || tc.source === "ai";
          for (const tc of cases) {
            applyResolvedToCase(tc, resolved, canOverride);
            for (const ptc of tc.perspectives ?? []) applyResolvedToCase(ptc, resolved, canOverride);
          }
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
    // Only apply exact and camel matches — partial matches need human review.
    if (!group.method && !group.setup && moduleExports.length > 0) {
      const inferred = matchGroupToExport(group.name, moduleExports);
      if (inferred && inferred.confidence !== "partial") {
        for (const tc of cases) {
          if (!tc.action.method) tc.action.method = inferred.method;
        }
      }
    }

    // __lld_api description matching — infer method when no annotation and no export match.
    // Scores token overlap between (group name + claim text) and each api method description.
    // Only overrides genuinely unanchored cases (source = needs-fixture or ai).
    let inferredMethod: string | undefined;
    if (!group.method && !group.setup && !methodResolved && effectiveApi && groupFacts) {
      const allClaimTexts = group.assertions.flatMap(a =>
        [a.raw, ...(a.perspectives ?? []).map(p => p.raw)]
      );
      const apiMatch = matchGroupToApi(group.name, allClaimTexts, effectiveApi);
      inferredMethod = apiMatch?.method;
      if (apiMatch) {
        const apiLine = effectiveApi.split("\n").find(l =>
          l.trim().split(/[\s(]/)[0] === apiMatch.method
        );
        if (apiLine) {
          const description = apiLine.split("|")[1]?.trim() ?? "";
          const resolved = description ? resolveMethodCall(apiMatch.method, description, groupFacts) : null;
          if (resolved) {
            // Override pending/AI always; override deterministic only when resolution is specific
            const hasSpecific = resolved.inspectCode !== undefined
              || (resolved.method !== undefined && resolved.outcomeType !== undefined);
            const canOverride = (tc: TestCase) =>
              tc.source === "needs-fixture" || tc.source === "ai"
              || (tc.source === "deterministic" && hasSpecific);
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

  await flush();

  return {
    title: doc.title,
    modulePath: doc.module,
    sourcePath: doc.sourcePath,
    groups,
    moduleAstFacts: astFacts ?? undefined,
  };
}

async function translateGroup(
  group: LLDGroup,
  doc: LLDDocument,
  exports: string[],
  moduleApi?: string,
  astFacts?: AstFacts | null
): Promise<TestCase[]> {
  const ctx: AIContext = {
    module: doc.module,
    group: group.name,
    groupContext: group.context,
    groupSetup: group.setup,
    groupMethod: group.method,
    moduleExports: exports.length > 0 ? exports : undefined,
    moduleApi,
    astFacts: astFacts ?? undefined,
  };

  return Promise.all(
    group.assertions.map(async a => {
      const tc = await translateAssertion(a, ctx, doc);

      // Translate perspective questions; they inherit the same group context
      if (a.perspectives?.length) {
        tc.perspectives = await Promise.all(
          a.perspectives.map(p => translateAssertion(p, ctx, doc))
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

function buildInlineCase(inline: import("../ast.ts").InlineDerived, description: string): TestCase {
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
  // Self-contained inspect body: no captures needed — the code creates its own context and asserts
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
    source: "needs-fixture",
  };
}

async function translateAssertion(
  assertion: RawAssertion,
  ctx: AIContext,
  doc: LLDDocument
): Promise<TestCase> {
  const det = tryDeterministic(assertion);
  if (det) {
    // Strengthen schema-drop with real field names from AST when available
    if (det.assertion.type === "schema-drop" && ctx.astFacts) {
      const primaryFields = ctx.astFacts.schemas[0]?.fields ?? [];
      det.assertion.knownFields = [...new Set(primaryFields)];
    }

    // Fault resilience: "a failed X does not stall Y" — enrich with fault target from AstFacts
    if (det.assertion.type === "fault-resilience" && ctx.astFacts) {
      const { selectFaultScenario } = await import("../fixtures.ts");
      const scenario = selectFaultScenario(assertion.raw);
      const targetPath = scenario?.targetPath
        ?? Object.entries(ctx.astFacts.faultTargets).find(([k]) =>
            assertion.raw.toLowerCase().includes(k)
          )?.[1];
      if (targetPath) {
        det.assertion.faultTarget = targetPath;
        return det;
      }
      // No fault target found → fall through to inline derivation or pending
    }

    // Grammar matched but no group method → if AST can provide the callable, use it
    if (!assertion.callMethod && !ctx.groupMethod && ctx.astFacts) {
      const inline = deriveInline(assertion.raw, ctx.astFacts);
      if (inline) return buildInlineCase(inline, assertion.raw);
    }

    return det;
  }

  // When perspectives are present, they carry the verification — no AI needed for the claim itself.
  if (assertion.perspectives?.length) return pendingCase(assertion);

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

  // AST-derived: the claim vocabulary maps directly to call expressions — no helper file needed.
  if (ctx.astFacts && !assertion.callMethod) {
    const inline = deriveInline(assertion.raw, ctx.astFacts);
    if (inline) return buildInlineCase(inline, assertion.raw);
  }

  // Without explicit anchoring (method annotation, setup, or inline call),
  // the assertion is intentionally pending — skip AI to avoid unreliable inferences.
  const hasInlineCall = !!assertion.callMethod;
  const hasAnchor = !!(ctx.groupMethod || ctx.groupSetup);
  if (!hasInlineCall && !hasAnchor) return pendingCase(assertion);

  const key = cacheKey(assertion.raw, doc.module, ctx.group, ctx.groupMethod);
  const cached = await get(key);
  if (cached) return cached;

  try {
    const result = await translateWithAI(assertion, ctx);
    // Inline call expression overrides AI-inferred method/args
    if (assertion.callMethod) {
      result.action.method = assertion.callMethod;
      result.action.args = assertion.callArgs;
    }
    if (assertion.captures) {
      result.action.captures = assertion.captures;
      if (assertion.captures2 && assertion.callMethod2) {
        result.action.extraCall = {
          method: assertion.callMethod2,
          args: assertion.callArgs2,
          captures: assertion.captures2,
        };
      }
    }
    // Reject AI-only "resolves" with no captures — it's a form-B fallback that passes for any
    // function that doesn't throw. That's not better than pending; it's worse (silently weak).
    // Surface it as needs-fixture so the author knows coverage is missing.
    if (result.source === "ai"
        && result.assertion.type === "resolves"
        && !result.action.captures
        && !assertion.callMethod) {
      return pendingCase(assertion);
    }
    await set(key, result);
    return result;
  } catch {
    return {
      description: assertion.raw,
      setup: [],
      action: { argDescription: assertion.condition },
      assertion: { type: "resolves", description: assertion.raw },
      source: "needs-fixture",
    };
  }
}
