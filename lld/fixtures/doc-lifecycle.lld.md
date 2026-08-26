# Document lifecycle fixture

> lld/fixtures/lifecycle-subject.ts

**beforeEach:** `docReset()`

A fixture, not a design document. `lld/pipeline.lld.md` runs it to check that a document-level
lifecycle hook reaches a group that declares none, and that a group declaring its own keeps it.

## Inherits the document default

**method:** `ranDocDefault`

- ranDocDefault() -> true

## Overrides it locally

**method:** `ranGroupOverride`
**beforeEach:** `groupReset()`

- ranGroupOverride() -> true
