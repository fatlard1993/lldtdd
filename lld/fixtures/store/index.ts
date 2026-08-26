const store: Record<string, Record<string, Record<string, unknown>>> = {};
export default {
  db: { data: store, write: async () => {} },
  async init() { for (const k of Object.keys(store)) delete store[k]; },
  write: async () => {},
};
