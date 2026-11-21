import { defineHost, unsupported } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import { hookBridge } from './hook-bridge.ts';
import { hostPaths } from './paths.ts';
import { toolCallShape } from './tool-call.ts';

/**
 * The Antigravity host adapter: translates Antigravity's `hooks.json` lifecycle events, tool call shapes, and
 * workspace/config paths for teamrig. Ports not yet wired for Antigravity return `unsupported(...)`.
 */
export default defineHost({
  declaration,
  create: (deps) => {
    const toolCall = toolCallShape(deps.platform);
    return {
      hooks: hookBridge(toolCall),
      toolCall,
      transcripts: unsupported('Antigravity transcript reader is not wired yet'),
      usage: unsupported('Antigravity has no usage meter wired yet'),
      statusLine: unsupported('Antigravity has no status line hook'),
      paths: hostPaths(deps.platform),
      permissions: unsupported('Antigravity has no Claude Code permission file'),
      plugin: unsupported('Antigravity plugin store port is not wired yet'),
    };
  },
});
