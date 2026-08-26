import { describe, it, expect, beforeAll } from "bun:test";
import { compareSourcesForDrift, compareImplementations, mapChangesToClaims } from "./drift.ts";
import { warmTsMorph, WARMUP_TIMEOUT_MS } from "./testWarmup.ts";

beforeAll(warmTsMorph, WARMUP_TIMEOUT_MS);

/**
 * Drift answers one question: has the implementation changed in a way that could invalidate what
 * the document already claims? The interesting half of that is what drift deliberately stays
 * quiet about -- adding a new export breaks nothing that was described before it, so it is not
 * drift, and reporting it would train authors to ignore the channel.
 *
 * `compareSourcesForDrift` takes two source strings and needs no git, which is what makes these
 * cheap. `detectDrift` is the same logic with a `git show` in front of it.
 */

const before = [
  "export function login(email: string, password: string) {",
  "  if (!email) throw new Error('no email');",
  "  return { token: 'x' };",
  "}",
].join("\n");

describe("compareSourcesForDrift", () => {
  it("returns null when the source is unchanged", () => {
    expect(compareSourcesForDrift(before, before, ["a claim"])).toBeNull();
  });

  it("reports nothing actionable when a function is only added", () => {
    // Addition cannot invalidate a claim that predates it. This is the deliberate silence.
    const after = before + "\nexport function logout() { return true; }\n";
    const report = compareSourcesForDrift(before, after, ["login rejects an unknown email"]);
    expect(report?.changes.every(c => c.type === "ADDED")).toBe(true);
    expect(report?.impacts ?? []).toEqual([]);
  });

  it("flags a removed function as a change", () => {
    const report = compareSourcesForDrift(before, "export function other() { return 1; }\n", []);
    expect(report?.changes.some(c => c.type === "REMOVED" && c.name === "login")).toBe(true);
  });

  it("flags a changed signature and links it to the claim that names the function", () => {
    const after = [
      "export function login(email: string, password: string, mfa: string) {",
      "  if (!email) throw new Error('no email');",
      "  return { token: 'x' };",
      "}",
    ].join("\n");
    const claims = ["login rejects an unknown email", "the cart total starts at zero"];
    const report = compareSourcesForDrift(before, after, claims);

    expect(report?.changes.some(c => c.type === "CHANGED" && c.name === "login")).toBe(true);
    const affected = (report?.impacts ?? []).flatMap(i => i.affectedClaims);
    expect(affected).toContain("login rejects an unknown email");
    expect(affected).not.toContain("the cart total starts at zero");
  });

  it("notices a dropped guard even when the signature is identical", () => {
    // The signature-only view would call this unchanged. A removed guard is exactly the kind of
    // silent behavioral shift the document's claims are supposed to be re-read against.
    const after = [
      "export function login(email: string, password: string) {",
      "  return { token: 'x' };",
      "}",
    ].join("\n");
    const report = compareSourcesForDrift(before, after, ["login fails safely on invalid input"]);
    expect(report).not.toBeNull();
    expect(report!.changes.some(c => c.name === "login" && c.type === "CHANGED")).toBe(true);
  });
});

describe("mapChangesToClaims", () => {
  it("never attributes claims to an added function", () => {
    const added = [{ type: "ADDED" as const, name: "login", diffs: [], risk: "low" as const }];
    expect(mapChangesToClaims(added, ["login does a thing"])).toEqual([]);
  });

  it("keeps a high-risk change even when no claim mentions it", () => {
    // An unclaimed high-risk change is the case most worth surfacing: the implementation moved
    // somewhere the document is entirely silent about.
    const removed = [{ type: "REMOVED" as const, name: "login", diffs: [], risk: "high" as const }];
    const mapped = mapChangesToClaims(removed, ["something unrelated"]);
    expect(mapped.length).toBe(1);
    expect(mapped[0].affectedClaims).toEqual([]);
  });
});

describe("compareImplementations", () => {
  const sig = (over: Record<string, unknown> = {}) => ({
    name: "f", params: [], returnType: "void", async: false,
    guards: [], hasTryCatch: false, throwCount: 0, branchCount: 0, ...over,
  });

  it("classifies presence and absence", () => {
    expect(compareImplementations({}, { f: sig() })[0].type).toBe("ADDED");
    expect(compareImplementations({ f: sig() }, {})[0].type).toBe("REMOVED");
    expect(compareImplementations({ f: sig() }, { f: sig() })).toEqual([]);
  });

  it("treats a function gaining a throw as a change", () => {
    const changes = compareImplementations({ f: sig() }, { f: sig({ throwCount: 1 }) });
    expect(changes[0].type).toBe("CHANGED");
  });
});
