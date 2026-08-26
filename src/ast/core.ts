// AST-extraction core: reads implementation modules and derives AstFacts -- schema fields,
// default-value expressions, hook registrations, validation locations, complexity, call
// graphs, and every other structural signal the pattern catalogs in src/ast/patterns/ and
// src/ast/dispatch.ts key off of. No claim-vocabulary matching lives here -- this module
// only looks at source code, never at .lld.md claim text.
//
// This file is the driver: extractFactsFromSource sequences named stages and assembles the
// AstFacts they produce. The stages live where their substance is:
//   sourceScrapers.ts    regex over raw source
//   crudSchema.ts        the createCRUD-shaped fact cluster
//   moduleResolution.ts  every fact whose value is a path
//   morphExtractors.ts   real ts-morph AST work (and the degraded-extraction records)
//   apiVocabulary.ts     the __lld_api descriptor grammar, parsed and generated
//   zeroArgScenarios.ts  the one stage that may execute the module

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { AstFacts, ZeroArgScenario, DegradedExtraction } from "./types.ts";
import type { ExecutionOptions } from "../inference.ts";
import { deriveMockShape, deriveResponseMockShape } from "./mockShapes.ts";
import {
  scrapeExportVerbs, scrapeFaultTargets, scrapeLifecycleOptions, detectSelfDatabase,
  detectEventTargetClass, detectComponentClass, extractAllowlists, extractValidationLocations,
  inferLifecycleFunctions,
} from "./sourceScrapers.ts";
import {
  extractSchemas, detectDefaultCrudExport, buildEntityIndex, deriveForeignKeysFromHooks,
  addVirtualMethodReturnTypes,
} from "./crudSchema.ts";
import {
  resolveImports, resolveConstructorModulePath, resolveDatabaseModulePath,
  resolveRelatedEntityPaths, resolvePrimaryAction,
} from "./moduleResolution.ts";
import {
  extractComplexity, buildLocalCallGraph, extractTextTransformerFunctions,
  extractComparatorFunctions, extractFunctionTypeChains, generateApiFromTypes,
  extractForeignKeysFromTypes,
} from "./morphExtractors.ts";
import { scrapeApiDescriptors, generateDerivedApiFromFacts } from "./apiVocabulary.ts";
import { extractZeroArgScenarios } from "./zeroArgScenarios.ts";

/**
 * Analyses source content directly -- no file I/O, no dynamic calling.
 * Accepts optional pre-computed zeroArgScenarios for full fact extraction.
 * Use this when you have source content (e.g. synthetic test source) without a real file.
 */
