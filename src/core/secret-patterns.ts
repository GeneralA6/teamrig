/**
 * The shapes of secret teamrig refuses to write into a shared file (inbox lines, task titles, refs, notes and
 * evidence; see `SecretScanner`) and the scrub refuses in the repository (see `tools/scrub/rules.ts`).
 * This module is the one place they are defined, so both checks always agree.
 */

/** One shape of secret. */
export interface SecretPattern {
  /** A stable id; the scrub reports it as its rule id. */
  readonly id: string;
  /** What the shape is, as a refusal names it. A refusal names the shape, never the matched text. */
  readonly description: string;
  /** Has no `g` flag, so `test` keeps no state between calls; the scrub adds `g` when it scans for every match. */
  readonly pattern: RegExp;
}

/**
 * Credential formats with a fixed prefix or frame, matched case-sensitively as the issuers print them.
 * Two guard against prose: the `sk-` and Slack shapes require a digit, as a random key always has one
 * and a long hyphenated word (`sk-learn-compatible-...`) does not.
 */
export const SECRET_TOKEN_PATTERNS: readonly SecretPattern[] = [
  { id: 'private-key', description: 'private key block', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'github-token', description: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { id: 'anthropic-key', description: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'sk-key', description: 'API key with an sk- prefix', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/ },
  { id: 'aws-key', description: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', description: 'Slack token', pattern: /\bxox[abeoprs]-(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{10,}/ },
  { id: 'google-key', description: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { id: 'stripe-key', description: 'Stripe live key', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}/ },
  { id: 'jwt', description: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

/**
 * Secrets written as text rather than as a token: credentials inside a URL and `password=`-style assignments.
 * Only shared-file writes use these; the scrub has its own stricter assignment rule, as documentation shows
 * placeholders such as `password: ${VAULT}`.
 * An assignment's key never ends a name with a `/` in it (a branch such as `feat/jwt-previous-secret`, a path):
 * a note naming one ahead of a colon names it, it does not assign it. A dotted key (`jwt.secret`), a header
 * (`X-Api-Key`) and a URL's query still count.
 */
export const SECRET_TEXT_PATTERNS: readonly SecretPattern[] = [
  { id: 'url-credentials', description: 'credentials in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { id: 'secret-assignment', description: 'password or key assignment', pattern: /(?<!\/[\w.-]*)\b(?:password|passwd|secret|api[_-]?key)\s*[=:]\s*\S/i },
];
