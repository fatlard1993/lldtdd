// The database a fixture store writes through: data held in memory, and a write the store awaits.
const data: Record<string, Record<string, Record<string, unknown>>> = {};

const database = {
  db: { data, write: async () => {} },
  get data() {
    return database.db.data;
  },
  async init() {
    for (const key of Object.keys(data)) delete data[key];
  },
  write: () => database.db.write(),
};

export default database;
