/** One sealed `claude -p` run of the recorded session. */
export interface Turn {
  /** What the turn is for, named in an error when it fails. */
  readonly name: string;
  readonly args: readonly string[];
}

export interface TurnInput {
  /** The session id the first turn starts and the later turns resume. */
  readonly sessionId: string;
  /** The recorder plugin's folder. */
  readonly pluginDir: string;
  readonly model: string;
  /** The machine's platform: only Windows has the PowerShell tool. */
  readonly platform: NodeJS.Platform;
}

/** The file the tools turn writes, reads, edits and searches, in the session folder. */
const NOTES = 'notes.txt';

/**
 * The steps of the tools turn, one tool call each: every file tool, each shell, a shell call that fails and a read
 * that fails (PostToolUseFailure), and one helper (SubagentStart, SubagentStop and a helper transcript).
 */
function toolSteps(platform: NodeJS.Platform): string[] {
  return [
    `Write the file ${NOTES} in the current folder with the single line: alpha`,
    `Read ${NOTES}`,
    `Edit ${NOTES}, replacing alpha with beta`,
    `Grep for beta in ${NOTES}`,
    'Glob for *.txt in the current folder',
    'Run the Bash command: echo recorded-bash',
    ...(platform === 'win32' ? ['Run the PowerShell command: Write-Output recorded-powershell'] : []),
    'Run the Bash command: exit 3 (it fails on purpose; go on)',
    'Read the file missing.txt in the current folder (it does not exist; go on)',
    'Start one Agent helper with the prompt "Reply with the word helper." and wait for its answer',
  ];
}

/** The tools the tools turn may call without a permission prompt, which a headless turn cannot answer. */
function allowedTools(platform: NodeJS.Platform): string {
  return ['Write', 'Read', 'Edit', 'Grep', 'Glob', 'Bash', ...(platform === 'win32' ? ['PowerShell'] : []), 'Agent'].join(',');
}

/**
 * What every turn's environment adds, to keep the account's own instruction files (the user's `CLAUDE.md` loads
 * whatever the setting sources are) out of the session and so out of its transcripts.
 */
export const SEALED_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };

/**
 * The recorded session's turns, in order: a new session that calls each tool, the session resumed for one more
 * prompt, then a manual compaction. Each is sealed: `--setting-sources project` in an empty folder loads no user or
 * project hook, so only the recorder plugin's hooks run, and `--strict-mcp-config` with no MCP config loads none of
 * the account's connectors, whose tool names a transcript would list.
 */
export function turnsOf(input: TurnInput): Turn[] {
  const sealed = ['--plugin-dir', input.pluginDir, '--setting-sources', 'project', '--strict-mcp-config', '--model', input.model];
  const steps = toolSteps(input.platform).map((step, index) => `${index + 1}. ${step}.`);
  const prompt = `Do these steps in order, one tool call per step; skip none and add none.\n${steps.join('\n')}\nThen reply with the word done.`;
  return [
    { name: 'tools', args: ['-p', prompt, '--session-id', input.sessionId, '--allowedTools', allowedTools(input.platform), ...sealed] },
    { name: 'resume', args: ['-p', 'Reply with the word again.', '--resume', input.sessionId, ...sealed] },
    { name: 'compact', args: ['-p', '/compact', '--resume', input.sessionId, ...sealed] },
  ];
}
