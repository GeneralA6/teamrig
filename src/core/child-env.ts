import type { Env } from './home.ts';

/**
 * Variables that hold a credential by their name: GitHub and npm tokens, and cloud and AI provider keys. A program
 * teamrig starts for the team (a queued or tested command, a config-named hook, `refresh.endCommand`, a session) gets
 * none of them unless the owner names it in `delivery.passEnv`, so a credential reaches only the programs that need it.
 */
export const CREDENTIAL_VARIABLES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'SLACK_TOKEN',
  'SLACK_BOT_TOKEN',
  'STRIPE_SECRET_KEY',
];

/**
 * The name endings that mark a credential however a tool names it (a package registry's token, a database password, a
 * service's key), compared on the upper-case name. A fixed list misses every credential it does not name, so the
 * programs that run the team's code drop these too. Each ending is whole: `MAX_OUTPUT_TOKENS` or `KEYBOARD` is kept.
 */
export const CREDENTIAL_NAME_ENDINGS: readonly string[] = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'API_KEY',
  'APIKEY',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'SECRET_KEY',
  'CREDENTIALS',
];

/** Claude Code's own login. A session is Claude Code, so sessionEnv keeps these for it; no other program gets them. */
export const CLAUDE_LOGIN_VARIABLES: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

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

/** Whether an upper-case variable name ends in one of the credential endings. */
function hasCredentialEnding(upper: string): boolean {
  return CREDENTIAL_NAME_ENDINGS.some((ending) => upper.endsWith(ending));
}

/** `env` without the variables `drop` picks, but those `pass` names; names compare without case, as Windows reads them. */
function without(env: Env, pass: readonly string[], drop: (upper: string) => boolean): Env {
  const kept = new Set(pass.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const upper = name.toUpperCase();
      return kept.has(upper) || !drop(upper);
    }),
  );
}

/**
 * `env` without the credential variables, by the list or by a credential ending of their name, but those `pass` names:
 * the environment of a program that runs the team's code (a queued or tested command, a hook, `refresh.endCommand`),
 * which needs no credential the owner did not name. Names compare without case, so `gh_token` is left out as well and
 * a `pass` entry in any case keeps its variable.
 */
export function withoutCredentials(env: Env, pass: readonly string[]): Env {
  return without(env, pass, (upper) => CREDENTIAL_VARIABLES.includes(upper) || hasCredentialEnding(upper));
}

/**
 * `env` without only the listed credential variables, but those `pass` names: a team session's environment. A session
 * is Claude Code, whose own tools and MCP servers may need a key of the user's under any name, so only the list goes.
 */
export function withoutListedCredentials(env: Env, pass: readonly string[]): Env {
  return without(env, pass, (upper) => CREDENTIAL_VARIABLES.includes(upper));
}

/** The names `withoutCredentials` leaves out of `env`, sorted, for a run's log to say what its program did not get. */
export function heldBackCredentials(env: Env, pass: readonly string[]): readonly string[] {
  const kept = new Set(Object.keys(withoutCredentials(env, pass)));
  return Object.keys(env)
    .filter((name) => !kept.has(name))
    .sort();
}

/**
 * The variables a parked queue step keeps on disk (T4093): where programs, the home and temp folders are, the locale,
 * and Node's own settings. An allow-list, so a secret under a name no list knows never lands in a file; every other
 * variable the step gets comes from the dispatcher's environment in memory (`dispatchedEnvOf`).
 */
export const PARKED_VARIABLES: readonly string[] = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'USERNAME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_OPTIONS',
  'NODE_ENV',
  'NODE_PATH',
  'NO_COLOR',
  'FORCE_COLOR',
];

/** teamrig's own variables (the session, the team, a held lock): a parked step keeps its parker's, never the dispatcher's. */
export const TEAMRIG_VARIABLE_PREFIX = 'TEAMRIG_';

function isTeamrigVariable(name: string): boolean {
  return name.toUpperCase().startsWith(TEAMRIG_VARIABLE_PREFIX);
}

/**
 * The parker's Claude Code session variables a parked step keeps, so a nested `teamrig` in it still resolves the
 * parker's tab: none is a secret. The rest of CLAUDE_SESSION_VARIABLES stays off disk; the messaging token is a
 * secret, and the step simply goes without it and the socket.
 */
export const PARKED_SESSION_VARIABLES: readonly string[] = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR'];

/** Variables a dispatched step never takes from the dispatcher: teamrig's own and its starter's Claude Code session's. */
function isSessionVariable(name: string): boolean {
  return isTeamrigVariable(name) || CLAUDE_SESSION_VARIABLES.includes(name.toUpperCase());
}

/**
 * What of `env` a parked step writes to disk: the `PARKED_VARIABLES`, the `PARKED_SESSION_VARIABLES` and teamrig's
 * own, names compared without case.
 */
export function parkedEnvOf(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const upper = name.toUpperCase();
      return isTeamrigVariable(name) || PARKED_VARIABLES.includes(upper) || PARKED_SESSION_VARIABLES.includes(upper);
    }),
  );
}

/**
 * The environment a parked step runs with: the dispatcher's, held in memory, with the step's parked variables over it.
 * The dispatcher's teamrig and Claude Code session variables are left out, so the step is never read as the session
 * that started the dispatcher and never holds its messaging socket or token; its credentials stay, and the step's
 * `delivery.passEnv` then keeps only those its team lets through, as for any queued step. Dispatcher and parker are
 * the same OS user on the same host.
 */
export function dispatchedEnvOf(dispatcher: Env, parked: Env): Env {
  const parkedNames = new Set(Object.keys(parked).map((name) => name.toUpperCase()));
  const base = Object.entries(dispatcher).filter(([name]) => !isSessionVariable(name) && !parkedNames.has(name.toUpperCase()));
  return { ...Object.fromEntries(base), ...parked };
}
