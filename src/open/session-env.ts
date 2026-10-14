import { ENV, type Env } from '../core/home.ts';

/**
 * Variables a running Claude Code session sets for its own tools. A terminal started from inside one
 * (Konsole and x-terminal-emulator inherit this process's environment) would pass them on, and the new
 * session would look nested inside the old one and could reach its messaging socket.
 */
export const CLAUDE_SESSION_VARIABLES: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
];

export interface SessionIdentity {
  readonly id: string;
  readonly team: string;
  /** The kit home of the session that opened this one, when it was not the default. */
  readonly home: string | undefined;
}

/**
 * The environment Claude Code starts in: the session and team set, so every hook and `teamrig`
 * command in it knows who it is, and the opener's own Claude Code session variables left out.
 */
export function sessionEnv(env: Env, identity: SessionIdentity): Env {
  const kept = Object.entries(env).filter(([name]) => !CLAUDE_SESSION_VARIABLES.includes(name.toUpperCase()));
  return {
    ...Object.fromEntries(kept),
    [ENV.session]: identity.id,
    [ENV.team]: identity.team,
    ...(identity.home === undefined ? {} : { [ENV.home]: identity.home }),
  };
}
