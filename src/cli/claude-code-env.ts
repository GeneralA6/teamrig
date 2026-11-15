import { ENV } from '../core/home.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * Whether Claude Code started this run: it sets CLAUDECODE for its Bash and PowerShell tools, what they run and its
 * hook commands, but not for the plugin's mod, which runs the pane's buttons and a typed `/teamrig` line with Claude
 * Code's own environment. So a set value rules out the person's own routes; an unset one proves nothing, as a script
 * may clear it.
 */
export function underClaudeCode(runtime: CliRuntime): boolean {
  const set = runtime.env[ENV.claudeCode];
  return set !== undefined && set !== '';
}
