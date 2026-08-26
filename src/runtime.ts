/**
 * Scaffolding that generated test files import at runtime -- temp-dir database lifecycle, fetch
 * mocking, fault injection, and the other shapes the derivation engine emits calls to. Nothing
 * here is meant to be reached from an `.lld.md` file; the runner wires it up automatically when
 * a claim's vocabulary matches a pattern that needs it.
 *
 * (An earlier design had authors write "helper files" that imported these by hand. Helper files
 * are gone -- tests are derived from the implementation's own structure -- and `lldtdd helpers`
 * now exits with an error saying so. These utilities outlived that workflow because the
 * generated code still needs them.)
 *
 * Also exported publicly as `lldtdd/runtime` for anyone extending the derivation engine itself:
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
 * Wraps a fetch-dependent call with a stub that returns the given response.
 * Restores global.fetch afterward even if the call throws.
 *
 *   const results = await withMockFetch({ results: [...] }, () => searchProvider(id, term));
 *
 * A plain value is the success body -- the common case, always 200 / application/json. To reach a
 * path a fixed success mock cannot (an error result, a non-JSON body), pass a *descriptor*: an
 * object carrying `body` together with a numeric `status` and/or a string `contentType`. That shape
 * is the trigger; a body that has neither is passed through unchanged, so existing mocks are
 * unaffected.
 *
 *   withMockFetch({ status: 500, body: { message: "boom" } }, () => GET(url))   // error path
 *   withMockFetch({ contentType: "text/plain", body: "hello" }, () => GET(url)) // text branch
 */
export async function withMockFetch<T>(
  responseBody: unknown,
  fn: () => Promise<T>
): Promise<T> {
  const g = global as unknown as Record<string, unknown>;

  const isDescriptor = (v: unknown): v is { body: unknown; status?: number; contentType?: string } =>
    typeof v === "object" && v !== null && "body" in v
    && (typeof (v as { status?: unknown }).status === "number"
      || typeof (v as { contentType?: unknown }).contentType === "string");
  const d = isDescriptor(responseBody)
    ? { status: responseBody.status ?? 200, contentType: responseBody.contentType ?? "application/json", body: responseBody.body }
    : { status: 200, contentType: "application/json", body: responseBody };

  // Restore what was there, rather than deleting. Bun ships a real `fetch`, so assigning
  // `undefined` on the way out left the process without one -- a later claim in the same file
  // calling fetch got "fetch is not a function" instead of the runtime's own.
  const previous = g.fetch;
  g.fetch = () =>
    Promise.resolve({
      ok: d.status < 400,
      status: d.status,
      headers: new Headers({ "content-type": d.contentType }),
      json: () => Promise.resolve(d.body),
      text: () => Promise.resolve(typeof d.body === "string" ? d.body : JSON.stringify(d.body)),
      blob: () => Promise.resolve(d.body),
    });
  try {
    return await fn();
  } finally {
    g.fetch = previous;
  }
}

/** A mounted component and the actions a claim can describe being taken on it. */
export interface Driven {
  /** The mounted element. */
  el: HTMLElement;
  /** The component itself, for claims about its own API rather than about its markup -- a claim
   *  about what `destroy()` leaves behind has to be able to call it. */
  instance: { elem?: HTMLElement | null } & Record<string, unknown>;
  /** Let pending microtasks deliver -- see `withMountedComponent` for why this is not optional. */
  settle(): Promise<void>;
  /** Run every callback scheduled to fire within `ms`. */
  advance(ms: number): void;
  // There is deliberately nothing here that counts queued timers. `jest.getTimerCount()` does not
  // work once happy-dom is registered -- it reports a zero delta even for a plain `setTimeout` in
  // test scope, because the registrator binds its own timers over the fake-timer registry. A pattern
  // that asserted `queued > 0` on it was reading an ambient timer, and stayed green with the
  // behaviour under test disabled. Advancement is unaffected and exact, so ask what the component
  // *did* across an advance; the bookkeeping is not the claim.
  click(target?: Element | null): Promise<void>;
  hover(target?: Element | null): Promise<void>;
  leave(target?: Element | null): Promise<void>;
  press(key: string, target?: Element | null): Promise<void>;
  type(text: string, target?: Element | null): Promise<void>;
  /** Drag by `dy` pixels vertically (and `dx` horizontally), starting from the middle of `target`. */
  drag(delta: { dx?: number; dy?: number }, target?: Element | null): Promise<void>;
  /** The size the mounted element reports, for behaviour that measures itself.
   *
   *  happy-dom computes no layout, so every element reports `offsetHeight === 0`. That is not "this
   *  element is zero pixels tall" -- it is "nobody laid this out" -- and a component that scales a
   *  threshold off its own height reads the difference as *no threshold at all*. A real browser
   *  would give it a size, so the driver does too, and a claim about a threshold can then be about
   *  the threshold rather than about the absence of layout. */
  readonly height: number;
  /** Navigate to a new URL fragment, as a user following a link would. */
  navigate(hash: string): Promise<void>;
}

