// The __lld_api descriptor vocabulary: "methodName(args) -> returnType | description".
// This module owns both directions of it -- parsing descriptors the module declares (return
// types, default-field notes, result assertions emitted as expect() code) and generating
// descriptor lines purely from extracted AstFacts when the module declares none.
// generateApiFromTypes in morphExtractors.ts is the third producer of the same vocabulary;
// it lives there because its substance is ts-morph, not this grammar.

import type { AstFacts } from "./types.ts";

// ── Descriptor scraping ───────────────────────────────────────────────

export interface ApiDescriptorFacts {
  returnTypes: Record<string, string>;
  defaultFields: Record<string, { field: string; value: string }>;
  resultAssertions: Record<string, string>;
}

/** Parses __lld_api descriptor lines out of the combined source. */
export function scrapeApiDescriptors(allSource: string): ApiDescriptorFacts {
  // Parse __lld_api descriptor: "methodName(args) -> returnType | description"
  // Detects: boolean, boolean[], type[], throws
  const returnTypes: Record<string, string> = {};
  for (const m of allSource.matchAll(/\b(\w+)\s*\([^)]*\)\s*->\s*(\w+(\[\])?)/g)) {
    const raw = m[2].toLowerCase();
    returnTypes[m[1]] = raw.endsWith("[]") ? "array" : raw;
  }

  // Parse "result has default for X field" in __lld_api descriptions
  // e.g. "addFieldAndRead() -> object | ... result has default for new field"
  // → { addFieldAndRead: { field: "newField", value: "" } }
  const defaultFields: Record<string, { field: string; value: string }> = {};
  // "result has default for fieldName" where fieldName is camelCase
  for (const m of allSource.matchAll(/(\w+)\s*\([^)]*\)[^|]*\|[^`\n]*result has (?:an?\s+)?(?:empty string )?default for (\w+)\b/gi)) {
    defaultFields[m[1]] = { field: m[2], value: "" };
  }

  // Parse __lld_api result assertions from indented __lld_api lines only:
  //   "  methodName() -> type | ...; result.field is a string"
  //   "  methodName() -> type | ...; result.field === value"
  //   "  methodName() -> type | ...; result.field is defined"
  // Anchored to line-start whitespace to avoid matching code internals.
  const resultAssertions: Record<string, string> = {};
  for (const m of allSource.matchAll(/^\s+(\w+)\s*\([^)]*\)\s*->[^|]+\|[^\n]*result\.(\w+)\s+(===\s*"[^"]*"|is\s+a\s+\w+|is\s+defined)/gim)) {
    const method = m[1];
    const field  = m[2];
    const check  = m[3].trim();
    if (check.startsWith("===")) {
      resultAssertions[method] = `expect(r.${field}).toBe(${check.slice(3).trim()});`;
    } else if (/^is\s+a\s+(\w+)/i.test(check)) {
      const type = check.match(/^is\s+a\s+(\w+)/i)?.[1]?.toLowerCase() ?? "string";
      resultAssertions[method] = `expect(typeof r.${field}).toBe("${type}");`;
    } else if (/^is\s+defined/i.test(check)) {
      resultAssertions[method] = `expect(r.${field}).toBeDefined();`;
    }
  }

  return { returnTypes, defaultFields, resultAssertions };
}

// ── Derived API vocabulary ────────────────────────────────────────────
// Generates __lld_api-style descriptions purely from AstFacts patterns.
// No production-code annotation required.

export function generateDerivedApiFromFacts(facts: AstFacts): string {
  const lines: string[] = [];
  const schema = facts.schemas[0];

  // ── CRUD modules: derive virtual method vocabulary from schema + FK ──
  if (facts.isDefaultCrud && schema) {
    const entity   = schema.collection.replace(/ies$/, "y").replace(/s$/, "");
    const fields   = schema.fields;
    const req2     = fields.slice(0, 2);

    // create with only required fields
    lines.push(`  createMinimal() -> ${entity} | create with only required fields (${req2.join(" + ")}); an uncategorized ${entity} is a valid state`);

    // delete removes the record from its own collection -- generic to any CRUD entity
    lines.push(`  deletedBecomesAbsent() -> void | create a ${entity}, delete it, read it back by id; the deleted ${entity} is absent from the collection`);

    // create with FK field set -- one entry per FK
    for (const fkField of Object.keys(facts.foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      lines.push(`  createWith${cap}Field() -> ${entity} | create with ${fkField} field; the ${fkField} field holds a string value`);
    }

    // read related entities -- one entry per FK target with a resolved path
    for (const [relatedEntity] of Object.entries(facts.relatedEntityPaths)) {
      const plural = relatedEntity.endsWith("y")
        ? relatedEntity.slice(0, -1) + "ies"
        : relatedEntity + "s";
      const capPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
      lines.push(`  read${capPlural}() -> ${relatedEntity}[] | create two ${plural} and return them as a flat array`);
    }

    // update {field} -- descriptions must match resolveMethodCall pattern:
    // "create then update the {field} field; result.{field} === '{value}'"
    for (const field of fields.slice(0, 2)) {
      const cap   = field.charAt(0).toUpperCase() + field.slice(1);
      // Use a synthetic expected value appropriate to the field type
      const val   = field === "url" ? "https://example.com" : "Renamed";
      lines.push(`  update${cap}() -> ${entity} | create then update the ${field} field; result.${field} === "${val}"`);
    }

    // isolation test -- descriptions must match resolveMethodCall isolation pattern:
    // "create two {entityPlural}, change one's {fkField}; the other {entity} retains"
    for (const [fkField] of Object.entries(facts.foreignKeys)) {
      const cap = fkField.charAt(0).toUpperCase() + fkField.slice(1);
      const entityPlural = entity.endsWith("y")
        ? entity.slice(0, -1) + "ies"
        : entity + "s";
      lines.push(`  change${cap}Isolation() -> ${entity} | create two ${entityPlural}, change one's ${fkField}; result.${fkField} is defined`);
    }

    // afterDelete with orphan + move semantics -- only when THIS collection's createCRUD
    // call includes an afterDelete hook (not when it leaks from an imported module). A createStore
    // call's hooks were read from its own options, so they are this collection's already.
    const collectionHasAfterDelete = schema.factory === "createStore"
      ? schema.hooks.some(h => h.kind === "afterDelete")
      : new RegExp(
        `createCRUD\\s*\\(\\s*['"\`]${schema.collection}['"\`][\\s\\S]{0,500}afterDelete`
      ).test(facts.source);
    if (collectionHasAfterDelete) {
      // Detect the target collection referenced in the afterDelete hook body
      const afterDeleteCollMatch = facts.source.match(/afterDelete[\s\S]{0,200}database\.db\.data\.(\w+)/);
      const targetColl = afterDeleteCollMatch?.[1] ?? "items";
      const entityPlural2 = entity.endsWith("y") ? entity.slice(0,-1)+"ies" : entity+"s";
      lines.push(`  deleteOrphans() -> void | create a ${entity}, seed a ${targetColl} record with that ${entity} id directly into the db, delete the ${entity}; no ${targetColl} record retains the deleted ${entity} id`);
      lines.push(`  deleteAndMove() -> void | create two ${entityPlural2}, seed a ${targetColl} record assigned to the first, delete the first with moveTo=second id; the ${targetColl} record's ${entity} equals the second id`);
      lines.push(`  snapshotRestoresOnFailure() -> void | create a ${entity} and a destination ${entity}, seed two ${targetColl} records referencing it with one frozen to force a mid-loop failure, delete the ${entity} with moveTo the destination; the failure restores all affected ${targetColl} records to their pre-delete values`);
    }
  }

  // ── createStore collections: the store queues each change behind the last ──
  // The same vocabulary as a self-database's queue below, so a document's write-order and recovery
  // claims read the same whichever of the two holds the queue. What derives from it checks the order
  // against the store's own writes, so a store whose changes don't take turns fails the claim.
  if (facts.storeQueuesChanges && !facts.isSelfDatabase) {
    lines.push(`  writesInOrder() -> boolean | concurrent writes complete in order; write ordering is structural; returns true if queue order is preserved`);
    lines.push(`  queueFailThenRecover() -> boolean | a failed write does not stall the queue; error recovery is structural; returns true if queue continued after failure`);
  }

  // ── Self-database modules: write-queue and schema-evolution patterns ──
  if (facts.isSelfDatabase) {
    lines.push(`  readAll() -> object | reads require no network; returns all database data without any network call; proves local-only access`);

    // A serialized write queue, detected by its shape rather than its name. The signal is a
    // property seeded with an already-resolved promise and then reassigned from itself -- that
    // self-chaining is what makes writes serialize, whatever the property is called. The structural
    // gate (not a `_writeQueue` name check) is pinned by lld/fixtures/selfdb.ts.
    const queueProp = facts.source.match(/(\w+)\s*:\s*Promise\.resolve\(\)/)?.[1];
    const selfChains = queueProp
      ? new RegExp(`\\.${queueProp}\\s*=\\s*[\\w.]*\\.?${queueProp}\\b`).test(facts.source)
        || new RegExp(`\\b${queueProp}\\s*=\\s*[\\w.]*\\.?${queueProp}\\b`).test(facts.source)
      : false;

    if (queueProp && selfChains) {
      lines.push(`  writesInOrder() -> boolean | concurrent writes complete in order; write ordering is structural; returns true if queue order is preserved`);
      // Fault recovery: the queue swallows a rejection so the next caller still runs.
      if (facts.source.includes(".catch(")) {
        lines.push(`  queueFailThenRecover() -> boolean | a failed write does not stall the queue; error recovery is structural; returns true if queue continued after failure`);
      }
    }

    // A claim that "existing records get empty-string defaults for new fields" is not checkable
    // against a raw store: it has no declared field list to default against, so the check can only
    // manufacture the answer. It belongs on the module that declares the fields -- the CRUD family,
    // see "missing fields default to empty string" in GRAMMAR.md -- via a `**module:**` override when
    // the document is about persistence.
  }


  // ── Exit-code testing modules (export exitCode / checkExitCalled, or source calls process.exit) ──
  const hasExitCodeExport = "exitCode" in facts.exportVerbs
    || facts.source.includes("export const exitCode")
    || !!facts.mayCallProcessExit;
  const hasCheckExitExport = facts.source.includes("export const checkExitCalled")
    || "checkExitCalled" in facts.exportVerbs
    || (!!facts.mayCallProcessExit && !!facts.usesProcessArgv);
  if (hasExitCodeExport || hasCheckExitExport) {
    if (hasExitCodeExport) {
      lines.push(`  unknownFlagExitCode() -> options | validation error produces non-zero exit code; result.code === 1`);
      lines.push(`  helpExitCode() -> options | --help request produces zero exit code; result.code === 0`);
      lines.push(`  versionExitCode() -> options | --version request produces zero exit code; result.code === 0`);
      lines.push(`  shortHelpAlias() -> options | -h alias for --help produces zero exit code; result.code === 0`);
    }
    if (hasCheckExitExport) {
      lines.push(`  constructorExitsOnError() -> options | constructor catches the thrown exit signal and triggers process.exit; result.triggered === true`);
      lines.push(`  constructorNoExitOnSuccess() -> options | successful parse does not trigger process.exit; result.triggered === false`);
    }
    lines.push(`  parseManuallyFails() -> throws | the thrown exit signal propagates directly to caller with parse false; throws on invalid input`);
  }

  // ── CLI parser modules (export parseArgs + process.argv manipulation) ───────
  // Derives vocabulary from detected option features -- boolean negation, integer
  // types, aliases, required flags, sub-commands, tail args, etc. Works for any
  // module whose source reveals which option shapes it supports.
  const hasParseArgsExport = "parseArgs" in facts.exportVerbs
    || facts.source.includes("export const parseArgs")
    || (!!facts.usesProcessArgv && /\bclass\s+\w+/.test(facts.source) && !!facts.constructorModulePath)
    || Object.keys(facts.zeroArgScenarios).length > 0;
  if (hasParseArgsExport) {
    // Feature detection from module source
    const src = facts.source;
    const hasBoolean   = /\bparseBool\b|\bboolean\b/.test(src);
    const hasInteger   = /\bparseInteger\b|\binteger\b/.test(src);
    const hasNumber    = /\bnumber\b/.test(src);
    const hasAlias     = /\balias\b/.test(src);
    const hasRequired  = /\brequired\b/.test(src);
    const hasDefault   = /\bdefaultValue\b/.test(src);
    // Structural signal for tail-argument support: the instance property actually assigned
    // by the constructor (this.tail = ...), not a fictional __tail option key no real parser uses.
    // Command-word/tail-tier combinations (command consumed first, flag resolving alongside a
    // command, all three tiers together) are handled directly from claim text in
    // resolveCliClassPatterns, since their result fields (command name, tail's own declared
    // name) aren't guessable generically enough to describe as a synthetic API line here.
    const hasTail      = /\bthis\.tail\s*=/.test(src);
    const hasNoPrefix  = /\bno-/.test(src);

    if (hasTail && /\brest\b/.test(src)) {
      lines.push(`  restTailCaptures() -> array | rest tail argument captures all remaining tokens as an array; result.files[0] === "a"`);
    }

    // Assignment forms (always present for any flag parser)
    lines.push(`  spaceFormAssigns() -> options | space form assigns the value; result.flag === "value"`);
    lines.push(`  equalsFormAssigns() -> options | equals form assigns the same value; result.flag === "value"`);
    lines.push(`  passThroughDoesNotContaminate() -> options | post-separator content does not contaminate parsed options; result.flag === "val"`);
    lines.push(`  unknownFlagFails() -> throws | unknown flag causes error exit not silent continuation; throws when unrecognized flag encountered`);
    lines.push(`  missingValueFails() -> throws | non-boolean flag without a following value is an error; throws when value is missing`);

    // Boolean support
    if (hasBoolean) {
      if (hasNoPrefix) lines.push(`  booleanNegation() -> options | --no-prefix negates the flag without requiring a separate option; result.flag === false`);
      lines.push(`  builtinBooleanType() -> options | boolean type coerces truthy strings case-insensitively; result.flag === true`);
      lines.push(`  chainedShortFlags() -> options | chained short flags set each option independently; result.a === true`);
    }
    // Integer / number support
    if (hasInteger)  lines.push(`  builtinIntegerType() -> options | integer type produces a number; result.count === 5`);
    if (hasNumber)   lines.push(`  numberValidationRejectsNaN() -> throws | built-in number test rejects NaN after transform; throws for non-numeric input`);

    // Alias support
    if (hasAlias) {
      lines.push(`  canonicalNameFromAlias() -> options | canonical name appears in options when alias is used; result.flag === "val"`);
      lines.push(`  longFormShortAliasFails() -> throws | long form of short alias names a nonexistent option; throws when long form of short alias used`);
    }
    // Required / default support
    if (hasRequired) lines.push(`  requiredEnforced() -> throws | required flag must appear on the command line; throws when required flag is absent`);
    if (hasDefault)  lines.push(`  defaultFilled() -> options | defaults are applied after all parsing completes; result.name === "world"`);

    // Transform / test feature support -- detected from source structure, not helper exports.
    // Any CLI parser whose source uses defaults.transform or defaults.test gets these entries.
    if (/this\.defaults\.transform/.test(src)) {
      lines.push(`  pluggableTransform() -> create | transform map is replaceable; replacing string transform changes all string flags`);
      lines.push(`  perFlagTransformOverride() -> create | per-flag transform replaces type default; flag-level transform overrides built-in type coercion`);
    }
    if (/this\.defaults\.test|this\.#testOption/.test(src)) {
      lines.push(`  customTestRejection() -> throws | custom test receives coerced value and rejects; parse fails on invalid value`);
    }

    // Zero-arg arrow-fn scenarios: any exported () => call with ≥1 arg -- general, not case-specific
    for (const [name, scenario] of Object.entries(facts.zeroArgScenarios)) {
      const desc = scenario.threw
        ? `zero-arg arrow-fn ${scenario.callFn} scenario that throws`
        : `zero-arg arrow-fn ${scenario.callFn} scenario`;
      lines.push(`  ${name}() -> create | ${desc}`);
    }
  }

  // ── Function type chains -- pipeline stages that require setup ─────
  for (const [name, info] of Object.entries(facts.functionTypeChains ?? {})) {
    lines.push(`  ${name}(input) -> result | pipeline stage: output of ${info.chain.join(" → ")} → ${name}; calls ${name}`);
  }

  // ── Text transformer functions ─────────────────────────────────────
  for (const [name, info] of Object.entries(facts.textTransformerFunctions ?? {})) {
    if (info.returnsArray) {
      lines.push(`  ${name}(content) -> array | code processor: processes source code input and returns an array of results`);
    } else {
      lines.push(`  ${name}(content) -> document | text transformer: parses structured text input into a document object`);
    }
  }

  // ── Structural comparator functions -- one entry per scenario variant ──
  const comparatorDescriptions: Record<string, string> = {
    "NoChange":       "verifies identical implementations produce no changes",
    "RemovedExport":  "detects removed exports as high-risk drift",
    "RenameExport":   "detects that a rename produces two changes: one removal and one addition",
    "GuardRemoval":   "detects guard removal as behavioral drift",
    "NoCatch":        "detects try-catch removal as behavioral drift",
  };
  for (const [name, info] of Object.entries(facts.comparatorFunctions ?? {})) {
    const suffix = name.slice(info.realFunctionName.length); // "" for base, "NoChange" etc. for variants
    const desc = comparatorDescriptions[suffix] ?? "detects parameter and signature changes between two implementation snapshots";
    lines.push(`  ${name}(before, after) -> changes[] | structural comparator: ${desc}; calls ${info.realFunctionName}`);
  }

  return lines.join("\n");
}
