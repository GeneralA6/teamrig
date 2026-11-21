import { defineHost } from "../../../plugin-api/index.js";
import { declaration } from "./declaration.js";
import { hookBridge } from "./hook-bridge.js";
import { hostPaths } from "./paths.js";
import { statusLine } from "./status-line.js";
import { toolCallShape } from "./tool-call.js";
import { transcriptReader } from "./transcript.js";
import { usageMeter } from "./usage.js";
/**
 * The Claude Code adapter: its hook input and replies, its tools by kind, its transcripts, what its calls cost, its
 * status line and where it keeps its files. Each further port moves here from the core as the port split names it.
 */
export default defineHost({
    declaration,
    create: (deps) => {
        const toolCall = toolCallShape(deps.platform);
        return { hooks: hookBridge(toolCall), toolCall, transcripts: transcriptReader, usage: usageMeter, statusLine, paths: hostPaths(deps.env, deps.platform) };
    },
});
