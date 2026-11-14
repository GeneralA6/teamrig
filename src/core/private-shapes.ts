/**
 * Shapes of private data that name no private term: a path inside a user's home folder, an e-mail address, an IPv4
 * address and an internal host name. The repository scrub refuses them in a commit, and text teamrig posts to an
 * issue host is refused for them, so both agree on what counts as private.
 */
export interface PrivateShape {
  readonly id: string;
  readonly description: string;
  /** Global, so every match in a text is read. */
  readonly pattern: RegExp;
  /** True for a harmless match, such as a placeholder user or a documentation address. */
  readonly isAllowed?: (match: RegExpExecArray) => boolean;
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

/** Every private shape, in the order a check reports them. */
export const PRIVATE_SHAPES: readonly PrivateShape[] = [
  {
    id: 'home-path',
    description: 'absolute path inside a user home folder',
    pattern: /(?:\b[A-Za-z]:[\\/]+Users[\\/]+|(?<![\w.~$])\/(?:Users|home)\/)([^\\/\s"'`<>{}$%*]+)/g,
    isAllowed: (match) => PLACEHOLDER_USERS.has((match[1] ?? '').toLowerCase()),
  },
  {
    id: 'email',
    description: 'e-mail address',
    pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
    isAllowed: isAllowedEmail,
  },
  {
    id: 'ipv4',
    description: 'IPv4 address outside the loopback and documentation ranges',
    pattern: new RegExp(`(?<!\\w|\\d\\.)${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g'),
    isAllowed: (match) => ALLOWED_IPV4.test(match[0]),
  },
  {
    id: 'internal-host',
    description: 'internal host name',
    pattern: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|intranet|corp)\b/g,
  },
];

/** The first shape `text` holds a match of that its allow check does not let through, or undefined when none. */
export function privateShapeIn(text: string): PrivateShape | undefined {
  return PRIVATE_SHAPES.find((shape) => {
    for (const match of text.matchAll(new RegExp(shape.pattern))) {
      if (match[0] !== '' && shape.isAllowed?.(match) !== true) {
        return true;
      }
    }
    return false;
  });
}
