import { describe, it, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, cp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The CLI is a program, and these test it as one: every case spawns `bun src/cli.ts ...` and
 * asserts on what the calling shell would see, because the exit-code contract the README promises
 * is a property of the process, not of any function an in-process test could call. `lld/cli.lld.md`
 * states the same contract as claims and checks it through the tool itself; these cover it from
 * the other side, plus the parts a document cannot easily reach -- stderr wording, and behavior
 * against documents that live outside the project root.
 *
 * Everything runs in a temp directory seeded from lld/fixtures/, so no fixture on disk can drift
 * out from under it, and so the spawned process's cwd (which is also its project root) is isolated
 * from this repo's corpus.
 */

const CLI = new URL("./cli.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;

function cli(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { cwd });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** A temp project seeded with this repo's own fixture documents, at the same relative paths, so
 *  their repo-root-relative module pointers resolve against the temp cwd unchanged. */
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "lldtdd-cli-"));
  await mkdir(join(dir, "lld", "fixtures"), { recursive: true });
  for (const f of ["subject.ts", "passing.lld.md", "failing.lld.md", "pending.lld.md"]) {
    await cp(join(REPO_ROOT, "lld", "fixtures", f), join(dir, "lld", "fixtures", f));
  }
  return dir;
}

/** A `docs/` subtree beside the fixtures, because the default sweep excludes fixtures/ -- the
 *  bare-directory tests need a directory whose documents the sweep will actually visit. */
async function workspaceWithDocs() {
  const dir = await workspace();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "subject.ts"),
    "export function double(n: number): number {\n  return n * 2;\n}\n");
  await writeFile(join(dir, "docs", "clean.lld.md"),
    "# S\n> ./subject.ts\n\n## Doubling\n**method:** `double`\n\n- double(2) → 4\n");
  return dir;
}

describe("help", () => {
  it("exits zero and lists the commands", async () => {
    const dir = await workspace();
    const r = cli(dir, "help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Commands:");
    for (const command of ["run", "lint", "suggest", "drift", "mutate"]) {
      expect(r.stdout).toContain(command);
    }
  });
});

describe("unknown input", () => {
  it("exits non-zero on an unrecognized command, with the documented message", async () => {
    // A mistyped command that printed help and exited 0 would pass a CI step that meant to run
    // something. Asking for help is a success; failing to name a command is not.
    const dir = await workspace();
    const r = cli(dir, "frobnicate");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command: frobnicate");
  });

  it("exits non-zero on an unrecognized flag instead of silently ignoring it", async () => {
    const dir = await workspace();
    const r = cli(dir, "run", "--no-mutat");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown flag");
  });
});

describe("lint", () => {
  it("exits zero for a clean document named directly", async () => {
    const dir = await workspace();
    const r = cli(dir, "lint", "lld/fixtures/passing.lld.md");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 file clean");
  }, 30_000);

  it("exits non-zero for a document with a lint error", async () => {
    const dir = await workspaceWithDocs();
    await writeFile(join(dir, "docs", "broken.lld.md"),
      "## No title or module pointer\n\n- a claim about nothing\n");
    const r = cli(dir, "lint", "docs/broken.lld.md");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("error");
  }, 30_000);

  it("expands a bare directory to the documents under it", async () => {
    // Regression: the glob used to match the directory itself and lintFile died reading it
    // (EISDIR), which named the tool's file handling instead of what the user meant.
    const dir = await workspaceWithDocs();
    const r = cli(dir, "lint", "docs");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 file clean");
    expect(r.stderr).not.toContain("EISDIR");
  }, 30_000);

  it("names a document that does not exist instead of matching nothing", async () => {
    const dir = await workspace();
    const r = cli(dir, "lint", "nope.lld.md");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no such document: nope.lld.md");
  });

  it("reports a module pointer that escapes the project root as an error, not a crash", async () => {
    // parser.ts refuses to resolve such a pointer by throwing; lint's job is to report the
    // document, so the refusal has to surface as an ordinary lint error with an exit code,
    // not as a stack trace.
    const dir = await workspaceWithDocs();
    await writeFile(join(dir, "docs", "escape.lld.md"),
      "# E\n> ../../../../../../etc/passwd\n\n## G\n\n- a claim\n");
    const r = cli(dir, "lint", "docs/escape.lld.md");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("outside the project root");
    expect(r.stderr).not.toContain("LLDTDD_DEBUG");
  }, 30_000);
});

describe("run", () => {
  it("exits zero for a passing document", async () => {
    const dir = await workspace();
    const r = cli(dir, "run", "lld/fixtures/passing.lld.md", "--no-mutate");
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it("exits non-zero for a failing document", async () => {
    const dir = await workspace();
    const r = cli(dir, "run", "lld/fixtures/failing.lld.md", "--no-mutate");
    expect(r.exitCode).toBe(1);
  }, 120_000);

  it("exits zero for an all-pending document, and non-zero once --fail-on-pending asks for that", async () => {
    // Pending is the correct starting state for a document written before its code, so it must
    // not fail a build unless the caller opts into the ratchet.
    const dir = await workspace();
    const plain = cli(dir, "run", "lld/fixtures/pending.lld.md", "--no-mutate");
    expect(plain.exitCode).toBe(0);
    const strict = cli(dir, "run", "lld/fixtures/pending.lld.md", "--fail-on-pending", "--no-mutate");
    expect(strict.exitCode).toBe(1);
  }, 120_000);

  it("expands a bare directory to the documents under it", async () => {
    const dir = await workspaceWithDocs();
    const r = cli(dir, "run", "docs", "--no-mutate");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("EISDIR");
  }, 120_000);
});

describe("single-document commands", () => {
  it("refuse a directory argument cleanly instead of reading it", async () => {
    const dir = await workspace();
    const r = cli(dir, "drift", "lld");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("expected a document, got a directory");
  });
});
