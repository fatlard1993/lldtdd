# Shallow Fixture
> lld/fixtures/subject.ts

A document whose only green is a no-throw check. `double(2) -> resolves` runs the call and asserts
nothing about what it returned, so it reports `◐ shallow` rather than a pass and would stay green
against any implementation that does not crash. `lld/cli.lld.md` runs this one to check that a
shallow green exits zero by default and non-zero under `--fail-on-weak`.

## Doubling

**method:** `double`

- double(2) → resolves
