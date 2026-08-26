// A synthetic self-database module: the persistence layer *is* the module.
//
// Exists to prove the self-database family generalizes. It deliberately shares no name with the one
// real module that family was written against -- different collections (`vessels`, not that
// project's), different fields, a different queue property, an in-memory store instead of a file.
// The only thing in common is the structure the family gates on: an `init`, a `write()`, and a `db`
// holding the data, with no imported database.
//
// If a derived test only works because of something specific to that other project, it fails here.

interface Store {
  data: Record<string, Record<string, Record<string, unknown>>>;
  write: () => Promise<void>;
}

const store: Store = {
  data: {},
  write: async () => {
    // Stands in for a real flush. Kept async so the queue below has something to chain.
    persisted = JSON.stringify(store.data);
  },
};

/** Where a flush lands. Asserting against this is how a test can tell a write really happened. */
export let persisted = "";

const selfDb = {
  db: store,
  default: { vessels: {} } as Record<string, unknown>,

  /** Serializes writes. Concurrent callers queue rather than interleave. */
  _pending: Promise.resolve() as Promise<unknown>,

  async init(): Promise<void> {
    store.data = { vessels: {} };
    persisted = "";
    await store.write();
  },

  write(): Promise<unknown> {
    selfDb._pending = selfDb._pending
      .catch(() => {}) // a failed write must not poison the queue for the next caller
      .then(() => store.write());
    return selfDb._pending;
  },
};

export default selfDb;
