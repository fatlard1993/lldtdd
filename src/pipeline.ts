// The three pipeline stages in composition order.
// parse → translate → synthesize
export { parse } from "./parser.ts";
export { translate } from "./translator/index.ts";
export { synthesize } from "./synthesis/index.ts";
export { lintFile } from "./linter.ts";
export { suggestFile } from "./suggest.ts";

import { parse } from "./parser.ts";
import { translate } from "./translator/index.ts";

// Zero-arg scenarios that document specific pipeline behaviors.
import { lintFile } from "./linter.ts";
import { suggestFile } from "./suggest.ts";
import { resolve } from "path";

const _doc = (body: string) => parse(`# Test\n> src/test.ts\n\n${body}`, "test.lld.md");
const _selfLld = resolve(import.meta.dir, "../lld/document.lld.md");

export const translatesDocumentGroupCount = () =>
  translate(_doc("## A decision\n- something holds")).then(suite => suite.groups.length);

export const unresolvedClaimProducesCase = () =>
  translate(_doc("## Obscure\n- xyzzy frobnicates the quux widget"))
    .then(suite => suite.groups.flatMap(g => g.cases).length > 0);

// Lint: a well-formed LLD produces zero errors
export const lintCleanDocument = () =>
  lintFile(_selfLld).then(r => r.errors);

// Lint: a document missing its title and module pointer has errors
export const lintMissingStructure = () =>
  lintFile(resolve(import.meta.dir, "../lld/fixtures/missing-structure.lld.md"))
    .then(r => r.errors);

// Suggest: reading an LLD produces a suggest result with a groups array
export const suggestOnCleanDocument = () =>
  suggestFile(_selfLld).then(r => Array.isArray(r.groups));

// When a claim has sub-perspectives, the parent becomes a pending summary;
// only the perspectives are individually translated into test cases.
export const perspectiveParentIsPending = () =>
  translate(_doc("## Group\n- the parent claim\n  - does the specific thing hold?"))
    .then(suite => {
      const parent = suite.groups[0]?.cases[0];
      return parent?.source === "needs-fixture"; // parent demoted to pending
    });

// AI-generated tests that only assert "resolves" with no captures are demoted
// to needs-fixture — they add no verification value.
export const weakAiIsDemoted = () =>
  translate(_doc("## Group\n- something completely unverifiable xyzzy quux blarg"))
    .then(suite => {
      const tc = suite.groups[0]?.cases[0];
      // Either pending (never reached AI) or needs-fixture (AI demoted)
      return tc?.source === "needs-fixture" || tc?.source === "ai"
        ? tc.source : "unexpected";
    });
