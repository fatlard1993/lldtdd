// CLI-shaped pattern resolvers: parseArgs/exitCode zero-arg scenario builders, the
// class-based multi-tier command+flag+tail parser family, and the exit-code/parseArgs
// result.FIELD matcher family.

import type { AstFacts, InlineDerived, ZeroArgScenario } from "../types.ts";

function buildParseArgsInline(argv: unknown[], opts: Record<string, unknown>, assertion: string): string {
  const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
  return [
    `process.argv = ["node", "cli.js", ${argvLiteral}];`,
    `const _a = new _SubjectCtor({ options: ${JSON.stringify(opts)}, parse: false });`,
    `_a.parse();`,
    `const r = _a.options;`,
    assertion,
  ].join("\n");
}

function buildParseArgsThrowInline(argv: unknown[], opts: Record<string, unknown>, extra?: Record<string, unknown>): string {
  const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
  const extraLiteral = extra
    ? `, ${Object.entries(extra).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}`
    : "";
  return [
    `process.argv = ["node", "cli.js", ${argvLiteral}];`,
    `const _a = new _SubjectCtor({ options: ${JSON.stringify(opts)}${extraLiteral}, parse: false });`,
    `await expect(async () => { _a.parse(); }).toThrow();`,
  ].join("\n");
}

function deriveParseArgsInputs(
  field: string, value: unknown, lower: string
): { argv: unknown[]; opts: Record<string, unknown> } {
  if (/chained/i.test(lower))
    return { argv: ["-abc"], opts: { a: { type: "boolean" }, b: { type: "boolean" }, c: { type: "boolean" } } };
  if (value === false && /negat|no.prefix/i.test(lower))
    return { argv: [`--no-${field}`], opts: { [field]: { type: "boolean" } } };
  if ((value === true || lower.includes("true")) && /boolean/i.test(lower))
    return { argv: [`--${field}`, "TRUE"], opts: { [field]: { type: "boolean" } } };
  if (/\binteger\b/i.test(lower) && typeof value === "number")
    return { argv: [`--${field}`, String(value)], opts: { [field]: { type: "integer" } } };
  if (/\bdefault\b/i.test(lower))
    return { argv: [], opts: { [field]: { defaultValue: value } } };
  if (/alias|canonical/i.test(lower))
    return { argv: [`-${field[0]}`, String(value)], opts: { [field]: { alias: field[0] } } };
  if (/pass.?through|separator/i.test(lower))
    return { argv: [`--${field}`, String(value), "--", "extra"], opts: { [field]: {} } };
  if (/equals.form|=value/i.test(lower))
    return { argv: [`--${field}=${String(value)}`], opts: { [field]: {} } };
  // Default: space form
  return { argv: [`--${field}`, String(value)], opts: { [field]: {} } };
}

function deriveParseArgsThrowInputs(
  lower: string
): { argv: unknown[]; opts: Record<string, unknown>; extra?: Record<string, unknown> } | null {
  // Tail-required check first -- both this and the flag-required check below share the word
  // "required", and the tail config lives at the top level, not inside opts.
  if (/required.*tail|tail.*required/i.test(lower))
    return { argv: [], opts: {}, extra: { tail: [{ name: "target", required: true }] } };
  if (/required.*absent|absent.*required|missing required flag|required flag.*missing/i.test(lower))
    return { argv: [], opts: { name: { required: true } } };
  if (/unknown|unrecognized/i.test(lower))
    return { argv: ["--unknown-xyz"], opts: {} };
  if (/long.form.*alias|alias.*long.form/i.test(lower))
    return { argv: ["--o", "value"], opts: { output: { alias: "o" } } };
  if (/missing.value|no.*following.value/i.test(lower))
    return { argv: ["--output"], opts: { output: {} } };
  if (/nan|non.numeric|number.*test/i.test(lower))
    return { argv: ["--count", "abc"], opts: { count: { type: "number" } } };
  if (/non.integer|integer.*(?:test|validation)/i.test(lower))
    return { argv: ["--count", "abc"], opts: { count: { type: "integer" } } };
  return null;
}

