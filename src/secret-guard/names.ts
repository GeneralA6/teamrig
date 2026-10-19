/**
 * The environment variables whose value is a secret, as regular expressions over the name, case ignored. A team's
 * own patterns come after these, in order, and the last pattern that matches a name decides: `!pattern` keeps a
 * variable printable, as `!^TOKENIZERS_` would. A store's connection URL is matched by its kind (`DB_URL`, `CACHE_URL`),
 * never by vendor: a team adds the names of its own stack.
 */
export const DEFAULT_SECRET_ENV_NAMES: readonly string[] = [
  'TOKEN',
  'SECRET',
  'PASSW',
  'PASSPHRASE',
  '(?:^|_)PASS(?:_|$)',
  'CRED',
  'AUTH(?!OR|_SOCK)',
  'PRIVATE',
  '(?:^|_)(?:API_?)?KEY(?:_|$)',
  'ACCESS_?KEY',
  '(?:^|_)DSN(?:_|$)',
  'DB(?:_\\w*)?_UR[IL]',
  '(?:^|_)(?:DATABASE|SQL|PG|POSTGRES\\w*|MYSQL|CACHE|BROKER|AMQP|QUEUE)(?:_\\w*)?_UR[IL]',
  'CONN(?:ECTION)?_?STR(?:ING)?',
  'WEBHOOK',
  'COOKIE',
  '(?:^|_)PAT(?:_|$)',
  '(?:^|_)SALT(?:_|$)',
];

interface CompiledName {
  readonly keep: boolean;
  readonly pattern: RegExp;
}

/** The secret variable names of a team: the defaults, then its own patterns. */
export class SecretNames {
  private readonly patterns: readonly CompiledName[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns.map((pattern) => {
      const keep = pattern.startsWith('!');
      return { keep, pattern: new RegExp(keep ? pattern.slice(1) : pattern, 'iu') };
    });
  }

  /** True when the variable `name` holds a secret. */
  secret(name: string): boolean {
    let secret = false;
    for (const { keep, pattern } of this.patterns) {
      if (pattern.test(name)) {
        secret = !keep;
      }
    }
    return secret;
  }
}
