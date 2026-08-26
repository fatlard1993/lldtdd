// The browser side of a browser-backed claim, in its own process.
//
// This file is spawned, never imported by a generated test, and that is the whole design. A generated
// DOM suite registers happy-dom before anything else, which replaces the global `fetch` *and* the
// global `WebSocket` -- so a devtools request came back "Cross-Origin Request Blocked" and the socket
// raised an unhandled ErrorEvent. The browser path worked when run standalone and only then, which is
// the worst way for it to be broken: every check of it in isolation passed.
//
// Running here means the transport talks to a real Bun runtime with unpatched globals, and the test
// process gets a JSON answer over a pipe. It also keeps the browser's lifetime off the test process
// entirely, so an interrupted suite cannot strand it.
//
// Protocol: one JSON object on stdin -- { modulePath, body } -- and one on stdout:
// { ok: true, value } or { ok: false, error }.

import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "./browser.ts";
import { trackTempDir, trackTempProcess } from "./tempFiles.ts";

/** A plain HTTP GET against the devtools endpoint. Kept on `node:http` rather than `fetch` so this
 *  worker behaves identically no matter what a caller has done to the globals. */
function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

let shared: Promise<Session | null> | null = null;

/** Shuts the browser down and waits long enough for it to let go of its profile directory. */
export async function closeSharedSession(): Promise<void> {
  // A failed launch leaves `shared` rejected; there is nothing to close and the error has
  // already been reported by the caller that hit it.
  const s = shared ? await shared.catch(() => null) : null;
  if (!s) return;
  s.close();
  await new Promise(r => setTimeout(r, 150));
}

/** One browser per process, reused across claims.
 *
 *  Launching Chrome costs a few hundred milliseconds, which is more than every other claim in a
 *  document put together -- so a suite with five browser claims must not pay it five times. The
 *  process is killed on exit through the same registry that reaps scratch files, because a stranded
 *  headless Chrome holding a profile directory is exactly the kind of litter this tool must not
 *  leave behind. */
async function session(): Promise<Session | null> {
  shared ??= (async () => {
    const bin = await findBrowser();
    if (!bin) return null;

    const profile = await mkdtemp(join(tmpdir(), "lldtdd-browser-"));
    trackTempDir(profile);
    const proc = Bun.spawn([
      bin, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
      // A stated viewport is part of the question: "flips when it would overflow" has no meaning
      // without an edge to overflow. This is the one layout input a claim cannot supply itself.
      "--window-size=1024,768", "about:blank",
    ], { stdout: "ignore", stderr: "pipe" });
    // Drained from the start so a chatty Chrome cannot fill the pipe and stall; the text is only
    // read on a failed launch, where it is the diagnostic.
    const stderrText = new Response(proc.stderr).text();

    // Port 0 makes Chrome pick the port, and the DevToolsActivePort file in the profile directory
    // is where Chrome itself reports the choice. Attaching by that file, not by a guessed port, is
    // the point: any local process can squat a guessed port and answer /json/version, and a real
    // Chrome already listening there would mean silently driving the user's own session.
    const port = await (async () => {
      const portFile = join(profile, "DevToolsActivePort");
      for (let i = 0; i < 200; i++) {
        try {
          const p = parseInt((await readFile(portFile, "utf8")).split("\n")[0], 10);
          if (Number.isFinite(p) && p > 0) return p;
        } catch { /* not written yet */ }
        await new Promise(r => setTimeout(r, 25));
      }
      return null;
    })();
    if (port === null) {
      proc.kill(9);
      await proc.exited;
      const err = (await stderrText).trim();
      throw new Error(
        `browser launched but never wrote DevToolsActivePort in ${profile}${err ? ` -- ${err}` : ""}`,
      );
    }

    const endpoint = await (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const j = JSON.parse(await httpGet(port, "/json/version")) as { webSocketDebuggerUrl?: string };
          if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 25));
      }
      return null;
    })();
    if (!endpoint) {
      proc.kill(9);
      throw new Error(`browser reported devtools port ${port} but /json/version never answered there`);
    }

    const ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("devtools socket refused"));
    });

    let nextId = 0;
    let sessionId: string | undefined;
    const rpc = (method: string, params: Record<string, unknown> = {}, useSession = true) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++nextId;
        const onMessage = (e: MessageEvent) => {
          const msg = JSON.parse(String(e.data)) as Record<string, any>;
          if (msg.id !== id) return;
          ws.removeEventListener("message", onMessage);
          if (msg.error) reject(new Error(String(msg.error.message ?? "devtools error")));
          else resolve(msg.result ?? {});
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({
          id, method, params, ...(useSession && sessionId ? { sessionId } : {}),
        }));
      });

    const target = await rpc("Target.createTarget", { url: "about:blank" }, false);
    const attached = await rpc(
      "Target.attachToTarget", { targetId: target.targetId, flatten: true }, false,
    );
    sessionId = String(attached.sessionId);

    // Registered with the same reaper that handles scratch files, so a signal kills the browser and
    // removes its profile. `process.on("exit")` alone does not run on Ctrl-C, and an interrupted run
    // left a headless Chrome holding a multi-megabyte profile directory in the OS temp dir.
    // SIGKILL, not the default SIGTERM. Headless Chrome does not exit promptly on a term signal, and
    // this worker exits immediately after asking -- so the browser was orphaned and kept running, one
    // per invocation, each holding a profile directory. A browser we are finished with has nothing to
    // flush, so there is nothing to be polite about.
    const close = () => { try { ws.close(); } catch {} proc.kill(9); };
    trackTempProcess(close);
    return { send: rpc, close };
  })();
  return shared;
}

