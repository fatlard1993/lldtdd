# Security

## Trust model: an `.lld.md` is executable input

`lldtdd run` and `lldtdd mutate` execute the code their documents describe. That is the whole point
of the tool (a claim runs against the real module), and it is stated in the README. Running these
commands on a document is therefore equivalent to running the code that document points at and the
code its claims contain.

Concretely, document-authored text reaches the generated, executed test file through several
channels: the module pointer (`> path`), `**setup:** / **method:** / **beforeAll:** / **beforeEach:**`
annotations, `inspect` assertion bodies, and `__expr` argument passthroughs (`new X(...)`, dotted
identifiers, balanced parentheticals). The generated `bun test` subprocess inherits the current
environment. This is by design and is safe for the ordinary case: **your own documents, describing
your own code, on your own machine.**

`run` and `mutate` also import the subject module during fact extraction (to read its runtime
exports and run zero-arg scenarios). That import happens in a separate subprocess (`inspectWorker.ts`),
not in lldtdd's own process: a subject that calls `process.exit`, crashes the interpreter, or tampers
with globals at import takes down only that worker, and lldtdd reads it as a failed inspection. In
particular a module that exits before the suite finishes is reported as a failed run, never as a
green one -- a run that does not execute every test it generated is a crash, not a pass.

The read-only commands do not execute the module: `lint`, `suggest`, and `drift` never load or run it
unless you pass `--execute`. They do *read* it, and follow its in-project relative imports as extra
source for fact extraction -- but every such read is contained to the project root (symlinks
followed), so a document you did not write cannot make them read files outside the project, whether
through a climbing `../` import chain or a committed symlink. The pre-push hook (`.githooks/`) lints
only and deliberately refuses `--execute`, so checking out someone else's branch and pushing does
not execute their document's code.

## The gap: the executing verb is the default

The bare command `lldtdd` (no arguments) is `lldtdd run`, and `run` executes. Nothing in the tool
distinguishes "a document I wrote" from "a document that arrived in a pull request or a cloned
repo." So a hostile `.lld.md` in a branch you fetch and run is arbitrary code execution as your user,
with your environment, the shortest path being a single `inspect` claim that reads `process.env`.

This is inherent: `run` and `mutate` execute code by design, so the residual risk here is not a bug to
fix but a trust/UX decision about *when* to execute a document that did not originate locally. Options under
consideration:

- Require an explicit opt-in (e.g. `--i-trust-this` or a first-run confirmation) before `run`/`mutate`
  execute a document that did not originate locally.
- Print a one-line banner naming the file whose code is about to execute, before the first run of a
  foreign document.
- Scrub the child process environment of secrets before spawning the test subprocess.

## Limits of mutation-strength scores

Mutation strength measures cooperative code. The subject module runs inside the mutation pass and
can detect that it is a mutant (its own file name via `import.meta.url`, or "lldtdd-" markers in
`process.argv`) and behave differently when it is. A module written to game the score can make
every mutation appear caught, so "all mutations caught" is not evidence against an adversarial
module.

## Reporting

This is a personal project. If you find a security issue, open an issue describing it, or email the
maintainer (see `package.json`). Do not include working exploit payloads in a public issue.
