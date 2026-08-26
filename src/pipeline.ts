// The package's library entry point (`import { ... } from "lldtdd"`).
//
// The three pipeline stages in composition order -- parse → translate → synthesize -- plus the
// commands that operate on a document without running it, and the two whole-pipeline runners.
// Nothing here reaches into src/cli.ts, which destructures process.argv at module scope and
// exists to be a program, not an API.
export { parse, parseFile } from "./parser.ts";
export { translate } from "./translator/index.ts";
export { synthesize } from "./synthesis/index.ts";
export { lintFile } from "./linter.ts";
export { suggestFile, applyInferences } from "./suggest.ts";
export { runSuite } from "./bunRunner.ts";
export { detectDrift } from "./drift.ts";

// Full-pipeline entry points: glob a directory of documents, or run one from a string in memory.
// Both take `{ silent: true }` for programmatic use -- same pipeline, no terminal output.
export {
  runAndCheck, runContentAndCheck, runDocument, runDocumentWithMutations,
  DEFAULT_GLOB_IGNORE, type RunOutcome,
} from "./run.ts";

export type {
  LLDDocument, LLDGroup, RawAssertion,
  TestSuite, TestGroup, TestCase, TranslationSource,
  CaseResult, RunResult,
} from "./types.ts";
