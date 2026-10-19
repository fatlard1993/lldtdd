import { createStore } from "./createStore.ts";
import database from "./index.ts";

export default createStore({ db: database, collection: "pallets", fields: ["tag", "dock"] });
