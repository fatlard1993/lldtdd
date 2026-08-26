// Caching-fetch-client claim derivation: for modules that export HTTP-verb functions returning a
// result carrying both a data state and a network state.
//
// This is the vocabulary of the caching-data-fetching niche, not one library's invention:
// `enabled`, `select`, `status`, and `isFetching` are the names React Query, SWR, and their
// relatives all use, and the verbs are the HTTP methods themselves. A module in that niche is
// recognizable from its structure, which is what makes a shipped family appropriate here.
//
// Two rules keep it from becoming the example-anchored crutch this project has now removed twice:
//
//   1. Every identifier in the emitted code is read off the module -- the verb name comes from the
//      module's own exports, never from a literal in this file. A project that exports `GET`/`POST`
//      gets tests against its own functions whatever else it named things.
//   2. Each test uses a URL unique to itself. Cache keys in this niche derive from method + URL, so
//      distinct URLs isolate tests from each other without needing a reset function -- whose name
//      *would* be project-specific. That is the difference between gating on structure and guessing
//      at an API.
//
// The claim regexes select which documented contract is being described; they do not carry the
// test. Rewording a claim within the same vocabulary still resolves.

import type { AstFacts, InlineDerived } from "../types.ts";

/** HTTP methods a module in this niche exports as functions. The protocol's verbs, not a
 *  library's chosen names. */
const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The verbs this module actually exports, whether declared individually
 *  (`export const GET = ...`) or destructured from a factory
 *  (`export const { GET, POST } = createClient()`). */
function exportedVerbs(source: string): string[] {
  return HTTP_VERBS.filter(verb =>
    new RegExp(`export\\s+const\\s+${verb}\\s*=`).test(source)
    || new RegExp(`export\\s+const\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}`, "s").test(source)
  );
}

/** Whether the module returns a result that separates data state from network state.
 *
 *  Both halves are required. `isFetching` alone appears in plenty of code that is not a cache, and
 *  an idle/loading/success/error union alone describes any state machine; together they are the
 *  signature of this niche's result object. */
