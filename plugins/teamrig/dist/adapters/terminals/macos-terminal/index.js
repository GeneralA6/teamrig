import { defineTerminal } from "../../../plugin-api/index.js";
import { declaration } from "./declaration.js";
/** The macOS Terminal adapter. It builds no port yet: its launcher call moves here from the core's open path. */
export default defineTerminal({ declaration, create: () => ({}) });
