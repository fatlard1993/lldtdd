import { createStore } from "./createStore.ts";
import database from "./index.ts";

const fields = { label: { type: "string" }, bay: { type: "string" }, sealed: { type: "string" } };

export default createStore({ db: database, collection: "crates", fields });
