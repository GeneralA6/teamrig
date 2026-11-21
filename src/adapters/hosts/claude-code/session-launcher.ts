import type { HostDeps, SessionLauncher } from '../../../plugin-api/index.ts';

/** The folder Claude Code started the session in; its hooks and what its tools run inherit it. */
const PROJECT_DIR = 'CLAUDE_PROJECT_DIR';
/** How Claude Code was started: `cli` for a terminal tab. */
const ENTRYPOINT = 'CLAUDE_CODE_ENTRYPOINT';
/** `bg` for a background session; unset for any other. */
const SESSION_KIND = 'CLAUDE_CODE_SESSION_KIND';

/** The variable's value trimmed, or undefined when it is unset or blank: a blank one tells nothing. */
function told(env: HostDeps['env'], name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Claude Code's sessions, in the environment of one run. */
export function sessionLauncher(env: HostDeps['env']): SessionLauncher {
  return {
    identity: () => ({ projectDir: told(env, PROJECT_DIR), startedAs: told(env, ENTRYPOINT), sessionKind: told(env, SESSION_KIND) }),
  };
}