/**
 * The in-page half of the browser path: bundles the module, loads it in the shared page, and runs
 * `body` there with the module under test bound to `Subject`. This is what runs inside the worker
 * process; `inBrowser` in browser.ts is the caller-facing entry that spawns the worker and owns the
 * worked example. Kept a distinct name from that entry so the two stop reading as the same function.
 *
 * Returns `undefined` when no browser is available, which the generated test reads as "not asked"
 * rather than as "answered no".
 *
 * The module is bundled for the browser first. That is not optional: the source imports by bare
 * specifier and uses syntax no browser parses directly, and a claim about layout has to run against
 * the same code everything else runs against -- not a hand-written stand-in for it.
 */
export async function runInPage(modulePath: string, body: string): Promise<unknown> {
  const s = await session();
  if (!s) return undefined;

  // The directory, not just the file inside it. Tracking only the file left an empty
  // `lldtdd-bundle-*` behind on every run -- tidier than a stranded browser, and still litter.
  const bundleDir = await mkdtemp(join(tmpdir(), "lldtdd-bundle-"));
  trackTempDir(bundleDir);
  const entry = join(bundleDir, "entry.js");
  await Bun.write(entry, [
    `import Subject from ${JSON.stringify(modulePath)};`,
    `globalThis.__lld_run = async () => {`,
    body,
    `};`,
  ].join("\n"));

  // `throw: false` is load-bearing. Bun.build throws on failure by default, and the thrown
  // AggregateError stringifies to "Bundle failed" -- nothing about which import, which file, or why,
  // which points at the browser when the real fault is usually a bad module path. Asking for the
  // result object instead of the exception is what puts the per-import diagnostics back in reach.
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", throw: false });
  if (!built.success) {
    const why = built.logs.map(l => l.message ?? String(l)).join("; ") || "no diagnostics";
    throw new Error(`runInPage: could not bundle ${modulePath} for the browser -- ${why}`);
  }
  const code = await built.outputs[0].text();

  type EvalResult = {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  const failure = (r: EvalResult) =>
    r.exceptionDetails && (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

  // The bundle is served over HTTP and loaded as a real module script, which is more machinery than
  // it looks like it should need. Two simpler routes fail:
  //
  //   - `Runtime.evaluate` of the bundle text runs a *classic script*, and real component code
  //     reaches `import.meta` (through a dependency if not directly), which is a syntax error there.
  //     Bundling as an IIFE does not help; the expression survives bundling.
  //   - importing a `blob:` URL is legal syntax but never settles on `about:blank`, whose origin is
  //     opaque. That failure is a hang rather than an error, which is the worst shape available.
  //
  // A local origin makes the module load ordinary. Every wait below is bounded for the same reason:
  // a test tool that hangs is worse than one that reports a failure.
  const server = Bun.serve({
    port: 0,
    // Loopback only. The default binds every interface, which would serve the module under
    // test's transpiled source to the local network for the lifetime of the claim.
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/module.js") {
        return new Response(code, { headers: { "content-type": "text/javascript" } });
      }
      return new Response(`<!doctype html><meta charset="utf-8"><script type="module" src="/module.js"></script>`,
        { headers: { "content-type": "text/html" } });
    },
  });

  try {
    await s.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });

    // Poll for the module having run, rather than wiring up load events: the bundle's whole job is to
    // define this function, so its presence is the signal that matters.
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      const probe = await s.send("Runtime.evaluate", {
        expression: `typeof globalThis.__lld_run`, returnByValue: true,
      }) as EvalResult;
      ready = probe.result?.value === "function";
      if (!ready) await new Promise(r => setTimeout(r, 25));
    }
    if (!ready) throw new Error(`runInPage: the page module never defined __lld_run within 5s -- it likely threw at import`);

    const result = await s.send("Runtime.evaluate", {
      expression: `__lld_run()`, returnByValue: true, awaitPromise: true,
    }) as EvalResult;
    const runError = failure(result);
    if (runError) throw new Error(`runInPage: the page threw -- ${runError}`);

    return result.result?.value;
  } finally {
    server.stop(true);
  }
}


// ── entry ─────────────────────────────────────────────────────────────

const input = await new Response(Bun.stdin.stream()).text();
try {
  const { modulePath, body } = JSON.parse(input) as { modulePath: string; body: string };
  const value = await runInPage(modulePath, body);
  console.log(JSON.stringify({ ok: true, value }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
} finally {
  // Closed here rather than left to the exit handler. This worker runs one claim and stops, so the
  // browser can go down before the profile directory is removed -- and that ordering matters: the
  // signal-path handler kills and deletes in the same tick, which raced Chrome releasing its files
  // and left one profile directory behind per run. Waiting a moment makes the normal path clean; the
  // exit handler stays as the backstop for an interrupted one.
  await closeSharedSession();
}
process.exit(0);
