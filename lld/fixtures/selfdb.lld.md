# Synthetic self-database

> lld/fixtures/selfdb.ts

A fixture, not a design document. It exists so a test can check that the self-database family fires
on a module that is not the one real module the family was written against, and that the tests it
derives actually run there.

The claims below are phrased in the family's vocabulary on purpose: that is what is being probed.

## Reads need no network

- reads require no network; returns all database data without any network call

## Write ordering

- concurrent writes complete in order; write ordering is structural

## Fault recovery

- a failed write does not stall the queue