/** The event sequence a real user action produces.
 *
 *  A claim says "clicking"; the DOM has no such single event. Dispatching only `click` misses every
 *  component that listens on pointerdown/pointerup -- which is most of them, because that is what
 *  distinguishes a press from a drag. Sending the real sequence is what makes a derived interaction
 *  test agree with what a user would see. */
const SEQUENCES: Record<string, readonly (readonly [string, string])[]> = {
  click: [["PointerEvent", "pointerdown"], ["PointerEvent", "pointerup"], ["MouseEvent", "click"]],
  hover: [["PointerEvent", "pointerover"], ["MouseEvent", "mouseover"],
          ["PointerEvent", "pointerenter"], ["MouseEvent", "mouseenter"]],
  leave: [["PointerEvent", "pointerout"], ["MouseEvent", "mouseout"],
          ["PointerEvent", "pointerleave"], ["MouseEvent", "mouseleave"]],
};

function fire(target: Element, kind: string, type: string, extra: Record<string, unknown> = {}): void {
  const Ctor = (globalThis as Record<string, unknown>)[kind] as (typeof Event) | undefined;
  const init = { bubbles: true, cancelable: true, ...extra } as EventInit;
  target.dispatchEvent(Ctor ? new (Ctor as new (t: string, i: EventInit) => Event)(type, init) : new Event(type, init));
}

/** A drag, as both pointer and mouse events, dispatched on the element the gesture starts on.
 *
 *  Dispatching on the target rather than on `window` is what makes this reach everyone: a component
 *  commonly takes the *start* of the gesture on its own handle and then listens for the move and the
 *  release on `window` or `document`, because the pointer leaves the handle almost immediately. A
 *  bubbling event dispatched on the handle arrives at all three, so one call exercises whichever
 *  arrangement the component chose.
 *
 *  Both families are sent for the same reason `click` sends its whole sequence -- a component listens
 *  for one or the other, and which one is not something a claim should have to say. */
