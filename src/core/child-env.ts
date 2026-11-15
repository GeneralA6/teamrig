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

/** Claude Code's own login. A session is Claude Code, so sessionEnv keeps these for it; no other program gets them. */
export const CLAUDE_LOGIN_VARIABLES: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * `env` without the credential variables, but those `pass` names. Names compare without case, as Windows reads them,
 * so `gh_token` is left out as well and a `pass` entry in any case keeps its variable.
 */
export function withoutCredentials(env: Env, pass: readonly string[]): Env {
  const kept = new Set(pass.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const upper = name.toUpperCase();
      return kept.has(upper) || !CREDENTIAL_VARIABLES.includes(upper);
    }),
  );
}
