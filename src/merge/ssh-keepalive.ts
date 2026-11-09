import type { Env } from '../core/home.ts';

/**
 * Seconds between the ssh keepalives of a merge's push (T1033). git opens a push's ssh connection before its pre-push
 * hook runs, and nothing crosses it while the hook's checks run. GitHub closes an ssh session that carries no traffic
 * after about 6 minutes (measured 6.03, T862), so every push whose checks ran longer died with exit 141; with a
 * keepalive every 30 seconds the same idle session stayed open.
 */
export const SSH_KEEPALIVE_SECONDS = 30;

/** git's own ssh command, `ssh` from the PATH, with the keepalive: git splits it and still treats it as OpenSSH. */
export const KEEPALIVE_SSH_COMMAND = `ssh -o ServerAliveInterval=${SSH_KEEPALIVE_SECONDS}`;

/** The variables that pick git's ssh command: `GIT_SSH_COMMAND` wins over `core.sshCommand`, which wins over `GIT_SSH`. */
const SSH_VARIABLES: ReadonlySet<string> = new Set(['GIT_SSH_COMMAND', 'GIT_SSH']);

/**
 * `env` with git's ssh command set to {@link KEEPALIVE_SSH_COMMAND}, unless the user chose one: a `GIT_SSH_COMMAND` or
 * `GIT_SSH` variable (in any case, as Windows reads names) or the repository's `core.sshCommand`, `configured`. Setting
 * `GIT_SSH_COMMAND` would override each of them. A push over https ignores it.
 */
export function withSshKeepalive(env: Env, configured: string | undefined): Env {
  const chosen = configured !== undefined || Object.keys(env).some((name) => SSH_VARIABLES.has(name.toUpperCase()));
  return chosen ? env : { ...env, GIT_SSH_COMMAND: KEEPALIVE_SSH_COMMAND };
}
