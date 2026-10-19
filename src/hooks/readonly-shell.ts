import type { ReadonlyShellConfig } from '../config/types.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { bashLineReads } from '../readonly-shell/bash.ts';
import { powershellLineReads } from '../readonly-shell/powershell.ts';
import { prefixWords, type ReadonlyRules } from '../readonly-shell/rules.ts';
import type { SnapshotExports } from '../readonly-shell/snapshot.ts';

/** Why the line ran without a prompt, as Claude Code shows it. */
export const READONLY_REASON = 'teamrig read-only shell: every command in the line only reads. [readonlyShell]';

/**
 * The rules a team's config, the hook's environment and the shell snapshot give the check. The shell a Bash call
 * runs in inherits Claude Code's environment, the hook's too, then sources the snapshot, so a name either exports
 * reaches every program the line runs.
 */
export function readonlyRulesOf(config: ReadonlyShellConfig, env: Env, snapshot: SnapshotExports): ReadonlyRules {
  return {
    prefixes: config.allowPrefixes.map(prefixWords),
    exported: new Set([...Object.keys(env), ...snapshot.names]),
    exportsAll: snapshot.all,
  };
}

/** Whether the call's line only reads, judged in the dialect of the tool that runs it; any other tool never does. */
function lineReads(tool: string | undefined, command: string, rules: ReadonlyRules): boolean {
  switch (tool) {
    case 'Bash':
      return bashLineReads(command, rules);
    case 'PowerShell':
      return powershellLineReads(command, rules);
    default:
      return false;
  }
}

/** True when the call would print a secret into the conversation (hooks/secret-guard.ts). */
export type PrintsSecret = (payload: JsonRecord) => boolean;

/**
 * The PreToolUse output for a Bash or PowerShell call: an allow, which skips the permission prompt, when every
 * command in the line provably only reads and none prints a secret; else nothing, so Claude Code's own permission
 * check decides. It never refuses or asks. Claude Code ranks another hook's deny or ask, and the settings' deny and
 * ask rules, above it. A line that prints a secret is never allowed here, even when the team let the secret guard
 * allow it or that guard failed: reading a secret into the conversation always takes a prompt.
 */
export function readonlyShellOutput(payload: unknown, rules: ReadonlyRules, printsSecret: PrintsSecret): string {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined || !lineReads(stringField(payload, 'tool_name'), command, rules) || printsSecret(payload)) {
    return '';
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: READONLY_REASON },
  });
}
