import { defineConnector } from "../../../plugin-api/index.js";
import { declaration } from "./declaration.js";
/** The local adapter: the connector of a team that keeps its tasks in the register and reaches no outside tool. */
export default defineConnector({ declaration, create: () => ({}) });
