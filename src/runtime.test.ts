import { describe, it, expect } from "bun:test";
import { withSeedAndRead, withFaultInjection, withIsolationTest, withOrderTracking } from "./runtime.ts";

/**
 * These helpers are the assertion surface of the derivation engine: a generated test calls one and
 * asserts on what it returns, so whatever a helper *manufactures* is not evidence about the module
 * under test. Four of them manufactured something, and every claim reaching them was a false pass --
 * green against an implementation that did nothing.
 *
 * The one that made the pattern visible was `withSchemaEvolution`, which ended with
 * `read[newField] ?? ""` and was then asserted with `expect(r.newField).toBe("")` -- a tautology that
 * held while the write path was sabotaged to discard every record. It is gone; the check it backed
 * was not answerable at all (see ast/core.ts).
 *
 * Each test below sabotages the subject in the way the claim exists to rule out, and asserts the
 * helper reports it. A helper that cannot fail is worse than no coverage, because nothing
 * downstream distinguishes it from a real pass.
 */

describe("withSeedAndRead", () => {
  it("does not report success when nothing was created", () => {
    // `Array.isArray(result)` was the generated assertion, and the helper coerces its return to an
    // array -- so the check was a fact about the helper. The count is the claim.
    const empty = withSeedAndRead(async () => {}, () => ({}), [{ a: 1 }, { a: 2 }]);
    return empty.then(r => expect(r.length).toBeLessThan(2));
  });

  it("returns every created record when create actually works", async () => {
    const store: Record<string, { id: string }> = {};
    let n = 0;
    const r = await withSeedAndRead(
      async d => { const id = `id${++n}`; store[id] = { ...(d as object), id }; },
      () => store,
      [{ a: 1 }, { a: 2 }]
    );
    expect(r).toHaveLength(2);
  });
});

describe("withFaultInjection", () => {
  it("reports failure when the trigger never reaches the faulted method", async () => {
    // No fault was injected, so no recovery was observed. This returned `true`, which let
    // "a failed write does not stall the queue" pass against a run where no write ever failed --
    // in practice, a misresolved fault target reported as a working one.
    const target: Record<string, unknown> = { write: async () => "real" };
    expect(await withFaultInjection(target, "write", async () => "never calls write")).toBe(false);
  });

  it("reports success when the fault fires and the subject recovers", async () => {
    const target: Record<string, unknown> = { write: async () => "real" };
    expect(await withFaultInjection(target, "write", () => (target.write as () => Promise<unknown>)())).toBe(true);
  });

  it("reports failure when the subject does not recover", async () => {
    const target: Record<string, unknown> = { write: async () => { throw new Error("always down"); } };
    expect(await withFaultInjection(target, "write", () => (target.write as () => Promise<unknown>)())).toBe(false);
  });

  it("restores the original method whichever way it went", async () => {
    const original = async () => "real";
    const target: Record<string, unknown> = { write: original };
    await withFaultInjection(target, "write", async () => "never calls write");
    expect(target.write).toBe(original);
  });
});

describe("withIsolationTest", () => {
  const registry = () => {
    const store: Record<string, Record<string, unknown>> = {};
    let n = 0;
    const ops = {
      create: async (d: Record<string, unknown>) => {
        const id = `id${++n}`;
        store[id] = { ...d, id };
        return store[id] as Record<string, unknown> & { id: string };
      },
      read: async (id: string) => store[id],
      readAll: () => store,
    };
    return { store, ops };
  };

  const reassign = { type: "reassign" as const, contextEntity: "ctx", field: "ctx", fixture: { name: "Solo" } };

  it("surfaces a mutation that leaked onto the untouched entity", async () => {
    // `expect(result).toBeDefined()` was the generated assertion, so it passed for an update that
    // reassigned every record in the store -- exactly what an isolation claim rules out.
    const { ops } = registry();
    const leaky = { ...ops, update: async (_id: string, fields: Record<string, unknown>) => {
      for (const key of Object.keys(ops.readAll())) Object.assign(ops.readAll()[key], fields);
    } };
    const r = await withIsolationTest({ ctx: leaky, ent: leaky }, "ctx", "ent", "ctx", { name: "S" }, { name: "T" }, reassign);
    expect(r.untouched[r.contextField]).not.toBe(r.sharedContextId);
  });

  it("confirms isolation when the update touches only its own record", async () => {
    const { store, ops } = registry();
    const clean = { ...ops, update: async (id: string, fields: Record<string, unknown>) => {
      Object.assign(store[id], fields);
    } };
    const r = await withIsolationTest({ ctx: clean, ent: clean }, "ctx", "ent", "ctx", { name: "S" }, { name: "T" }, reassign);
    expect(r.untouched[r.contextField]).toBe(r.sharedContextId);
  });
});

describe("withOrderTracking", () => {
  it("reports the order operations actually completed in, not the order they were submitted", async () => {
    // The one helper in this file that never manufactured anything. Pinned because the whole point
    // is that it reports what happened: a second trigger that finishes first must show up as first.
    const order = await withOrderTracking(
      () => new Promise(res => setTimeout(res, 20)),
      () => Promise.resolve(),
    );
    expect(order[0]).toBe(2);
  });
});
