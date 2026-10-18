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

/** Variables that make Claude Code a teamrig session: its id, its team, and that `launch` runs it. */
const TEAMRIG_SESSION_VARIABLES: readonly string[] = [ENV.session, ENV.team, ENV.launched];

function withoutVariables(env: Env, names: readonly string[]): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name.toUpperCase())));
}

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
  return {
    ...withoutVariables(env, CLAUDE_SESSION_VARIABLES),
    [ENV.session]: identity.id,
    [ENV.team]: identity.team,
    ...(identity.home === undefined ? {} : { [ENV.home]: identity.home }),
  };
}

/**
 * The environment a session outside any team resumes in: neither the opener's Claude Code session variables nor its
 * teamrig session, so the resumed session is not taken for the opener; the kit home set when it is not the default.
 */
export function plainSessionEnv(env: Env, home: string | undefined): Env {
  return {
    ...withoutVariables(env, [...CLAUDE_SESSION_VARIABLES, ...TEAMRIG_SESSION_VARIABLES]),
    ...(home === undefined ? {} : { [ENV.home]: home }),
  };
}
