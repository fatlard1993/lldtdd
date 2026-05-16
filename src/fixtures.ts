/**
 * Named fixture library for lldtdd test derivation.
 *
 * The translator selects fixtures by context (entity type, scenario qualifier).
 * These are fallbacks — schema-driven fixtures are generated dynamically when
 * the module has a detectable schema. Named fixtures here are used when the
 * schema doesn't carry enough information to synthesize the right test data.
 *
 * Scenarios: "minimal", "missing-[field]", "invalid-[property]", "with-[association]"
 */

export interface Fixture {
  data: unknown;
  /** Human-readable label used for vocabulary matching */
  labels: string[];
}

// ── Entity fixtures ───────────────────────────────────────────────────

export const ENTITY_FIXTURES: Record<string, Fixture> = {
  // Generic bookmark scenarios
  "bookmark": {
    labels: ["bookmark", "link", "record"],
    data: { name: "Test Name", url: "https://example.com" },
  },
  "bookmark-missing-name": {
    labels: ["bookmark without name", "missing name", "uncategorized"],
    data: { url: "https://example.com" },
  },
  "bookmark-with-category": {
    labels: ["bookmark with category", "categorized bookmark", "inline category"],
    data: { name: "Test Name", url: "https://example.com", category: { create: { name: "Work" } } },
  },

  // Search engine scenarios
  "search-engine": {
    labels: ["search engine", "engine", "provider"],
    data: {
      name: "test-engine",
      url: "https://api.example.com/search?q=:term",
      resultsPath: "results",
      nameResultsPath: "",
      nameProperty: "title",
      urlProperty: "url",
      limit: "5",
      orderBy: "",
    },
  },
  "bad-protocol-engine": {
    labels: ["dangerous protocol", "bad protocol", "invalid protocol", "javascript protocol", "disallowed protocol"],
    data: {
      name: "bad-proto",
      url: "javascript:alert(':term')",
      resultsPath: "results",
      nameResultsPath: "",
      nameProperty: "",
      urlProperty: "",
      limit: "5",
      orderBy: "",
    },
  },
  "second-search-engine": {
    labels: ["second engine", "alternative engine", "different schema"],
    data: {
      name: "engine-two",
      url: "https://api.other.com/find/:term",
      resultsPath: "items",
      nameResultsPath: "",
      nameProperty: "label",
      urlProperty: "link",
      limit: "3",
      orderBy: "",
    },
  },

  // Default engine configuration — shared field defaults for creating any search engine
  // The meaningful values (url, name) vary per scenario; these fields are always present
  "engine-config-defaults": {
    labels: ["engine config", "default engine config", "search engine fields"],
    data: {
      resultsPath: "results",
      nameResultsPath: "",
      nameProperty: "title",
      urlProperty: "url",
      limit: "5",
      orderBy: "",
    },
  },

  // Category entity fixture
  "category": {
    labels: ["category", "tag", "label", "group"],
    data: { name: "Test Category", color: "" },
  },

  // Search result scenarios
  "search-results": {
    labels: ["search results", "results", "links"],
    data: [
      { title: "Result One", url: "https://example.com/one" },
      { title: "Result Two", url: "https://example.com/two" },
    ],
  },
};

// ── Fault scenarios ───────────────────────────────────────────────────
// "a failed X" in a design claim maps to one of these fault patterns.

export interface FaultScenario {
  /** The entity being made to fail — matches claim vocabulary */
  entityLabels: string[];
  /** Human description of the fault */
  description: string;
  /** The fault injection target path: "object.method" */
  targetPath: string;
  /** How many times the fault fires before recovering */
  failCount: number;
}

export const FAULT_SCENARIOS: FaultScenario[] = [
  {
    entityLabels: ["fetch", "request", "http request", "network request"],
    description: "simulated network failure",
    targetPath: "global.fetch",
    failCount: 1,
  },
];

// ── Fixture selection ─────────────────────────────────────────────────

export function selectFixture(claimText: string): Fixture | null {
  const lower = claimText.toLowerCase();
  // Score each fixture by how many of its labels appear in the claim
  let best: Fixture | null = null;
  let bestScore = 0;

  for (const fixture of Object.values(ENTITY_FIXTURES)) {
    const score = fixture.labels.filter(l => lower.includes(l)).length;
    if (score > bestScore) { bestScore = score; best = fixture; }
  }

  return bestScore > 0 ? best : null;
}

export function selectFaultScenario(claimText: string): FaultScenario | null {
  const lower = claimText.toLowerCase();
  let best: FaultScenario | null = null;
  let bestScore = 0;

  for (const scenario of FAULT_SCENARIOS) {
    const score = scenario.entityLabels.filter(l => lower.includes(l)).length;
    if (score > bestScore) { bestScore = score; best = scenario; }
  }

  return bestScore > 0 ? best : null;
}
