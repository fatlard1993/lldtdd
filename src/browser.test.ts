import { describe, it, expect } from "bun:test";
import { findBrowser, inBrowser } from "./browser.ts";
import { parse } from "./parser.ts";
import { trackTempDir } from "./tempFiles.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The browser path, and the two things about it that are easy to get wrong.
 *
 * Both bugs it has had were invisible when it was exercised on its own: a devtools request blocked as
 * cross-origin, and a websocket raising an unhandled error -- both because a generated DOM suite
 * registers happy-dom first and happy-dom replaces `fetch` and `WebSocket`. That is why the work is in
 * a spawned process, and why the test below runs a claim rather than a mock.
 */
/** A module with a default export, which is what `inBrowser` binds to `Subject`. Written fresh rather
 *  than pointed at a fixture: the fixtures beside the runner's own documents export named functions,
 *  and using one produced a bundle failure that read like a browser problem. */
// Detected once, at load. Without a browser the two claims below would be pending in a real run,
// not failed -- but a test that early-returns on the same condition passes with zero assertions,
// which reads as verified. skipIf makes the absence visible in the report instead.
const hasChrome = !!(await findBrowser());

async function browserFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-browser-fixture-"));
  trackTempDir(dir);
  const path = join(dir, "widget.js");
  await Bun.write(path, "export default class Widget { constructor() { this.elem = document.createElement('div'); } }");
  return path;
}

describe("browser-backed claims", () => {
  it("marks a group from **browser:** true", () => {
    const doc = parse([
      "# S", "> m.js", "", "## Layout", "", "**browser:** true", "",
      "- a claim", "", "## Other", "", "- another claim",
    ].join("\n"), "s.lld.md");
    expect(doc.groups[0].browser).toBe(true);
    // Not inherited: a browser costs seconds, so it applies only where it was asked for.
    expect(doc.groups[1].browser).toBeUndefined();
  });

  it.skipIf(!hasChrome)("measures layout that happy-dom cannot", async () => {
    const mod = await browserFixture();
    const height = await inBrowser(mod, `
      const d = document.createElement("div");
      d.style.height = "137px";
      document.body.append(d);
      return d.offsetHeight;
    `);
    // The number is the point: under happy-dom every offsetHeight is 0, so a claim comparing
    // rendered sizes cannot be answered there at all.
    expect(height).toBe(137);
  }, 60_000);

  it.skipIf(!hasChrome)("reports a page exception rather than a silent false answer", async () => {
    const mod = await browserFixture();
    await expect(inBrowser(mod, `throw new Error("deliberate");`)).rejects.toThrow(/deliberate/);
  }, 60_000);
});
