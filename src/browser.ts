// Running a claim in a real browser, for the claims that need one.
//
// A handful of design decisions are about *layout*: a textarea growing to fit its content, a popover
// flipping when it would overflow, two events rendering side by side. happy-dom computes no layout,
// so it reports 0 for every measurement -- which is not "this element is zero pixels tall" but
// "nobody laid this out". Those claims cannot be answered there at any effort, and reporting them as
// unmet gaps was misleading: the tool was not failing to check them, it was structurally unable to.
//
// Chrome is driven over the DevTools Protocol directly rather than through Playwright or Puppeteer.
// The reason is that this project has no build step and one runtime dependency-free story, and CDP
// over a WebSocket is about a hundred lines -- where the automation libraries bring a browser
// download, a version matrix, and a postinstall step. The trade is real: no selector engine, no
// auto-waiting, no cross-browser story. None of that is needed to measure a rendered box.
//
// If no browser is found, claims that asked for one stay **pending** (NO FALSE PASS, see
// src/ast/index.ts), which is why this file never throws for a missing browser.

import { existsSync } from "node:fs";

/** Executables to try, in order. A system Chrome is preferred over a downloaded one because it is
 *  the browser the developer already trusts, and because nothing here needs a pinned version. */
const CANDIDATES = [
  "google-chrome", "chromium", "chromium-browser", "google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

let cachedPath: string | null | undefined;

/** The browser this machine can offer, or null. Resolved once: the answer cannot change mid-run, and
 *  a claim-by-claim `which` would be the slowest part of a suite that finds nothing. */
export async function findBrowser(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith("/")) {
      if (existsSync(candidate)) return (cachedPath = candidate);
      continue;
    }
    // try/catch because Bun.spawnSync throws when `which` itself is absent from PATH, and this
    // file's contract is that a machine without a browser yields null, never a throw.
    try {
      const which = Bun.spawnSync(["which", candidate], { stdout: "pipe", stderr: "pipe" });
      if (which.exitCode === 0) return (cachedPath = candidate);
    } catch { /* no `which` on this machine: treat as not found */ }
  }
  return (cachedPath = null);
}

/**
 * Runs `body` in a real page with the module under test bound to `Subject`, and returns what it
 * returned.
 *
 *   const grew = await inBrowser("/abs/path/Input.js", `
 *     const i = new Subject({ tag: "textarea", appendTo: document.body });
 *     const before = i.elem.offsetHeight;
 *     i.elem.value = "a\\nb\\nc";
 *     i.elem.dispatchEvent(new Event("input", { bubbles: true }));
 *     await new Promise(r => setTimeout(r, 60));
 *     return i.elem.offsetHeight > before;
 *   `);
 *
 * The work happens in a spawned process rather than here. A generated DOM suite registers happy-dom
 * before importing anything, and happy-dom replaces both `fetch` and `WebSocket` -- the first blocks a
 * devtools request as cross-origin, the second raises an unhandled error event. Neither shows up when
 * this is exercised on its own, so the separation is not tidiness: it is the difference between the
 * browser path working everywhere and working only outside the tests that need it.
 *
 * Returns `undefined` when no browser is available, which a generated test reads as "never asked"
 * rather than as "answered no".
 */
export async function inBrowser(modulePath: string, body: string): Promise<unknown> {
  if (!(await findBrowser())) return undefined;

  const worker = new URL("./browserWorker.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", worker], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify({ modulePath, body }));
  proc.stdin.end();

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const line = out.trim().split("\n").filter(Boolean).pop();
  if (!line) {
    throw new Error(`inBrowser: the browser worker produced no result${err.trim() ? ` -- ${err.trim()}` : ""}`);
  }
  const parsed = JSON.parse(line) as { ok: boolean; value?: unknown; error?: string };
  if (!parsed.ok) throw new Error(parsed.error ?? "inBrowser: the browser worker failed");
  return parsed.value;
}
