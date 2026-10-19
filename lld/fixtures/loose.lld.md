# Unqueued store collection

> lld/fixtures/loose/pallets.ts

A fixture, not a design document: a `createStore` collection whose changes don't take turns. The claim
below is false of it, and a test checks that it fails rather than passing on timing.

## Write ordering

- concurrent writes complete in order; write ordering is structural
