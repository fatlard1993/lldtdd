import type { TestSuite, TestGroup, TestCase, AssertionStep } from "../types.ts";
import { extractLeadingLiteral, inferAssertionFromRemainder } from "./literal.ts";
import { synthesizeArg, hasSemanticSignal } from "./semantic.ts";
import { readFunctionSignature } from "./typeReader.ts";

export async function synthesize(suite: TestSuite): Promise<TestSuite> {
  const groups = await Promise.all(
    suite.groups.map(g => synthesizeGroup(g, suite.modulePath))
  );
  return { ...suite, groups };
}

async function synthesizeGroup(group: TestGroup, modulePath: string): Promise<TestGroup> {
  const cases = await Promise.all(
    group.cases.map(tc => synthesizeCase(tc, modulePath))
  );
  return { ...group, cases };
}

async function synthesizeCase(tc: TestCase, modulePath: string): Promise<TestCase> {
  // Already has explicit args -- nothing to synthesize
  if (tc.action.args !== undefined) return tc;

  // No method -- can't call anything
  if (!tc.action.method) return tc;

  // For literal extraction, always use the original LLD assertion text. argDescription is a
  // paraphrase carried over from the parsed condition (e.g. "string '042' with leading zero"),
  // and paraphrasing can drop the leading literal that IS the argument.
  const literalResult = extractLeadingLiteral(tc.description);

  if (literalResult) {
    const inferred = inferAssertionFromRemainder(literalResult.rest, literalResult.value);
    const args = [literalResult.value];

    // If inference produced a clear assertion, override whatever the translator said
    if (inferred) {
      return {
        ...tc,
        action: { ...tc.action, args },
        assertion: mergeNegations(inferred.step, inferred.negations),
        source: "deterministic" as const,
      };
    }

    // Literal found but assertion not inferable -- at least provide the right arg
    return { ...tc, action: { ...tc.action, args } };
  }

  // ── Phase 2: Semantic vocabulary + AST types ───────────────────────────
  // Prefer argDescription for semantic matching -- when the parser isolated a condition clause,
  // it carries the semantic signal with less surrounding prose than the raw assertion text.
  const semanticDesc = tc.action.argDescription ?? tc.description;
  if (!hasSemanticSignal(semanticDesc)) return tc;

  const params = await readFunctionSignature(modulePath, tc.action.method);
  if (!params || params.length === 0) return tc;

  const args = params
    .filter(p => !p.optional)
    .map(p => synthesizeArg(semanticDesc, p, params));

  return { ...tc, action: { ...tc.action, args } };
}

function mergeNegations(step: AssertionStep, negations: string[]): AssertionStep {
  if (negations.length === 0) return step;
  return { ...step, negations: [...(step.negations ?? []), ...negations] };
}