function hasFetchResultShape(source: string): boolean {
  const hasNetworkState = /\bisFetching\b/.test(source);
  const hasDataState = /['"]idle['"]/.test(source)
    && /['"]loading['"]/.test(source)
    && /['"]success['"]/.test(source)
    && /['"]error['"]/.test(source);
  return hasNetworkState && hasDataState;
}

/** True when this family applies to the module at all. Checked by the caller before deriving. */
export function isCachingFetchClient(facts: AstFacts): boolean {
  return exportedVerbs(facts.source).length > 0 && hasFetchResultShape(facts.source);
}

/** A URL unique to one derived test, so cache entries never collide across tests. */
let urlCounter = 0;
function uniqueUrl(tag: string): string {
  return `https://lld.example.com/${tag}-${++urlCounter}`;
}

/** Test seam: derivation must be reproducible, so the counter resets per suite. */
export function resetHttpClientUrls(): void {
  urlCounter = 0;
}

/** A fetch stub that records how many times it was called and returns `body` as 200 JSON.
 *  Written inline rather than taken from runtime.ts because these tests need the call *count*,
 *  which `withMockFetch` does not expose. */
function countingFetch(body: string): string[] {
  return [
    `const _origFetch = globalThis.fetch;`,
    `let _fetchCount = 0;`,
    `globalThis.fetch = () => { _fetchCount++; return Promise.resolve({`,
    `  ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),`,
    `  json: () => Promise.resolve(${body}), text: () => Promise.resolve(JSON.stringify(${body})),`,
    `}); };`,
  ];
}

const RESTORE_FETCH = `globalThis.fetch = _origFetch;`;

export function deriveHttpClientInline(claim: string, facts: AstFacts): InlineDerived | null {
  if (!isCachingFetchClient(facts)) return null;

  const verbs = exportedVerbs(facts.source);
  const get = verbs.includes("GET") ? "GET" : verbs[0];
  // A write verb, for the cache-behavior contrast. POST if present, else any non-GET the module has.
  const write = verbs.find(v => v === "POST") ?? verbs.find(v => v !== get);
  const inline = (lines: string[]): InlineDerived =>
    ({ method: undefined, callArgs: [], inspectCode: lines.join("\n") });

  // ── enabled: false → idle, and no request ────────────────────────────
  // Two separate contracts on the same option: what the result *says*, and what the client *does*.
  // Neither needs the network, which is what makes them the most reliable pair in this family.
  if (/enabled:?\s*false/i.test(claim) && /\bidle\b/i.test(claim)) {
    return inline([
      `const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("disabled-idle"))}, { enabled: false });`,
      `expect(_r.status).toBe("idle");`,
    ]);
  }

  if (/enabled:?\s*false/i.test(claim)
      && /(?:not|never|n't)\s+(?:hit|fetch|request|call)|no\s+(?:network|request|fetch)|response\s+empty|never\s+fetch/i.test(claim)) {
    return inline([
      ...countingFetch("{ ok: true }"),
      `try {`,
      `  const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("disabled-nofetch"))}, { enabled: false });`,
      `  expect(_fetchCount).toBe(0);`,
      `  expect(_r.response).toBeFalsy();`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── 2xx → success ────────────────────────────────────────────────────
  if (/2xx|\bsuccess\b/i.test(claim) && /status/i.test(claim) && !/isFetching/i.test(claim)) {
    return inline([
      ...countingFetch(`{ value: "ok" }`),
      `try {`,
      `  const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("success-status"))});`,
      `  expect(_r.status).toBe("success");`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── isFetching is false once the request settles ─────────────────────
  if (/isFetching/i.test(claim)
      && /(?:settle|back\s+to\s+false|false\s+once|completes?|completion)/i.test(claim)) {
    return inline([
      ...countingFetch(`{ value: "ok" }`),
      `try {`,
      `  const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("isfetching-settles"))});`,
      `  expect(_r.isFetching).toBe(false);`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── select transforms the delivered body; the cache keeps the raw one ──
  if (/\bselect\b/i.test(claim)
      && /transform|return\s+value|projection|shaped/i.test(claim)
      && !/two\s+subscribers|different\s+select|each\s+receive/i.test(claim)) {
    return inline([
      ...countingFetch(`{ value: "raw" }`),
      `try {`,
      `  const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("select-transform"))}, {`,
      `    select: (_b) => ({ value: "transformed" }),`,
      `  });`,
      `  expect(_r.body.value).toBe("transformed");`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── select is not applied to a failed request ────────────────────────
  // The stub fails the request, so a select that would throw proves it was never invoked: the
  // assertion is that the call resolves at all, not merely that some field is unchanged.
  if (/\bselect\b/i.test(claim) && /not\s+called|fails?|error/i.test(claim)) {
    return inline([
      `const _origFetch = globalThis.fetch;`,
      `globalThis.fetch = () => Promise.resolve({`,
      `  ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }),`,
      `  json: () => Promise.resolve({ message: "boom" }), text: () => Promise.resolve("boom"),`,
      `});`,
      `try {`,
      `  const _r = await Subject.${get}(${JSON.stringify(uniqueUrl("select-on-error"))}, {`,
      `    select: () => { throw new Error("select must not run on an error result"); },`,
      `  });`,
      `  expect(_r.status).toBe("error");`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── a GET is fetched once, then served from cache ────────────────────
  if (/\bcache/i.test(claim)
      && /once|subsequent|serve[ds]?\s+from\s+cache|identical/i.test(claim)
      && !/never|not\s+cached|mutation|write/i.test(claim)) {
    const url = JSON.stringify(uniqueUrl("get-cached"));
    return inline([
      ...countingFetch(`{ value: "ok" }`),
      `try {`,
      `  await Subject.${get}(${url});`,
      `  await Subject.${get}(${url});`,
      `  expect(_fetchCount).toBe(1);`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  // ── a write is never served from cache ───────────────────────────────
  if (write && /never\s+served\s+from\s+cache|not\s+cached|each\s+call\s+hits\s+the\s+network/i.test(claim)) {
    const url = JSON.stringify(uniqueUrl("write-uncached"));
    return inline([
      ...countingFetch(`{ value: "ok" }`),
      `try {`,
      `  await Subject.${write}(${url}, { body: { a: 1 } });`,
      `  await Subject.${write}(${url}, { body: { a: 1 } });`,
      `  expect(_fetchCount).toBe(2);`,
      `} finally { ${RESTORE_FETCH} }`,
    ]);
  }

  return null;
}
