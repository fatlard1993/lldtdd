# Failing Fixture
> lld/fixtures/subject.ts

A document whose single claim is false, on purpose. `lld/run.lld.md` runs this one to check that a
failing claim exits non-zero -- the contract that makes lldtdd usable as a build gate at all.

If this document ever starts passing, that is the bug: it would mean either the claim stopped
being checked or the runner stopped reporting a false claim as false.

## Doubling

**method:** `double`

- double(2) → 5
