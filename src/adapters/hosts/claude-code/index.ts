import { defineHost } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import { hookBridge } from './hook-bridge.ts';
import { toolCallShape } from './tool-call.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

/**
 * The Claude Code adapter: its hook input and replies, its tools by kind, its transcripts and what its calls cost.
 * Each further port moves here from the core as the port split names it.
 */
export default defineHost({
  declaration,
  create: (deps) => {
    const toolCall = toolCallShape(deps.platform);
    return { hooks: hookBridge(toolCall), toolCall, transcripts: transcriptReader, usage: usageMeter };
  },
});
