import { createCRUD } from "./crud.ts";
export default createCRUD("vessels", ["hullName", "berth", "capacity"]);