export function buildZeroArgInline(scenario: ZeroArgScenario, methodName: string): InlineDerived {
  // CLI parser: construct with options and call parse() separately
  if (scenario.callFn === "parseArgs" || scenario.callFn === "parseManually") {
    const cfgSpread = scenario.cfgText ? `, ...${scenario.cfgText}` : "";
    const lines = [
      `process.argv = ["node", "cli.js", ...${scenario.argvText}];`,
      `const _a = new _SubjectCtor({ options: ${scenario.optText}${cfgSpread}, parse: false });`,
    ];
    if (scenario.threw) {
      lines.push(`await expect(async () => { _a.parse(); }).toThrow();`);
    } else {
      lines.push(`_a.parse();`, `const r = _a.options;`);
      if (scenario.result != null && typeof scenario.result === "object") {
        for (const [key, val] of Object.entries(scenario.result as Record<string, unknown>)) {
          lines.push(`expect(r.${key}).toBe(${JSON.stringify(val)});`);
        }
      }
    }
    return { method: "create", callArgs: [], inspectCode: lines.join("\n") };
  }

  // General: use method + captures so the adapter generates the alias-correct call
  // (avoids hardcoding Subject.methodName which breaks on per-group module overrides)
  if (scenario.threw) {
    return { method: methodName, callArgs: [], outcomeType: "throws" };
  }
  const result = scenario.result;
  const assertionLines: string[] = [];

  if (result === null) {
    assertionLines.push(`expect(r).toBeNull();`);
  } else if (typeof result === "boolean" || typeof result === "number") {
    assertionLines.push(`expect(r).toBe(${JSON.stringify(result)});`);
  } else if (typeof result === "string") {
    assertionLines.push(`expect(r).toBe(${JSON.stringify(result)});`);
  } else if (Array.isArray(result)) {
    assertionLines.push(`expect(Array.isArray(r)).toBe(true);`);
    assertionLines.push(`expect(r.length).toBe(${result.length});`);
    if (result.length > 0 && typeof result[0] === "object" && result[0] !== null) {
      for (const [k, v] of Object.entries(result[0] as Record<string, unknown>)) {
        if (typeof v === "string" && !v.startsWith("/") && v.length < 80) {
          assertionLines.push(`expect(r[0].${k}).toBe(${JSON.stringify(v)});`);
        } else if (typeof v === "boolean" || typeof v === "number") {
          assertionLines.push(`expect(r[0].${k}).toBe(${JSON.stringify(v)});`);
        } else if (Array.isArray(v)) {
          assertionLines.push(`expect(r[0].${k}.length).toBe(${v.length});`);
        }
      }
    }
  } else if (typeof result === "object" && result !== null) {
    assertionLines.push(`expect(r).toBeDefined();`);
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === "string" && !v.startsWith("/") && v.length < 80) {
        assertionLines.push(`expect(r.${k}).toBe(${JSON.stringify(v)});`);
      } else if (typeof v === "boolean" || typeof v === "number") {
        assertionLines.push(`expect(r.${k}).toBe(${JSON.stringify(v)});`);
      } else if (Array.isArray(v)) {
        assertionLines.push(`expect(r.${k}.length).toBe(${v.length});`);
      }
    }
  } else {
    assertionLines.push(`expect(r).toBeDefined();`);
  }
  // Use method + captures so the adapter generates alias-correct call (not hardcoded Subject.)
  return { method: methodName, callArgs: [], captures: "r", inspectCode: assertionLines.join("\n") };
}

// ── Class-based CLI parser: commands + flags + tail args on one argv array ──
// Matches natural-language claim text directly (no **method:** annotation or synthetic API
// line needed) for the multi-tier argument model and exit/registration semantics that don't
// reduce to a single "result.FIELD === value" assertion -- command name and passThrough content
// aren't schema fields, so the generic result.FIELD matcher in resolveCliParserPatterns can't
// reach them. Gated on the same class-based process.argv-parser shape used throughout this
// file (this.options / this.tail assigned in the constructor), so it only fires for modules
// that actually implement it -- "commands", "tail", and "options" here name real instance
// properties this module assigns, not proper nouns borrowed from one project.
/** Whether the module declares a `parse()` method.
 *
 *  Every body this file emits constructs the class and calls `_a.parse()`, so a module without one
 *  cannot run any of it. The gates below check for `this.options =` / `this.commands =` /
 *  `this.tail =`, which a settings holder satisfies without being a parser at all -- and such a class
 *  got its claims reported as **failing**, because the derived test called a method that does not
 *  exist. Pending is the truthful state; this is what makes the gate match what the code needs.
 *
 *  Matched as a declaration at the start of a line, so a call site (`this.parse()`) is not mistaken
 *  for the method itself. */
