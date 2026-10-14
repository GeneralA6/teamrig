export interface ScrubRule {
  readonly id: string;
  readonly description: string;
  /** Scanned for every match; the scanner adds the `g` flag when it is missing. */
  readonly pattern: RegExp;
  /** Returns true for a harmless match, such as a placeholder or a documentation address. */
  readonly isAllowed?: (match: RegExpExecArray) => boolean;
  /** Print the matched text in findings. Off for generic rules, whose output may land in public CI logs. */
  readonly revealMatch: boolean;
}

const PLACEHOLDER_USERS = new Set(['you', 'user', 'username', 'me', 'name', 'runner', 'example', 'someone']);
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com', 'git@github.com']);
const ALLOWED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'users.noreply.github.com'];
const ALLOWED_IPV4 = /^(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

function isAllowedEmail(match: RegExpExecArray): boolean {
  const address = match[0].toLowerCase();
  const domain = (match[1] ?? '').toLowerCase();
  return (
    ALLOWED_EMAILS.has(address) ||
    ALLOWED_EMAIL_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))
  );
}

function secret(id: string, description: string, pattern: RegExp): ScrubRule {
  return { id, description, pattern, revealMatch: false };
}

/** Checks that are safe to publish: they name no private term, only shapes of private data. */
export const GENERIC_RULES: readonly ScrubRule[] = [
  {
    id: 'home-path',
    description: 'absolute path inside a user home folder',
    pattern: /(?:\b[A-Za-z]:[\\/]+Users[\\/]+|(?<![\w.~$])\/(?:Users|home)\/)([^\\/\s"'`<>{}$%*]+)/g,
    isAllowed: (match) => PLACEHOLDER_USERS.has((match[1] ?? '').toLowerCase()),
    revealMatch: false,
  },
  {
    id: 'email',
    description: 'e-mail address',
    pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
    isAllowed: isAllowedEmail,
    revealMatch: false,
  },
  {
    id: 'ipv4',
    description: 'IPv4 address outside the loopback and documentation ranges',
    pattern: new RegExp(`(?<!\\w|\\d\\.)${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g'),
    isAllowed: (match) => ALLOWED_IPV4.test(match[0]),
    revealMatch: false,
  },
  {
    id: 'internal-host',
    description: 'internal host name',
    pattern: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|intranet|corp)\b/g,
    revealMatch: false,
  },
  secret('private-key', 'private key block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g),
  secret('github-token', 'GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g),
  secret('anthropic-key', 'Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g),
  secret('sk-key', 'API key with an sk- prefix', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g),
  secret('aws-key', 'AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  secret('slack-token', 'Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g),
  secret('google-key', 'Google API key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g),
  secret('jwt', 'JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  {
    id: 'assigned-secret',
    description: 'literal value assigned to a secret-like name',
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    isAllowed: (match) => /^[$<%{]/.test(match[1] ?? ''),
    revealMatch: false,
  },
];
