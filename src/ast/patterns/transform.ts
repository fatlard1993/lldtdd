// Transform / test-feature scenario patterns.
//
// `deriveInline` calls this with `claim.toLowerCase()`, so author-written prose reaches these
// regexes directly. The four CLI-shaped scenarios therefore gate on a module that can actually
// answer them (they construct the default export with argi's option bag and call `.parse()`);
// without that gate, a value-mapper claim would derive a CLI-parser test and fail for a premise the
// author never wrote. The rest gate on extracted facts (`functionTypeChains`,
// `textTransformerFunctions`, `comparatorFunctions`).

import type { AstFacts, InlineDerived } from "../types.ts";
import { declaresParseMethod } from "./cli.ts";

export function resolveTransformPatterns(lower: string, methodName: string, facts: AstFacts): InlineDerived | null {
  // Every scenario in this block does `new _SubjectCtor({ options: … , parse: false })` and then
  // `_a.parse()`. Without a constructible default export and a `parse()` to call, the emitted code
  // cannot run -- so declining is the honest answer, and the claim stays pending.
  const isCliParserShaped = !!facts.constructorModulePath && declaresParseMethod(facts.source);

  if (isCliParserShaped && /transform map is replaceable|replacing string transform/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--value", "hello"];`,
      `const _a = new _SubjectCtor({ options: { value: {} }, defaults: { transform: { string: s => s.toUpperCase() } }, parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(r.value).toBe("HELLO");`,
    ].join("\n") };
  }
  if (isCliParserShaped && /per-flag transform replaces|flag-level transform overrides/i.test(lower)) {
    // Use a non-boolean type: a boolean-typed flag never consumes a following value token
    // (presence alone is truthy), so a boolean type here would leave the value as an
    // unrecognized positional instead of reaching the transform.
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "yes"];`,
      `const _a = new _SubjectCtor({ options: { flag: { type: "string", transform: s => s === "yes" } }, parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(r.flag).toBe(true);`,
    ].join("\n") };
  }
  if (isCliParserShaped && /custom test receives coerced|parse fails on invalid value/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--score", "-5"];`,
      `const _a = new _SubjectCtor({ options: { score: { test: v => v >= 0 } }, parse: false });`,
      `await expect(async () => { _a.parse(); }).toThrow();`,
    ].join("\n") };
  }
  // ── Pipeline chain: fn that requires N predecessor setup steps ──────
  if (/pipeline stage.*calls (\w+)/i.test(lower)) {
    const chainInfo = facts.functionTypeChains?.[methodName];
    if (chainInfo && chainInfo.chain.length > 0) {
      const { chain, rootTextTransformer } = chainInfo;
      const lines: string[] = [];
      // Root step: text transformer produces the first input
      const rootFn = chain[0];
      const rootTT = rootTextTransformer ?? facts.textTransformerFunctions?.[rootFn];
      const rootArgs = rootTT
        ? [JSON.stringify(rootTT.syntheticInput), ...rootTT.secondaryArgs.map(a => JSON.stringify(a))].join(", ")
        : `"# Test Document\\n> src/test.ts\\n\\n## Test Group\\n- a test assertion", "test.lld.md"`;
      // Use _PipelineStage alias (imported by adapter from pipelineStageModulePath)
      lines.push(`const _step0 = _PipelineStage.${rootFn}(${rootArgs});`);
      for (let i = 1; i < chain.length; i++) {
        lines.push(`const _step${i} = await _PipelineStage.${chain[i]}(_step${i - 1});`);
      }
      lines.push(`const r = await _PipelineStage.${methodName}(_step${chain.length - 1});`);
      lines.push(`expect(r).toBeDefined();`);
      lines.push(`if (r && r.groups) expect(r.groups.length).toBeGreaterThan(0);`);
      return { method: "create", callArgs: [], inspectCode: lines.join("\n") };
    }
  }

  // ── Code processor: (string) → Array -- method=methodName so adapter uses the right module alias ──
  if (/code processor.*processes source code|processes source code.*array/i.test(lower)) {
    const fn = facts.textTransformerFunctions?.[methodName];
    if (fn) {
      return { method: methodName, callArgs: [fn.syntheticInput, ...fn.secondaryArgs], captures: "r",
        inspectCode: [`expect(Array.isArray(r)).toBe(true);`, `expect(r.length).toBeGreaterThan(0);`].join("\n") };
    }
  }

  // ── Text transformer: (string, ...) → document -- same alias-safe approach ──
  if (/text transformer.*parses structured|parses structured text.*document/i.test(lower)) {
    const fn = facts.textTransformerFunctions?.[methodName];
    if (fn) {
      return { method: methodName, callArgs: [fn.syntheticInput, ...fn.secondaryArgs], captures: "r",
        inspectCode: [
          `expect(r).toBeDefined();`,
          `expect(r.groups).toBeDefined();`,
          `expect(r.groups.length).toBeGreaterThan(0);`,
          `expect(r.groups[0].name).toBe("Test Group");`,
        ].join("\n") };
    }
  }

  // ── Structural comparator: (T, T) → changes[] -- per-scenario inline code ──
  if (/structural comparator.*calls (\w+)/i.test(lower)) {
    const scenario = facts.comparatorFunctions?.[methodName];
    if (scenario) {
      const expectsEmpty = /identical|no.?change|unchanged|no changes/i.test(lower);
      return { method: "create", callArgs: [], inspectCode: [
        `const _before = ${JSON.stringify(scenario.syntheticBefore)};`,
        `const _after = ${JSON.stringify(scenario.syntheticAfter)};`,
        `const r = Subject.${scenario.realFunctionName}(_before, _after);`,
        `expect(Array.isArray(r)).toBe(true);`,
        expectsEmpty ? `expect(r.length).toBe(0);` : `expect(r.length).toBeGreaterThan(0);`,
      ].join("\n") };
    }
  }

  if (isCliParserShaped && /rest tail.*captures|remaining tokens.*array/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "a", "b", "c"];`,
      `const _a = new _SubjectCtor({ options: {}, tail: [{ name: "files", rest: true }], parse: false });`,
      `_a.parse();`,
      `const r = _a.options;`,
      `expect(Array.isArray(r.files)).toBe(true);`,
      `expect(r.files[0]).toBe("a");`,
    ].join("\n") };
  }

  return null;
}