export async function extractFactsFromSource(
  source: string,
  modulePath = "anonymous.ts",
  zeroArgScenarios: Record<string, ZeroArgScenario> = {},
  root: string = process.cwd()
): Promise<AstFacts> {
  // For real paths, resolve local imports transitively. For anonymous/synthetic sources, skip.
  // `root` bounds every file this reads to the project (see resolveImports / resolvePrimaryAction /
  // resolveReExportedSources); it is the same boundary the parser enforced on the module pointer.
  const importedFiles = (modulePath !== "anonymous.ts" && existsSync(modulePath))
    ? await resolveImports(source, modulePath, root)
    : [];
  const allSource = [source, ...importedFiles.map(f => f.text)].join("\n");
  const isJs = /\.(js|jsx|mjs)$/.test(modulePath);

  // Stages that ts-morph gives up on land here instead of in silence; see DegradedExtraction.
  const degraded: DegradedExtraction[] = [];

  const schemas = extractSchemas(allSource);
  const { returnTypes, defaultFields, resultAssertions } = scrapeApiDescriptors(allSource);
  const isDefaultCrud = detectDefaultCrudExport(source);
  const databaseModulePath = resolveDatabaseModulePath([{ path: modulePath, text: source }, ...importedFiles]);
  const isSelfDatabase = detectSelfDatabase(source, databaseModulePath);
  const { primaryAction, primaryActionModule } =
    await resolvePrimaryAction(source, allSource, modulePath, schemas.length > 0, root);

  // Derive HTTP mock response shape from existing withMockFetch calls in the module source.
  // The call arguments already show the correct shape -- extract the structure and normalize
  // values to FIELD_VALUES so synthetic data is consistent with the rest of the test suite.
  // Fallback: a module that declares where its results live (a results path plus a name or url
  // property) describes its own response shape, so build the mock from those declared keys.
  //
  // A third branch called the fallback with the literal string "fetch", which only ever produced
  // anything by reaching a table of one project's fixtures -- so it handed an unrecognized module
  // someone else's response shape. Deleting that table left it returning undefined always.
  const mockResponseShape = deriveMockShape(allSource)
    ?? deriveResponseMockShape(allSource);

  const { foreignKeys, entityTypes } = deriveForeignKeysFromHooks(schemas);

  // Enhance FK detection with TypeScript type analysis (optional string fields in interfaces)
  // and JSDoc @param annotations -- more reliable than hook analysis alone
  const typeFks = extractForeignKeysFromTypes(source, entityTypes, isJs, degraded);
  for (const [field, entity] of Object.entries(typeFks)) {
    if (!foreignKeys[field]) foreignKeys[field] = entity;
  }

  addVirtualMethodReturnTypes(returnTypes, schemas, foreignKeys, isSelfDatabase);

  // Hoisted out of the literal below because `pipelineStageModulePath` derives from it. Reading
  // it back off `this` inside a getter typed the receiver as the whole (possibly-promised)
  // return value, which has no such property -- a plain local is both correct and clearer.
  const functionTypeChains = extractFunctionTypeChains(source, modulePath, isJs, degraded, root);

  return {
    schemas,
    allowlists: extractAllowlists(allSource),
    validationLocations: extractValidationLocations(allSource),
    lifecycle: inferLifecycleFunctions(source),
    exportVerbs: scrapeExportVerbs(allSource),
    returnTypes,
    defaultFields,
    resultAssertions,
    complexity: extractComplexity(allSource, isJs),
    callGraph: buildLocalCallGraph(allSource, isJs),
    faultTargets: scrapeFaultTargets(allSource),
    entityIndex: buildEntityIndex(schemas),
    primaryAction,
    mockResponseShape,
    foreignKeys,
    entityTypes,
    isDefaultCrud,
    databaseModulePath,
    relatedEntityPaths: resolveRelatedEntityPaths(source, modulePath, foreignKeys),
    generatedApi: generateApiFromTypes(source, isJs),
    lifecycleOptions: scrapeLifecycleOptions(source),
    source: allSource,
    primaryActionModule,
    isSelfDatabase,
    usesProcessArgv:   /\bprocess\.argv\b/.test(source),
    mayCallProcessExit: /\bprocess\.exit\b/.test(source),
    constructorModulePath: resolveConstructorModulePath(source, modulePath),
    textTransformerFunctions: extractTextTransformerFunctions(source, isJs, degraded),
    comparatorFunctions: extractComparatorFunctions(source, isJs, degraded),
    functionTypeChains,
    pipelineStageModulePath: Object.keys(functionTypeChains).length > 0 ? modulePath : undefined,
    zeroArgScenarios,
    eventTargetClass: detectEventTargetClass(source),
    componentClass: detectComponentClass(source),
    degraded,
    get derivedApi() {
      // Lazy -- computed after the object is built so it can reference the full facts
      return generateDerivedApiFromFacts(this as AstFacts);
    },
  };
}

/** File-based entry point: reads the file, resolves imports, calls extractFactsFromSource.
 *
 *  Everything here is static except zero-arg scenario results, which require calling the module.
 *  `execute` gates exactly that one step and defaults to false -- see ExecutionOptions. */
export async function extractFacts(
  modulePath: string,
  { execute = false }: ExecutionOptions = {},
  root: string = process.cwd()
): Promise<AstFacts | null> {
  if (!existsSync(modulePath)) return null;
  let source: string;
  try { source = await readFile(modulePath, "utf-8"); } catch { return null; }
  const zeroArgScenarios = await extractZeroArgScenarios(source, modulePath, execute);
  return extractFactsFromSource(source, modulePath, zeroArgScenarios, root);
}
