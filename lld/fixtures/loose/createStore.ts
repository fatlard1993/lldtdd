// A createStore whose changes don't take turns: each writes as soon as it's made. Its write-order claim
// must fail -- the check slows the first write down, and an unqueued second change finishes first.
let n = 0;

export const createStore = ({ db, collection, fields }: { db: { data: Record<string, any>; write(): Promise<unknown> }; collection: string; fields: string[] }) => {
  const records = () => (db.data[collection] ??= {});

  return {
    async create(body: Record<string, unknown>) {
      const id = `l${++n}`;
      const entry = { ...Object.fromEntries(fields.map(f => [f, body[f] ?? ""])), id };
      records()[id] = entry;
      await db.write();
      return entry;
    },
    read({ id }: { id?: string } = {}) {
      return id === undefined ? records() : records()[id] ?? false;
    },
  };
};
