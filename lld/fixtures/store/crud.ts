import database from "./index.ts";
let n = 0;
export const createCRUD = (collection: string, fields: string[]) => ({
  get data() { return (database.db.data[collection] ??= {}); },
  async create(data: Record<string, unknown>) {
    const id = `id${++n}`;
    const entry = { ...Object.fromEntries(fields.map(f => [f, data[f] ?? ""])), id };
    this.data[id] = entry;
    await database.write();
    return entry;
  },
  read({ id }: { id?: string } = {}) { return id ? this.data[id] || false : this.data; },
});
