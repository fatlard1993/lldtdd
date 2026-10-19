// A synthetic createStore: the factory shape VBC's app kit ships, small enough to read in one go. Each
// change waits for the one before it, so a slow write can't be overtaken and a failed one doesn't stall
// the next -- the behaviour the write-order and recovery claims check.
type FieldSpec = Record<string, { type?: string } | unknown> | string[];

let n = 0;

export const createStore = ({ db, collection, fields }: { db: { data: Record<string, any>; write(): Promise<unknown> }; collection: string; fields: FieldSpec }) => {
  const names = Array.isArray(fields) ? fields : Object.keys(fields);
  const records = () => (db.data[collection] ??= {});
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(change: () => Promise<T>): Promise<T> => {
    const done = queue.then(change);
    queue = done.catch(() => {});
    return done;
  };

  return {
    create(body: Record<string, unknown>) {
      return serially(async () => {
        const id = `c${++n}`;
        const entry = { ...Object.fromEntries(names.map(f => [f, body[f] ?? ""])), id };
        records()[id] = entry;
        try {
          await db.write();
        } catch (error) {
          delete records()[id];
          throw error;
        }
        return entry;
      });
    },
    read({ id }: { id?: string } = {}) {
      return id === undefined ? records() : Object.hasOwn(records(), id) ? records()[id] : false;
    },
  };
};
