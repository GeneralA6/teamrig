import { defineHost } from "../../../plugin-api/index.js";
import { declaration } from "./declaration.js";
import { statusLine } from "./status-line.js";
import { transcriptReader } from "./transcript.js";
import { usageMeter } from "./usage.js";
/** The Claude Code adapter. Each port moves here from the core as the port split names it. */
export default defineHost({ declaration, create: () => ({ transcripts: transcriptReader, usage: usageMeter, statusLine }) });
