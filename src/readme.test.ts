import { describe, it, expect } from "bun:test";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The README shows examples/auth.lld.md and tells the reader "run it yourself to see it pass".
// A tool whose entire thesis is that documents must not drift from what runs cannot let its own
// front-page example drift from the file it names -- that is the exact failure it exists to prevent,
// in the one place the tool otherwise cannot reach. This test reaches it: the fenced ```markdown
// block that opens with the auth document's title must be that document, byte for byte.
describe("README auth example", () => {
  it("matches examples/auth.lld.md verbatim", async () => {
    const readme = await readFile(resolve(REPO_ROOT, "README.md"), "utf-8");
    const shipped = (await readFile(resolve(REPO_ROOT, "examples/auth.lld.md"), "utf-8")).trimEnd();

    const blocks = readme.split(/```markdown\n/).slice(1).map(b => b.split("\n```")[0]);
    const authBlock = blocks.find(b => b.startsWith("# Auth Service"));

    expect(authBlock, "no ```markdown block starting with '# Auth Service' found in README").toBeDefined();
    expect(authBlock!.trimEnd()).toBe(shipped);
  });
});

// The Commands section has drifted once already: the README block omitted --fail-on-pending and
// --fail-on-weak while the CLI shipped both. Byte-for-byte pinning is wrong here, because the
// README legitimately reformats the block for prose, so this pins the inventory instead: the set
// of commands and the set of flags must match between cli.ts's HELP text and the README's
// Commands code block. Adding or removing either on one side fails, and the message names which
// side is missing what.
describe("README commands block", () => {
  const FLAG = /(?<![\w-])(--?[a-z][\w-]*)/g;
  const flagsIn = (text: string) => new Set([...text.matchAll(FLAG)].map(m => m[1]));

  async function inventories() {
    const { HELP } = await import("./cli.ts");
    const readme = await readFile(resolve(REPO_ROOT, "README.md"), "utf-8");

    const commandsSection = readme.split(/\n## Commands\n/)[1];
    expect(commandsSection, "README has no '## Commands' section").toBeDefined();
    const block = commandsSection!.split("```bash\n")[1]?.split("\n```")[0];
    expect(block, "README's Commands section has no ```bash block").toBeDefined();

    const readmeCommands = new Set(
      [...block!.matchAll(/^lldtdd (\w[\w-]*)/gm)].map(m => m[1]),
    );
    const helpCommands = new Set(
      [...HELP.split("Commands:")[1]!.split("Flags:")[0]!.matchAll(/^  (\w[\w-]*)/gm)].map(m => m[1]),
    );
    return { readmeCommands, helpCommands, readmeFlags: flagsIn(block!), helpFlags: flagsIn(HELP) };
  }

  it("lists every command the CLI's help text lists, and nothing more", async () => {
    const { readmeCommands, helpCommands } = await inventories();
    const missingFromReadme = [...helpCommands].filter(c => !readmeCommands.has(c));
    const missingFromHelp = [...readmeCommands].filter(c => !helpCommands.has(c));
    expect(missingFromReadme,
      `cli.ts HELP lists commands the README Commands block omits: ${missingFromReadme.join(", ")}`,
    ).toEqual([]);
    expect(missingFromHelp,
      `README's Commands block lists commands cli.ts HELP does not: ${missingFromHelp.join(", ")}`,
    ).toEqual([]);
  });

  it("lists every flag the CLI's help text names, and nothing more", async () => {
    const { readmeFlags, helpFlags } = await inventories();
    const missingFromReadme = [...helpFlags].filter(f => !readmeFlags.has(f));
    const missingFromHelp = [...readmeFlags].filter(f => !helpFlags.has(f));
    expect(missingFromReadme,
      `cli.ts HELP names flags the README Commands block omits: ${missingFromReadme.join(", ")}`,
    ).toEqual([]);
    expect(missingFromHelp,
      `README's Commands block names flags cli.ts HELP does not: ${missingFromHelp.join(", ")}`,
    ).toEqual([]);
  });
});
