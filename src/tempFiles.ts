// Files lldtdd writes into someone else's working tree, and getting rid of them.
//
// A `finally` covers a thrown runner but not a signal, so a Ctrl-C mid-run can strand a mutated
// copy of the user's source in their source tree. Naming the file recognisably and gitignoring it
// makes a leak survivable rather than impossible, and .gitignore does not reach the npm tarball,
// where `files: ["src"]` is an allowlist: an orphan can ship in a real `bun pm pack`.
//
// There are two writers: the mutation pass, and DOM-component suites, whose generated test lives
// inside the project tree so it can reach node_modules. The cleanup mechanism lives here, once,
// and both writers register with it, so a fix to one path cannot leave the other uncovered.
//
// For a tool whose pitch is that it never touches production code, leaving files behind is the wrong
// failure mode.

import { unlinkSync, rmSync } from "node:fs";

const live = new Set<string>();
const liveDirs = new Set<string>();
const liveKills = new Set<() => void>();
let installed = false;

/** Synchronous on purpose: a signal handler may not get another turn of the event loop. */
function removeAll(): void {
  for (const kill of liveKills) {
    try { kill(); } catch { /* already gone */ }
  }
  liveKills.clear();
  for (const path of live) {
    try { unlinkSync(path); } catch { /* already gone, or never written */ }
  }
  live.clear();
  for (const dir of liveDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  liveDirs.clear();
}

/** Installs process-level cleanup once per process.
 *
 *  Each signal handler removes itself and re-raises rather than calling `process.exit`, so a library
 *  consumer that embeds the pipeline keeps its own signal semantics -- including its exit code -- and
 *  we only borrow the signal long enough to unlink. Calling `process.exit` here would preempt the
 *  host; attaching a listener and *not* re-raising would suppress the default behavior and hang on
 *  Ctrl-C. */
function installCleanupOnce(): void {
  if (installed) return;
  installed = true;

  process.on("exit", removeAll);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      removeAll();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

/** Track a path so an interrupted run still unlinks it. Call before writing, not after: a signal
 *  arriving mid-write would otherwise leave a file nothing knows about. */
export function trackTempFile(path: string): void {
  installCleanupOnce();
  live.add(path);
}

/** Stop tracking a path the normal cleanup already removed. */
export function untrackTempFile(path: string): void {
  live.delete(path);
}

/** Track a whole directory, removed recursively. A browser profile is the case that needed this:
 *  megabytes of it, in the OS temp dir, one per interrupted run. */
export function trackTempDir(dir: string): void {
  installCleanupOnce();
  liveDirs.add(dir);
}

/** Track a child process to kill before exiting.
 *
 *  A headless browser is not a file, but it is the same defect: `process.on("exit")` does not run on
 *  a signal, so Ctrl-C during a browser-backed run left Chrome holding a profile directory with
 *  nothing left to reap either. Registering the kill here means one handler covers processes, files
 *  and directories, in that order -- the process has to go first or it will keep writing to the
 *  directory being removed. */
export function trackTempProcess(kill: () => void): () => void {
  installCleanupOnce();
  liveKills.add(kill);
  return () => liveKills.delete(kill);
}
