# Passing Fixture
> lld/fixtures/subject.ts

A document whose single claim is true. `lld/run.lld.md` runs this one to check that a suite with
nothing failing in it exits zero. Not part of the main suite -- everything under `fixtures/` is
excluded from the default glob, because these documents exist to be run by other documents.

## Doubling

**method:** `double`

- double(2) → 4
