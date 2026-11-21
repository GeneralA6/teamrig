import { defineTerminal } from "../../../plugin-api/index.js";
import { declaration } from "./declaration.js";
/** The tmux adapter. It builds no port yet: its launcher calls move here from the core's open path. */
export default defineTerminal({ declaration, create: () => ({}) });
