import type { SessionVariables } from '../../../plugin-api/index.ts';

/**
 * Claude Code sets it for its Bash and PowerShell tools, what they run and its hook commands, and not for the
 * plugin's mod, which runs the pane's buttons and a typed `/teamrig` line with Claude Code's own environment.
 */
export const AGENT_MARK = 'CLAUDECODE';
/** The id of the session a tool call, what it runs or a hook command belongs to. */
export const SESSION_ID = 'CLAUDE_CODE_SESSION_ID';
/** The folder Claude Code started the session in; its hooks and what its tools run inherit it. */
export const PROJECT_DIR = 'CLAUDE_PROJECT_DIR';

/** What Claude Code tells a run about its session by: its one mark, then which session it is and where it started. */
export const SESSION_VARIABLES: SessionVariables = { marks: [AGENT_MARK], identity: [SESSION_ID, PROJECT_DIR] };