function dragSequence(target: Element, from: Point, to: Point, steps: number): void {
  const at = (i: number): Point => ({
    clientX: from.clientX + ((to.clientX - from.clientX) * i) / steps,
    clientY: from.clientY + ((to.clientY - from.clientY) * i) / steps,
  });
  const both = (type: [string, string], p: Point) => {
    fire(target, "PointerEvent", type[0], { ...p, pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
    fire(target, "MouseEvent", type[1], { ...p, button: 0, buttons: 1 });
  };

  both(["pointerdown", "mousedown"], from);
  for (let i = 1; i <= steps; i++) both(["pointermove", "mousemove"], at(i));
  both(["pointerup", "mouseup"], to);
}

interface Point { clientX: number; clientY: number }

/** The size a mounted element reports when the environment computed none. Chosen to look like a
 *  panel in a phone-sized viewport: big enough that a threshold scaled off it is a real distance,
 *  small enough that a full-height drag is still a gesture a person could make. */
const DRIVEN_HEIGHT = 400;
const DRIVEN_WIDTH = 360;

/**
 * Mounts a component, drives it, and cleans up -- with the clock under the test's control.
 *
 *   const r = await withMountedComponent(() => new Popover({ autoOpen: true }), async d => {
 *     d.advance(200);
 *     await d.settle();
 *     return calls;
 *   });
 *
 * Mounting is part of asking the question, not part of the answer. A component that defers work
 * until it is connected schedules nothing while it sits in a variable, so an unmounted probe reports
 * that the deferred work never happens -- a claim failing against an implementation that is correct.
 *
 * `settle()` is called for you after mounting, and it is load-bearing. Connection is commonly
 * detected with a `MutationObserver`, whose callbacks are delivered as microtasks rather than
 * synchronously; reading state straight after `appendChild` therefore sees a component that has not
 * yet noticed it is in the document. That one missing tick is what made an earlier attempt at this
 * conclude, wrongly, that connection lifecycles could not be triggered at all.
 */
export async function withMountedComponent<T>(
  create: () => { elem?: HTMLElement | null },
  fn: (driven: Driven) => Promise<T> | T
): Promise<T> {
  const { jest } = await import("bun:test");

  // The clock goes under test control *before* the component exists. A component that mounts itself
  // during construction -- `appendTo` defaulting to `document.body` -- also arms its deferred work
  // during construction, so building it first leaves that timer on the real clock where `advance()`
  // can never reach it. The deferred call then simply never fires, and the claim fails against an
  // implementation that is correct. Taking a factory is what puts construction inside the window.
  jest.useFakeTimers();
  const instance = create();
  const el = instance?.elem;
  if (!el) throw new Error("withMountedComponent: the instance exposes no `elem` to mount");

  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const sequence = async (name: keyof typeof SEQUENCES, target?: Element | null) => {
    const t = target ?? el;
    for (const [kind, type] of SEQUENCES[name]) fire(t, kind, type);
    await settle();
  };

  // Only mount what is not already mounted. A component whose `appendTo` defaults to `document.body`
  // puts itself in the document during construction, and `appendChild` on an attached element is a
  // *move*: the DOM detaches it and re-attaches it. That round trip runs the component's disconnect
  // cleanup, which is exactly where deferred work gets cancelled -- so unconditionally appending
  // cancelled the timer the caller mounted the component in order to observe, and the deferred call
  // never fired. Checking first is the whole fix, and it makes self-mounting and caller-mounted
  // components behave alike.
  if (!el.isConnected) document.body.appendChild(el);

  // Give the mounted element a size. happy-dom computes no layout, so `offsetHeight` is 0 for
  // everything, and a component that derives a drag threshold from its own height -- BottomSheet uses
  // `Math.min(100, el.offsetHeight * 0.25)` -- ends up with a threshold of zero. Every drag then
  // exceeds it, so "a short drag leaves the sheet visible" fails against correct code while
  // "dragging past the threshold dismisses it" passes without the threshold being involved at all.
  // Both readings are wrong, and both come from reporting 0 where a browser reports a number.
  //
  // The value is arbitrary in the way a viewport is arbitrary; what matters is that it is a
  // plausible size rather than an impossible one, and that a claim comparing distances against it
  // has something real to compare against. It is only defined when the environment left it at 0.
  if (el.offsetHeight === 0) {
    Object.defineProperty(el, "offsetHeight", { value: DRIVEN_HEIGHT, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: DRIVEN_WIDTH, configurable: true });
  }
  await settle();

  try {
    return await fn({
      el,
      instance: instance as Driven["instance"],
      settle,
      advance: ms => { jest.advanceTimersByTime(ms); },
      height: el.offsetHeight || DRIVEN_HEIGHT,
      drag: async ({ dx = 0, dy = 0 }, t) => {
        const target = t ?? el;
        // From the middle of the target, so a downward drag has room to travel and a component
        // reading `clientY` sees a coordinate consistent with where the gesture started.
        const from = { clientX: DRIVEN_WIDTH / 2, clientY: DRIVEN_HEIGHT / 2 };
        dragSequence(target, from, { clientX: from.clientX + dx, clientY: from.clientY + dy }, 8);
        await settle();
      },
      navigate: async hash => {
        const next = hash.startsWith("#") ? hash : `#${hash}`;
        const oldURL = String(location.href);
        location.hash = next;
        // happy-dom updates `location` without telling anyone, so the event a component listens for
        // has to be sent explicitly. Assigning the hash first means a handler that reads
        // `location.hash` sees the destination rather than where it came from.
        const Ctor = (globalThis as Record<string, unknown>).HashChangeEvent as
          (new (t: string, i: Record<string, unknown>) => Event) | undefined;
        const init = { bubbles: true, cancelable: false, oldURL, newURL: String(location.href) };
        window.dispatchEvent(Ctor ? new Ctor("hashchange", init) : new Event("hashchange", init));
        await settle();
      },
      click: t => sequence("click", t),
      hover: t => sequence("hover", t),
      leave: t => sequence("leave", t),
      press: async (key, t) => {
        const target = t ?? el;
        for (const type of ["keydown", "keyup"]) {
          const Ctor = (globalThis as Record<string, unknown>).KeyboardEvent as typeof KeyboardEvent | undefined;
          target.dispatchEvent(Ctor ? new Ctor(type, { key, code: key, bubbles: true }) : new Event(type, { bubbles: true }));
        }
        await settle();
      },
      type: async (text, t) => {
        const target = (t ?? el) as HTMLInputElement;
        target.focus?.();
        target.value = text;
        fire(target, "InputEvent", "input");
        fire(target, "Event", "change");
        await settle();
      },
    });
  } finally {
    el.remove();
    jest.useRealTimers();
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
 * Creates multiple entities from a fixture list, then reads all back.
 * Used to verify: "do N created entities appear in the flat collection?"
 *
 *   const items = await withSeedAndRead(create, readAll, [{ name: "Work" }, { name: "Personal" }]);
 *   expect(items.length).toBeGreaterThanOrEqual(2);
 *
 * Assert on the *count*, not on `Array.isArray`. The return is coerced to an array below, so an
 * `Array.isArray` check is a fact about this function rather than about the caller's module: it held
 * for a `create` that did nothing against a store that stayed empty.
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

/** What an isolation check learned.
 *
 *  All three fields are needed to state the claim: the entity that was *not* touched, the field the
 *  claim is about, and the context id it should still be pointing at. Returning only the untouched
 *  record would reduce the generated assertion to `expect(result).toBeDefined()`, which passes for
 *  a registry whose update clobbers every record in the store, the exact behavior the claim says
 *  must not happen. A helper has to hand back enough for the assertion to be about the claim. */
export interface IsolationResult {
  /** The entity the mutation was not applied to. */
  untouched: Record<string, unknown>;
  /** The FK field under test, echoed back so the assertion needn't repeat it. */
  contextField: string;
  /** The shared context's id -- what `untouched[contextField]` must still equal. */
  sharedContextId: string;
}

/**
 * Tests isolation: creates two entities in a shared context, mutates one,
 * reads the other, and returns the unmodified entity for assertion.
 *
 * When mutateA is a ReassignMutation, uses the EntityRegistry to wire CRUD
 * automatically -- no lambdas needed:
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
): Promise<IsolationResult> {
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

  return {
    untouched: await entityOps.read(b.id),
    contextField,
    sharedContextId: sharedCtx.id,
  };
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

  // The trigger never reached the faulted method, so no fault was ever injected and there is
  // nothing to have recovered from. Reporting `true` here would let a claim that "a failed
  // write does not stall the queue" pass against a run in which no write ever failed.
  // Returning false is the honest answer: recovery was not observed. In practice this
  // means the resolved fault target is wrong, which is worth failing loudly over.
  if (!faultFired) {
    target[method] = original;
    return false;
  }

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

/**
 * Subscribes a spy to `subject`, handling both subscribe shapes without the caller having to
 * know which one it is looking at.
 *
 *   subscribe(handler)         -> EventTarget-style, one channel
 *   subscribe(topic, handler)  -> topic-keyed bus, many channels
 *
 * The shape is read off `subscribe.length` -- the implementation's own declared arity, which is
 * a fact about the module in the same way its AST is, not a guess about it. A topic-keyed bus
 * gets `topicKey` in the topic position so the spy lands on the channel the claim's own call
 * publishes to; a topic-less one ignores `topicKey` entirely.
 *
 * This is what makes "handler called" claims usable against topic-keyed APIs: a spy passed as
 * the `topic` argument leaves the handler position undefined, so the spy legitimately never
 * fires and the claim fails on a premise the author never wrote.
 *
 * Returns the spy and its unsubscribe, so "not called" claims can unsubscribe before publishing.
 */
export function subscribeSpy(
  subject: Record<string, (...args: unknown[]) => unknown>,
  spy: (...args: unknown[]) => unknown,
  topicKey?: unknown,
): { unsubscribe: () => void } {
  const subscribe = subject.subscribe;
  if (typeof subscribe !== "function") {
    throw new Error("subscribeSpy: the setup subject has no subscribe() to attach a spy to");
  }
  const unsub = subscribe.length >= 2
    ? subscribe.call(subject, topicKey, spy)
    : subscribe.call(subject, spy);
  return { unsubscribe: typeof unsub === "function" ? unsub as () => void : () => {} };
}
