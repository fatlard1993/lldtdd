# Synthetic store collection

> lld/fixtures/stock/crates.ts

A fixture, not a design document. It exists so a test can check that a `createStore` collection gets the
same schema facts a `createCRUD` one does, from typed field specs named through a `const`, and that the
write-order and recovery claims derive against the store's own queue rather than a database module's.

## Field completeness

- missing fields default to empty string, not null
- only declared fields survive a write

## Write ordering

- concurrent writes complete in order; write ordering is structural

## Fault recovery

- a failed write does not stall the queue
