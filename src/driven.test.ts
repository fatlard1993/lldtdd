import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

import { describe, it, expect } from "bun:test";
import { withMountedComponent } from "./runtime.ts";

/**
 * The gesture and navigation primitives, tested directly.
 *
 * No shipped pattern reaches these yet -- every claim in the corpus that needs them also needs the
 * component put into a starting state first (a BottomSheet must be shown before a drag can dismiss
 * it), and nothing in those claims says how to reach it. They are covered here rather than through a
 * derived test so that "it works" is a checked fact rather than a note in a commit message.
 */

/** A component whose only job is to record what reached it. */
function recorder() {
  const seen: string[] = [];
  const el = document.createElement("div");
  const child = document.createElement("button");
  el.appendChild(child);
  // Move and release are taken on `document` on purpose: that is where a real component listens for
  // them, because the pointer leaves the handle as soon as the drag starts.
  const log = (e: Event) => seen.push(`${e.type}@${Math.round((e as MouseEvent).clientY ?? 0)}`);
  for (const t of ["mousedown", "pointerdown"]) child.addEventListener(t, log);
  for (const t of ["mousemove", "mouseup"]) document.addEventListener(t, log);
  return { instance: { elem: el }, child, seen };
}

describe("drag", () => {
  it("starts on the target and reaches listeners on document", async () => {
    const r = recorder();
    await withMountedComponent(() => r.instance, async d => {
      await d.drag({ dy: 120 }, r.child);
    });
    expect(r.seen.filter(s => s.startsWith("mousedown"))).toHaveLength(1);
    expect(r.seen.filter(s => s.startsWith("mousemove")).length).toBeGreaterThan(1);
    expect(r.seen.filter(s => s.startsWith("mouseup"))).toHaveLength(1);
  });

  it("carries coordinates that travel the requested distance", async () => {
    const r = recorder();
    await withMountedComponent(() => r.instance, async d => { await d.drag({ dy: 120 }, r.child); });
    const y = (tag: string) => Number(r.seen.find(s => s.startsWith(tag))!.split("@")[1]);
    // A component measuring the gesture reads `clientY` deltas, so the release has to land exactly
    // `dy` from the press or every threshold comparison is off by however much the driver drifted.
    expect(y("mouseup") - y("mousedown")).toBe(120);
  });

  it("gives the element a size, so a self-measuring threshold is a real distance", async () => {
    // happy-dom computes no layout and reports 0 for everything. A component scaling a threshold off
    // its own height then gets a threshold of zero, which makes every drag exceed it -- the claim
    // "a short drag leaves it visible" fails against correct code.
    const r = recorder();
    await withMountedComponent(() => r.instance, async d => {
      expect(d.el.offsetHeight).toBeGreaterThan(0);
      expect(d.height).toBe(d.el.offsetHeight);
    });
  });
});

describe("navigate", () => {
  it("changes the hash and announces it", async () => {
    const el = document.createElement("div");
    const events: Array<{ oldURL: string; newURL: string }> = [];
    const onHash = (e: Event) => events.push({
      oldURL: (e as HashChangeEvent).oldURL, newURL: (e as HashChangeEvent).newURL,
    });
    window.addEventListener("hashchange", onHash);
    try {
      await withMountedComponent(() => ({ elem: el }), async d => {
        await d.navigate("/somewhere");
      });
    } finally { window.removeEventListener("hashchange", onHash); }

    expect(events).toHaveLength(1);
    expect(location.hash).toBe("#/somewhere");
    // The hash is assigned before the event is sent, so a handler reading `location.hash` sees the
    // destination rather than where it came from.
    expect(events[0].newURL).toContain("#/somewhere");
    expect(events[0].oldURL).not.toBe(events[0].newURL);
  });

  it("accepts a fragment with or without its leading #", async () => {
    const el = document.createElement("div");
    await withMountedComponent(() => ({ elem: el }), async d => {
      await d.navigate("#/with-hash");
      expect(location.hash).toBe("#/with-hash");
      await d.navigate("/without-hash");
      expect(location.hash).toBe("#/without-hash");
    });
  });
});