export function declaresParseMethod(source: string): boolean {
  return /^\s*(?:async\s+)?parse\s*\([^)]*\)\s*\{/m.test(source)
    || /^\s*parse\s*=\s*(?:async\s*)?\(/m.test(source);
}

export function resolveCliClassPatterns(claim: string, facts: AstFacts): InlineDerived | null {
  const lower = claim.toLowerCase();
  const isClassCliParser = !!facts.constructorModulePath
    && /\bclass\s+\w+/.test(facts.source)
    && /\bthis\.options\s*=/.test(facts.source)
    && declaresParseMethod(facts.source);
  if (!isClassCliParser) return null;

  const hasCommands = /\bthis\.commands\s*=/.test(facts.source);
  const hasTail = /\bthis\.tail\s*=/.test(facts.source);

  if (hasCommands && /command.*consume.*first word|declared command consume/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "build", "--flag", "val"];`,
      `const _a = new _SubjectCtor({ commands: { build: {} }, options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.command).toBe("build");`,
    ].join("\n") };
  }

  if (hasCommands && /flag.*resolve.*command word precedes|command word precedes.*flag/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "build", "--flag", "val"];`,
      `const _a = new _SubjectCtor({ commands: { build: {} }, options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.options.flag).toBe("val");`,
    ].join("\n") };
  }

  if (hasTail && /tail argument capture its slot after all flags|tail.*after all flags are consumed/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "val", "target"];`,
      `const _a = new _SubjectCtor({ options: { flag: {} }, tail: [{ name: "target" }], parse: false });`,
      `_a.parse();`,
      `expect(_a.options.target).toBe("target");`,
    ].join("\n") };
  }

  if (hasCommands && hasTail && /all three categories|spanning all three/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "build", "--flag", "val", "target"];`,
      `const _a = new _SubjectCtor({ commands: { build: {} }, options: { flag: {} }, tail: [{ name: "target" }], parse: false });`,
      `_a.parse();`,
      `expect(_a.command).toBe("build");`,
      `expect(_a.options.flag).toBe("val");`,
      `expect(_a.options.target).toBe("target");`,
    ].join("\n") };
  }

  // Optional flag with no default stays absent (not null/empty) -- generic phrasing with no
  // literal "result.field" anchor for the field-matching path in resolveCliParserPatterns to find
  if (/does not appear in the options object|no-default.*absent|optional.*no default.*(?:not provided|absent)/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js"];`,
      `const _a = new _SubjectCtor({ options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.options.flag).toBeUndefined();`,
    ].join("\n") };
  }

  // "non-zero exit code" checked first: "zero exit code" is a literal substring of
  // "non-zero exit code" with no word boundary between them, so the /zero exit code/i check
  // below would otherwise match both claims and always win (it's unconditional; this one is
  // too), silently generating a zero-exit-code test for a non-zero-exit-code claim. Confirmed
  // live: a claim phrased "does an unknown flag produce a non-zero exit code?" was resolving
  // through the zero-exit branch and asserting against `-h` (which legitimately exits 0) -- a
  // wrong-but-passing test that never exercised the unknown-flag case its claim describes.
  if (/non-zero exit code/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--unknown-xyz"];`,
      `const _a = new _SubjectCtor({ options: {}, parse: false });`,
      `let _code = null;`,
      `try { _a.parse(); } catch (e) { _code = (e && typeof (e as any).code === "number") ? (e as any).code : 1; }`,
      `expect(_code).toBe(1);`,
    ].join("\n") };
  }

  if (/zero exit code/i.test(lower)) {
    const argv = /version/i.test(lower) ? "--version" : /help/i.test(lower) ? "--help" : "-h";
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "${argv}"];`,
      `const _a = new _SubjectCtor({ options: {}, parse: false });`,
      `let _code = null;`,
      `try { _a.parse(); } catch (e) { _code = (e && typeof (e as any).code === "number") ? (e as any).code : 1; }`,
      `expect(_code).toBe(0);`,
    ].join("\n") };
  }

  if (/registered in every schema by default/i.test(lower) && /disabled or replaced/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--help"];`,
      `const _a = new _SubjectCtor({ options: {}, defaults: { config: { help: false } }, parse: false });`,
      `await expect(async () => { _a.parse(); }).toThrow();`,
    ].join("\n") };
  }

  if (/parse:\s*false.*runs option registration immediately|registration immediately.*defers the argv walk/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "val"];`,
      `const _a = new _SubjectCtor({ options: { flag: { required: true } }, parse: false });`,
      `expect(_a.flagNames).toContain("flag");`,
      `expect(_a.requiredOptions).toContain("flag");`,
      `expect(_a.options).toBeUndefined();`,
    ].join("\n") };
  }

  if (/flag-like string after.*remain unparsed|after `--`.*remain unparsed/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--", "--flag"];`,
      `const _a = new _SubjectCtor({ options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.options.flag).toBeUndefined();`,
      `expect(_a.passThrough).toContain("--flag");`,
    ].join("\n") };
  }

  if (/flag before.*still parse correctly|before `--`.*still parse/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "val", "--", "extra"];`,
      `const _a = new _SubjectCtor({ options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.options.flag).toBe("val");`,
    ].join("\n") };
  }

  if (hasCommands && /command parsing stop.*first flag|no command word.*flag/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--flag", "val"];`,
      `const _a = new _SubjectCtor({ commands: { build: {} }, options: { flag: {} }, parse: false });`,
      `_a.parse();`,
      `expect(_a.command).toBeUndefined();`,
      `expect(_a.options.flag).toBe("val");`,
    ].join("\n") };
  }

  if (/falsy.?valued? option.*(?:ignored|no-?op)|null.*option.*(?:ignored|silently)/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `process.argv = ["node", "cli.js", "--real", "x"];`,
      `const _a = new _SubjectCtor({ options: { ghost: null, real: { type: "string" } }, parse: false });`,
      `_a.parse();`,
      `expect(_a.options.real).toBe("x");`,
    ].join("\n") };
  }

  if (/required flag appear.*usage text.*without.*brackets/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _a = new _SubjectCtor({ options: { name: { required: true, type: "string" }, other: { type: "string" } }, parse: false });`,
      `expect(_a.usageText).toContain("--name <");`,
      `expect(_a.usageText).not.toContain("[--name");`,
    ].join("\n") };
  }

  if (/optional flag appear.*usage text.*wrapped in brackets/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _a = new _SubjectCtor({ options: { name: { required: true, type: "string" }, other: { type: "string" } }, parse: false });`,
      `expect(_a.usageText).toContain("[--other <");`,
    ].join("\n") };
  }

  if (/versiontext.*include.*version.*(?:provided|package\.json)/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _a = new _SubjectCtor({ options: {}, packageJSON: { name: "x", version: "9.9.9", description: "" }, parse: false });`,
      `expect(_a.versionText).toContain("9.9.9");`,
    ].join("\n") };
  }

  if (/printhelp.*output.*include.*(?:flag.?s|a flag)?.*description/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _lines = [];`,
      `const _origLog = console.log;`,
      `console.log = (...a) => _lines.push(a.map(String).join(" "));`,
      `try { new _SubjectCtor({ options: { name: { type: "string", description: "the target name" } }, parse: false }).printHelp(); }`,
      `finally { console.log = _origLog; }`,
      `expect(_lines.join("\\n")).toContain("the target name");`,
    ].join("\n") };
  }

  if (/boolean flag.?s usage text omit.*value placeholder/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _a = new _SubjectCtor({ options: { flag: { type: "boolean" } }, parse: false });`,
      `expect(_a.usageText).not.toContain("<");`,
    ].join("\n") };
  }

  if (/mutating the caller.?s original option object after construction leave the registered flag config unchanged/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _optDef = { type: "string", description: "original" };`,
      `const _a = new _SubjectCtor({ options: { name: _optDef }, parse: false });`,
      `_optDef.description = "mutated";`,
      `expect(_a.config.name.description).toBe("original");`,
    ].join("\n") };
  }

  if (/printhelp.*output.*include.*(?:flag.?s|a flag)?.*default value/i.test(lower)) {
    return { method: "create", callArgs: [], inspectCode: [
      `const _lines = [];`,
      `const _origLog = console.log;`,
      `console.log = (...a) => _lines.push(a.map(String).join(" "));`,
      `try { new _SubjectCtor({ options: { name: { type: "string", defaultValue: "fallback-value" } }, parse: false }).printHelp(); }`,
      `finally { console.log = _origLog; }`,
      `expect(_lines.join("\\n")).toContain("fallback-value");`,
    ].join("\n") };
  }

  return null;
}


