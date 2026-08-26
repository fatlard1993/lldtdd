# Indirect Fixture
> lld/fixtures/subject.ts

A document whose single top-level claim is bare prose carrying a concrete perspective. The parent has
no test of its own; the perspective has all of it. `lld/run.lld.md` runs this one to check that such
a claim is reported apart from a direct pass. Not part of the main suite -- everything under
`fixtures/` is excluded from the default glob, because these documents exist to be run by other
documents.

## Doubling

**method:** `double`

- doubling is an arithmetic transform of its argument, not a mutation of shared state
  - double(2) → 4
