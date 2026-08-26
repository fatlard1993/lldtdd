# Pending Fixture
> lld/fixtures/subject.ts

A document that is entirely pending, on purpose: its one claim carries no outcome, no inline call,
and no perspective, so nothing derives a test from it. That is the honest starting state for a
document written before its code. `lld/cli.lld.md` runs this one to check that pending never fails
a plain `run`, and that `--fail-on-pending` makes it fail -- the opt-in ratchet, exercised from
the shell's side.

## Doubling

- doubling is stable under repetition
