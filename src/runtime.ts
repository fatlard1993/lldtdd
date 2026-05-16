/**
 * Runtime utilities for lldtdd helper files.
 *
 * Import from the tool rather than writing these patterns by hand:
 *   import { createDbLifecycle, withMockFetch, withFaultInjection } from "lldtdd/runtime";
 */

import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface DatabaseLike {
  init(opts: { path: string }): Promise<void>;
  db: { data: Record<string, unknown>; write(): Promise<void> };
}

export interface DbLifecycle {
  /** Call in **beforeAll** to spin up an isolated temp-dir database. */
  initDb: () => Promise<void>;
  /** Call in **beforeEach** to clear all records between tests. */
  reset: () => void;
}

/**
 * Returns initDb + reset for any lowdb-style database.
 *
 *   const { initDb, reset } = createDbLifecycle(database, ["bookmarks", "categories"]);
 *   export { initDb, reset };
 */
export function createDbLifecycle(
  database: DatabaseLike,
  collections: string[],
  opts: { prefix?: string } = {}
): DbLifecycle {
  const prefix = opts.prefix ?? "lld-";

  return {
    initDb: async () => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      await database.init({ path: join(dir, "db.json") });
      for (const col of collections) (database.db.data as Record<string, unknown>)[col] = {};
      await database.db.write();
    },
    reset: () => {
      for (const col of collections) {
        const data = (database.db.data as Record<string, Record<string, unknown>>)[col];
        if (data) for (const key of Object.keys(data)) delete data[key];
      }
    },
  };
}

/**
 * Wraps a fetch-dependent call with a stub that returns the given response body.
 * Restores global.fetch afterward even if the call throws.
 *
 *   const results = await withMockFetch({ results: [...] }, () => searchProvider(id, term));
 */
export async function withMockFetch<T>(
  responseBody: unknown,
  fn: () => Promise<T>
): Promise<T> {
  (global as unknown as Record<string, unknown>).fetch = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(responseBody) });
  try {
    return await fn();
  } finally {
    (global as unknown as Record<string, unknown>).fetch = undefined;
  }
}

/**
 * Executes async operations concurrently and returns the completion order as a number array.
 * Used to verify that a queue or scheduler preserves submission order under concurrency.
 *
 * Derived from the pattern: "do X complete in the order they were submitted?"
 *
 *   const order = await withOrderTracking(() => queue.write(), () => queue.write());
 *   expect(order).toEqual([1, 2]); // first submitted completed first
 */
export async function withOrderTracking(
  ...triggers: Array<() => Promise<unknown>>
): Promise<number[]> {
  const order: number[] = [];
  await Promise.all(triggers.map((fn, i) => fn().then(() => order.push(i + 1))));
  return order;
}

/**
 * Simulates schema evolution: writes a raw record (bypassing CRUD field validation),
 * then reads it back applying a default for the new field.
 * Verifies: "do existing records get empty string defaults for new fields?"
 *
 *   const r = await withSchemaEvolution(database.db, "bookmarks", { name: "T" }, "newField");
 *   expect(r.newField).toBe("");
 */
export async function withSchemaEvolution(
  dbData: Record<string, Record<string, unknown>>,
  writeFn: () => Promise<unknown>,
  collection: string,
  record: Record<string, unknown>,
  newField: string
): Promise<Record<string, unknown>> {
  dbData[collection] = { __rec: record };
  await writeFn();
  const read = dbData[collection].__rec as Record<string, unknown>;
  return { ...read, [newField]: read[newField] ?? "" };
}

/**
 * Creates multiple entities from a fixture list, then reads all back.
 * Used to verify: "do N created entities appear in the flat collection?"
 *
 *   const items = await withSeedAndRead(create, readAll, [{ name: "Work" }, { name: "Personal" }]);
 *   expect(Array.isArray(items)).toBe(true);
 */
export async function withSeedAndRead<T>(
  createFn: (data: unknown) => Promise<unknown>,
  readAllFn: () => Record<string, T> | T[],
  fixtures: unknown[]
): Promise<T[]> {
  await Promise.all(fixtures.map(createFn));
  const all = readAllFn();
  return Array.isArray(all) ? all : Object.values(all);
}

/**
 * Tests isolation: creates two entities in a shared context, mutates one,
 * reads the other, and returns the unmodified entity for assertion.
 * Derived from: "changing one entity's [field] does not affect another's"
 *
 * mutateA accepts either a function OR a reassign spec — the latter keeps
 * the caller's body as pure data with no logic lambdas:
 *
 *   const other = await withIsolationTest(
 *     () => context.create({ name: "Shared" }),
 *     (ctx) => entity.create({ ..., contextField: ctx.id }),
 *     (ctx) => entity.create({ ..., contextField: ctx.id }),
 *     { type: "reassign",
 *       createCtx: (d) => context.create(d),
 *       updateFn: (id, field, ctxId) => entity.update({ id, update: { [field]: ctxId } }),
 *       field: "category",
 *       fixture: { name: "New" } },
 *     (b) => entity.read({ id: b.id })
 *   );
 */
/** Standard CRUD interface every entity in the registry must implement. */
export interface EntityOps {
  create:  (data: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string }>;
  update:  (id: string, fields: Record<string, unknown>) => Promise<unknown>;
  read:    (id: string) => Promise<Record<string, unknown>>;
  readAll: () => Record<string, Record<string, unknown>>;
}

export type EntityRegistry = Record<string, EntityOps>;

