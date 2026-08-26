# Command Surface
> src/cli.ts

**mutate:** false

lldtdd is invoked as a program before it is imported as a library, and the program's contract is
the part a shell script or a CI step wires into: which commands exist, what a flag opts into, and
what the exit code means. `src/cli.ts` is only argv parsing and dispatch -- the pipeline it
dispatches to lives in `src/run.ts` and carries its own document, `lld/run.lld.md`. This one
covers what the calling shell sees.

Every claim below spawns the CLI as a real subprocess through `invokeCli` and inspects the exit
code, because exit codes and dispatch are properties of the spawned program, not of any function a
claim could call in-process. That is also why this document sets `**mutate:** false`: each claim
already pays for a process, and mutating the dispatcher would re-spawn all of them once per mutant
to probe wiring the claims exercise end-to-end anyway.

## Asking for help succeeds; failing to name a command does not

**method:** `invokeCli`

A mistyped command that printed the help screen and exited 0 would pass a CI step that meant to
run something. The same care applies one level down: every flag is boolean, so an unrecognized
flag is a typo, and silently ignoring it does the opposite of what was asked -- `--no-mutat` would
run the very mutation pass the user meant to skip.

- `help` prints the command surface and exits zero
  - invokeCli("help") captures r → r.exitCode === 0
- an unrecognized command exits non-zero instead of showing help and succeeding
  - invokeCli("frobnicate") captures r → r.exitCode === 1
- an unrecognized flag is rejected the same way, not silently ignored
  - invokeCli("run", "--no-mutat") captures r → r.exitCode === 1

## `run` hands the pipeline's exit code to the shell unchanged

**method:** `invokeCli`

What decides that code -- a false claim fails, drift and surviving mutations stay advisory -- is
`lld/run.lld.md`'s subject. These claims pin that the program forwards the verdict rather than
re-deciding it.

- a document whose claims hold exits zero
  - invokeCli("run", "lld/fixtures/passing.lld.md", "--no-mutate") captures r → r.exitCode === 0
- a document with a false claim exits non-zero
  - invokeCli("run", "lld/fixtures/failing.lld.md", "--no-mutate") captures r → r.exitCode === 1

## `--fail-on-pending` and `--fail-on-weak` are opt-in ratchets

**method:** `invokeCli`

Pending is the correct state for a document written before its code, and a no-throw-only green may
be all a liveness claim means, so neither fails a run by default -- this project's own CI runs
plain `run`, as an audit rather than a gate. The flags exist for a corpus that has reached zero
pending, or all-strong greens, and wants a regression from that state to fail the build. Each is a
one-way tightening the caller chooses; left off, the exit-code contract above is unchanged.

- without the flag, an all-pending document exits zero
  - invokeCli("run", "lld/fixtures/pending.lld.md", "--no-mutate") captures r → r.exitCode === 0
- with `--fail-on-pending`, the same document exits non-zero
  - invokeCli("run", "lld/fixtures/pending.lld.md", "--fail-on-pending", "--no-mutate") captures r → r.exitCode === 1
- without the flag, a document whose only green is a no-throw check exits zero
  - invokeCli("run", "lld/fixtures/shallow.lld.md", "--no-mutate") captures r → r.exitCode === 0
- with `--fail-on-weak`, the same document exits non-zero
  - invokeCli("run", "lld/fixtures/shallow.lld.md", "--fail-on-weak", "--no-mutate") captures r → r.exitCode === 1

## `lint` fails on errors, not warnings

**method:** `invokeCli`

Errors are defects in the document; warnings are judgment calls about how it is written, and a
judgment call must not fail a build.

- a structurally broken document exits non-zero
  - invokeCli("lint", "lld/fixtures/missing-structure.lld.md") captures r → r.exitCode === 1
- a clean document exits zero, even named under fixtures/ -- the sweep's exclusions apply to the glob, not to a file the user named
  - invokeCli("lint", "lld/fixtures/passing.lld.md") captures r → r.exitCode === 0

## A bare directory means everything under it

**method:** `invokeCli`

Handed a directory, the glob used to match the directory itself and die reading it -- an EISDIR
that named this tool's file handling instead of what the user meant, which was unambiguous. A
directory argument now expands to `<dir>/**/*.lld.md`, for `run` and `lint` alike, with the
sweep's usual exclusions still applied.

- naming a directory lints the documents under it instead of crashing on the directory
  - invokeCli("lint", "lld") captures r → r.exitCode === 0