// ── Exit-code / parseArgs CLI derivation (modules with exitCode / checkExitCalled / parseArgs) ──
// Derives test calls for CLI exit-model and option-parsing tests from result.code /
// result.triggered / result.FIELD patterns in the description.
export function resolveCliParserPatterns(lower: string, apiDescription: string, facts: AstFacts): InlineDerived | null {
  // Same requirement as the class patterns: these bodies construct the subject and call `parse()`.
  if (facts.constructorModulePath && !declaresParseMethod(facts.source)) return null;

  const hasExitCode = "exitCode" in facts.exportVerbs
    || facts.source.includes("export const exitCode")
    || !!facts.mayCallProcessExit;
  const hasCheckExitCalled = facts.source.includes("export const checkExitCalled")
    || "checkExitCalled" in facts.exportVerbs
    || (!!facts.mayCallProcessExit && !!facts.usesProcessArgv);
  if (hasExitCode || hasCheckExitCalled) {
    // "result.code === N" → inline try/catch on new _SubjectCtor({parse:false}).parse()
    const codeMatch = lower.match(/result\.code\s*===\s*(\d+)/);
    if (codeMatch && hasExitCode) {
      const code = Number(codeMatch[1]);
      const argv = code === 0 && /help/i.test(lower) ? ["--help"]
                 : code === 0 && /version/i.test(lower) ? ["--version"]
                 : code === 0 && /-h\b|alias.*help|short.*help/i.test(lower) ? ["-h"]
                 : ["--unknown"];
      const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
      const code_ = [
        `process.argv = ["node", "cli.js", ${argvLiteral}];`,
        `const _a = new _SubjectCtor({ options: {}, parse: false });`,
        `let _exitCode = null;`,
        `try { _a.parse(); } catch (e) { _exitCode = (e && typeof (e as any).code === 'number') ? (e as any).code : 1; }`,
        `expect(_exitCode).toBe(${code});`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
    // "result.triggered === bool" → inline process.exit spy
    const trigMatch = lower.match(/result\.triggered\s*===\s*(true|false)/);
    if (trigMatch && hasCheckExitCalled) {
      const triggered = trigMatch[1] === "true";
      const argv = triggered ? ["--unknown"] : ["--flag", "val"];
      const opts = triggered ? {} : { flag: {} };
      const argvLiteral = argv.map(a => JSON.stringify(a)).join(", ");
      const code_ = [
        `process.argv = ["node", "cli.js", ${argvLiteral}];`,
        `let _triggered = false;`,
        `const _origExit = process.exit;`,
        `process.exit = () => { _triggered = true; };`,
        `try { new _SubjectCtor({ options: ${JSON.stringify(opts)} }); } finally { process.exit = _origExit; }`,
        `expect(_triggered).toBe(${triggered});`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
    // parseManually throws pattern → inline
    if (/throws.*parse.*false|parse.*false.*throws|invalid.*parse.*throw/i.test(lower)) {
      const code_ = [
        `process.argv = ["node", "cli.js", "--unknown"];`,
        `const _a = new _SubjectCtor({ options: {}, parse: false });`,
        `await expect(async () => { _a.parse(); }).toThrow();`,
      ].join("\n");
      return { method: "create", callArgs: [], inspectCode: code_ };
    }
  }

  // ── Parser test derivation (modules with a parseArgs(argv, options) entry point) ──
  // Derives test calls from result.FIELD === VALUE assertions in __lld_api descriptions.
  // Covers CLI parsers, option processors, or anything where the test pattern is:
  //   const r = await Subject.parseArgs(argv, options);  expect(r.FIELD).toBe(VALUE)
  // The argv and options are inferred from description keywords.
  // Require a class + default export when falling back to usesProcessArgv,
  // so the class-based constructor pattern above doesn't fire on any process.argv reader.
  const hasParseArgs = "parseArgs" in facts.exportVerbs
    || facts.source.includes("export const parseArgs")
    || (!!facts.usesProcessArgv && /\bclass\s+\w+/.test(facts.source) && !!facts.constructorModulePath);
  if (hasParseArgs) {
    // "a json-typed flag's value is the parsed object, not the raw string" -- natural-language
    // phrasing (no literal result.FIELD===VALUE to key off), so it needs its own case rather
    // than falling through to the generic result-assertion path below.
    if (/json.*type.*value.*(?:equal|is|produce).*parsed\s+object|json-typed.*parsed\s+object/i.test(lower)) {
      return {
        method: "create", callArgs: [],
        inspectCode: buildParseArgsInline(
          [`--data`, `{"a":1}`], { data: { type: "json" } }, `expect(r.data).toEqual({ a: 1 });`
        ),
      };
    }

    // Absent field: "result.FIELD → absent" or "result.FIELD is absent/undefined when not provided"
    // Field name can appear in description OR in the claim condition (before the arrow)
    const absentFieldMatch = lower.match(/result\.(\w+)\s*(?:→|is|be)?\s*(?:absent|undefined|not\s+present|not\s+set)/)
      ?? apiDescription.match(/result\.(\w+)\s*(?:→|is|be)?\s*(?:absent|undefined|not\s+present|not\s+set)/i);
    if (absentFieldMatch) {
      const field = absentFieldMatch[1];
      const { argv, opts } = deriveParseArgsInputs(field, undefined, lower);
      // Remove the flag from argv so it's not provided -- test the absent case
      const absentArgv = argv.filter(a => !String(a).startsWith(`--${field}`));
      return {
        method: "create", callArgs: [],
        inspectCode: buildParseArgsInline(absentArgv, opts, `expect(r.${field}).toBeUndefined();`),
      };
    }

    // Result assertion: "result.FIELD === VALUE" -- generate inline new _SubjectCtor(...) code
    const rm = lower.match(/result\.(\w+)\s*===\s*(["'])([^"']+)\2|(result\.(\w+)\s*===\s*(\w+))/);
    if (rm) {
      const field = rm[1] ?? rm[5];
      const rawVal = rm[3] ?? rm[6];
      const value = rawVal === "true" ? true : rawVal === "false" ? false
                  : rawVal === "undefined" || rawVal === "null" ? (rawVal === "null" ? null : undefined)
                  : !isNaN(Number(rawVal)) ? Number(rawVal) : rawVal;
      const { argv, opts } = deriveParseArgsInputs(field, value, lower);
      return {
        method: "create", callArgs: [],
        inspectCode: buildParseArgsInline(argv, opts, `expect(r.${field}).toBe(${JSON.stringify(value)});`),
      };
    }
    // Throws patterns for CLI validation failures. Covers both synthetic descriptions
    // ("throws when...") and natural-language claim wording ("cause parse to fail").
    if (/throws.*when|when.*throws|throws\s*$|cause.*to fail|to fail\b|fails?\b.*valid/i.test(lower)) {
      const t = deriveParseArgsThrowInputs(lower);
      if (t) return { method: "create", callArgs: [], inspectCode: buildParseArgsThrowInline(t.argv, t.opts, t.extra) };
    }
  }

  return null;
}

