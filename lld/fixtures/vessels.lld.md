# Synthetic CRUD entity

> lld/fixtures/store/vessels.ts

A fixture, not a design document. It exists so a test can check that the CRUD family derives against
a `createCRUD` entity that is not the one real entity those patterns were written against -- its own
collection, its own field names, its own tiny store.

The field names matter here. `hullName`, `berth` and `capacity` describe the same behaviour as any
other schema while looking nothing like a bookmark, which is what caught a derivation that silently
required a url-ish field and a name-ish field to be present.

## Field completeness

- missing fields default to empty string, not null
- only declared fields survive a write
