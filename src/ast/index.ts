/**
 * AST inspector for the translation layer.
 *
 * Reads implementation modules and extracts semantic facts that the translator
 * can use to derive tests directly from the implementation:
 *   - Schema field lists (from createCRUD / similar factory patterns)
 *   - Default value expressions (e.g. ?? '' means "defaults to empty string")
 *   - Protocol / format allowlists (ALLOWED_PROTOCOLS, etc.)
 *   - Hook registrations (beforeCreate, beforeUpdate) and their trigger conditions
 *   - Validation code location (which function contains which check)
 *
 * This is the public entry point -- src/ast/core.ts does the extraction, src/ast/patterns/*
 * hold the claim-vocabulary catalogs, and src/ast/dispatch.ts composes them. No design
 * principle governs this split more than the one below.
 *
 * NO FALSE PASS: every pattern in src/ast/patterns/* must fail (return null, not a
 * guessed-right answer) when it cannot confidently derive the right test for a claim.
 * A pattern that matches too loosely and produces *a* test rather than *the* test turns
 * a real behavioral gap into a green checkmark, worse than no coverage, because nothing
 * downstream distinguishes "verified" from "guessed and got lucky". Real bugs are caught
 * because a pattern is written narrow enough to fail honestly on the wrong behavior, not
 * because it happens to catch something extra. When adding or loosening a pattern, ask
 * whether it could now match a claim describing different behavior and silently derive the
 * wrong assertion for it; if so, narrow it or split it, the way COMPONENT_PATTERNS's header
 * comment describes for regex-collision risk specifically. src/ast.test.ts is the regression
 * net: it pins the exact derived output for every claim a shipped pattern matches, so a
 * widened match shows up as a snapshot diff.
 *
 * The inverse failure has a name too: a pattern keyed to the near-exact prose of one claim goes
 * silently *pending* the moment that claim is reworded. NO FALSE PASS and no false pending are
 * the same discipline: a claim's state must reflect the implementation, never the phrasing.
 */

// Public barrel -- the only file external code should import from.

export * from "./types.ts";
export { extractFacts, extractFactsFromSource } from "./core.ts";
export { resolveMethodCall, deriveInline } from "./dispatch.ts";
export { deriveComponentInline, COMPONENT_PATTERNS, matchIsGeneralizing } from "./patterns/component.ts";
export { deriveEventTargetInline } from "./patterns/event-target.ts";
export { deriveHttpClientInline, isCachingFetchClient, resetHttpClientUrls } from "./patterns/http-client.ts";
