import type { SecretPattern } from '../../src/core/secret-patterns.ts';
import { isFramedPlaceholder, WRITE_TIME_SHAPES } from '../../src/core/secret-shapes.ts';

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
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com', 'git@github.com', 'noreply@github.com']);
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

/**
 * The judge of a framing `shape` whose secret is its `group`: true when the value it caught is one the write-time set
 * lets through too (`${VAULT}`, `<token>`, `SOME_READ_TOKEN`); a match without that value is not.
 */
function framed(shape: SecretPattern, group: number): (match: RegExpExecArray) => boolean {
  return (match) => {
    const value = match[group];
    return value !== undefined && isFramedPlaceholder(shape, value, match);
  };
}

/**
 * A shape of the write-time set, so the scrub refuses every secret a session's read or write is refused for (T1932): a
 * repository line the secret guard redacts on each read files a rotation task each time. A framing shape lets through
 * what that set lets through; a token shape's prefix already says it is a credential, so it passes nothing here.
 */
function secret(shape: SecretPattern): ScrubRule {
  const { id, description, pattern, secretGroup } = shape;
  const rule: ScrubRule = { id, description, pattern, revealMatch: false };
  return secretGroup === undefined ? rule : { ...rule, isAllowed: framed(shape, secretGroup) };
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
  ...WRITE_TIME_SHAPES.map(secret),
];
