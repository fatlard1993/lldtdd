// Fixture implementation for the documents beside it. Deliberately trivial: these fixtures exist
// to exercise the runner's own contracts (what exits zero, what does not, what mutation survival
// does to the exit code), so anything interesting in here would only add ways for them to fail
// for unrelated reasons.

export function double(n: number): number {
  return n * 2;
}

// Claimed by nothing, on purpose. `lld/fixtures/weak.lld.md` describes `double` and stays silent
// about this one, which gives that document a genuinely surviving mutation -- the state
// `lld/run.lld.md` needs in order to check that a survivor does not fail the run.
export function halve(n: number): number {
  return n / 2;
}
