import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';

/**
 * The missing-cli hook, PostToolUse and PostToolUseFailure on Bash and PowerShell. Claude Code puts a plugin's
 * `bin/` folder on the Bash tool's PATH through its shell snapshot only; when the snapshot fails to rebuild after
 * a plugin reload (it has a 10-second limit), the Bash tool runs without it until the next reload, so the bare
 * command is not found. A session left there tends to run another copy it finds in the plugin cache, an older
 * version. The model gets one line after that result: run the copy its hooks run, by its path.
 */

/** The shell tools whose output can say the bare command is missing. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/**
 * What bash, sh, zsh and fish print for a command they do not find (`bash: teamrig: command not found`,
 * `sh: 1: teamrig: not found`, `zsh: command not found: teamrig`, `fish: Unknown command: teamrig`), and what
 * PowerShell and cmd print (`The term 'teamrig' is not recognized`). The name must stand alone, not end a path
 * or a longer name. KIT_NAME is a plain word, so it goes into the pattern as it is.
 */
const NOT_FOUND = new RegExp(
  String.raw`(?<![\w./\\-])${KIT_NAME}: (?:command )?not found|(?:command not found|Unknown command): ${KIT_NAME}(?![\w.-])|'${KIT_NAME}' is not recognized`,
);

/** The events the hook answers: a shell call that exits 0 ends in PostToolUse, one that does not in PostToolUseFailure. */
export type MissingCliEvent = 'PostToolUse' | 'PostToolUseFailure';

/** The event of a shell call whose output says the bare command was not found; undefined for any other call. */
export function missingCliOf(payload: unknown): MissingCliEvent | undefined {
  if (!isRecord(payload) || !SHELL_TOOLS.has(stringField(payload, 'tool_name') ?? '')) {
    return undefined;
  }
  const event = stringField(payload, 'hook_event_name');
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') {
    return undefined;
  }
  return NOT_FOUND.test(shellTextOf(payload)) ? event : undefined;
}

/** What the call printed: a failed call's `error`, else the result's stdout and stderr (or its text). */
function shellTextOf(payload: JsonRecord): string {
  const response = payload['tool_response'];
  const printed = isRecord(response)
    ? [stringField(response, 'stdout'), stringField(response, 'stderr')]
    : [typeof response === 'string' ? response : undefined];
  return [stringField(payload, 'error'), ...printed].filter((text): text is string => text !== undefined).join('\n');
}

/**
 * The line for the model. `script` is the CLI this session's hooks run, the copy the bare command would run; its
 * path goes with forward slashes, which Bash and PowerShell both take.
 */
export function missingCliLine(script: string, command: string): string {
  const path = script.replaceAll('\\', '/');
  return (
    `${command}: the shell did not find the bare \`${command}\` command (Claude Code's shell snapshot failed to rebuild after a plugin reload). ` +
    `For the rest of this session run the installed copy by its path: \`node "${path}" <command> ...\`, never another copy from the plugin cache (another version). ` +
    `The user's /reload-plugins brings the bare name back.`
  );
}

/** The hook's stdout: the line as context for the model after the tool's result, under the event it answers. */
export function missingCliOutput(event: MissingCliEvent, line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } });
}
