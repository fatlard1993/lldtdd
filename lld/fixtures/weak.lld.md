# Weak Fixture
> lld/fixtures/subject.ts

A document that passes while leaving part of its module undescribed. It says nothing about
`halve`, so mutating `halve` produces a surviving mutation -- and the run still exits zero.

That combination is the point. `lld/run.lld.md` runs this document to check that a surviving
mutation is reported without becoming a build failure. A document is allowed to be deliberately
silent about a behavior, and this one is the smallest example of that being fine.

## Doubling

**method:** `double`

- double(2) → 4