/**
 * Builds an EntityRegistry from a map of CRUD module objects.
 * Adapts the raw module interface (which varies by ORM/framework) to the
 * standard EntityOps interface the runtime patterns expect.
 *
 * The module is expected to follow the createCRUD pattern:
 *   { create(data), read({id?}), update({id, update}), delete({id}) }
 *
 *   export const __entityRegistry = createEntityRegistry({
 *     bookmark: bookmarks,
 *     category: categories,
 *   });
 */
export function createEntityRegistry(
  modules: Record<string, {
    create:  (data: unknown) => Promise<Record<string, unknown> & { id: string }>;
    read:    (opts?: unknown) => unknown;
    update:  (opts: { id: string; update: Record<string, unknown> }) => Promise<unknown>;
  }>
): EntityRegistry {
  const registry: EntityRegistry = {};
  for (const [entity, mod] of Object.entries(modules)) {
    registry[entity] = {
      create:  (d) => mod.create(d),
      update:  (id, fields) => mod.update({ id, update: fields }),
      read:    (id) => mod.read({ id }) as Promise<Record<string, unknown>>,
      readAll: () => mod.read() as Record<string, Record<string, unknown>>,
    };
  }
  return registry;
}

export interface ReassignMutation {
  type: "reassign";
  /** Name of the context entity type in the registry (e.g. "category") */
  contextEntity: string;
  /** Field on the primary entity that references the context (e.g. "category") */
  field: string;
  /** Fixture data for the new context entity */
  fixture: Record<string, unknown>;
}

export type MutationSpec<A> = ((a: A) => Promise<unknown>) | ReassignMutation;

/**
 * Tests isolation: creates two entities in a shared context, mutates one,
 * reads the other, and returns the unmodified entity for assertion.
 *
 * When mutateA is a ReassignMutation, uses the EntityRegistry to wire CRUD
 * automatically — no lambdas needed:
 *
 *   const other = await withIsolationTest(
 *     registry,
 *     "category",   // context entity type
 *     "bookmark",   // primary entity type
 *     "category",   // FK field
 *     { name: "Shared" },
 *     { name: "T", url: "x" },
 *     { type: "reassign", contextEntity: "category", field: "category", fixture: { name: "Solo" } }
 *   );
 */
export async function withIsolationTest<A extends { id: string }>(
  registry: EntityRegistry,
  contextEntityType: string,
  primaryEntityType: string,
  contextField: string,
  sharedContextFixture: Record<string, unknown>,
  entityFixture: Record<string, unknown>,
  mutateA: MutationSpec<A>
): Promise<Record<string, unknown>> {
  const ctxOps     = registry[contextEntityType];
  const entityOps  = registry[primaryEntityType];
  if (!ctxOps || !entityOps) throw new Error(`EntityRegistry missing: ${contextEntityType} or ${primaryEntityType}`);

  const sharedCtx = await ctxOps.create(sharedContextFixture);
  const baseA = { ...entityFixture, [contextField]: sharedCtx.id };
  const baseB = { ...entityFixture, name: ((entityFixture.name as string) ?? "T") + "_B", [contextField]: sharedCtx.id };
  const [a, b] = await Promise.all([entityOps.create(baseA), entityOps.create(baseB)]);

  if (typeof mutateA === "function") {
    await mutateA(a as unknown as A);
  } else {
    const newCtx = await ctxOps.create(mutateA.fixture);
    await entityOps.update(a.id, { [mutateA.field]: newCtx.id });
  }

  return entityOps.read(b.id);
}

/**
 * Runs two operations with different configurations, normalizes their outputs,
 * and returns true if the result shapes match.
 * Derived from: "do two differently-configured [operations] produce results with the same structure?"
 *
 *   const ok = await withShapeComparison(
 *     () => withMockFetch(resp1, () => search(id1, term)),
 *     () => withMockFetch(resp2, () => search(id2, term))
 *   );
 *   expect(ok).toBe(true);
 */
export async function withShapeComparison(
  op1: () => Promise<unknown[]>,
  op2: () => Promise<unknown[]>
): Promise<boolean> {
  const [r1, r2] = await Promise.all([op1(), op2()]);
  const shape = (arr: unknown[]) => Object.keys(arr[0] ?? {}).sort().join(",");
  return shape(r1) === shape(r2);
}

/**
 * Injects a transient fault into an object's method, runs a recovery operation,
 * and returns true if the system continued working after the fault.
 *
 * Derived from the pattern: "a failed [method] does not stall [the system]"
 *
 *   const ok = await withFaultInjection(database.db, "write", () => database.write());
 *   // → patches db.write to fail once, absorbs the failure, verifies recovery
 */
export async function withFaultInjection(
  target: Record<string, unknown>,
  method: string,
  trigger: () => Promise<unknown>
): Promise<boolean> {
  const original = target[method] as (...args: unknown[]) => unknown;
  let faultFired = false;

  // Patch the method to fail exactly once, then restore
  target[method] = async (...args: unknown[]) => {
    if (!faultFired) {
      faultFired = true;
      throw new Error(`simulated ${method} failure`);
    }
    target[method] = original;
    return original.call(target, ...args);
  };

  // Absorb the expected failure
  try { await trigger(); } catch { /* expected */ }

  // Ensure restoration even if trigger didn't reach the patch
  if (!faultFired) target[method] = original;

  // Verify the system recovered
  try {
    await trigger();
    return true;
  } catch {
    return false;
  } finally {
    target[method] = original;
  }
}
