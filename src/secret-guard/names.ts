import { PatternList } from './pattern-list.ts';

/**
 * The environment variables whose value is a secret, as regular expressions over the name, case ignored. A team's
 * own patterns come after these, in order, and the last pattern that matches a name decides: `!pattern` keeps a
 * variable printable, as `!^TOKENIZERS_` would. A store's connection URL is matched by its kind (`DB_URL`, `CACHE_URL`),
 * never by vendor: a team adds the names of its own stack. An auth mechanism or source (`DB_AUTH_MECHANISM=GSSAPI`, a
 * connection string's `authSource=appDb`) names how one signs in, never the secret (T1549).
 */
export const DEFAULT_SECRET_ENV_NAMES: readonly string[] = [
  'TOKEN',
  'SECRET',
  'PASSW',
  'PASSPHRASE',
  '(?:^|_)PASS(?:_|$)',
  'CRED',
  'AUTH(?!OR|_SOCK|_?(?:MECH|SOURCE))',
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

/** The secret variable names of a team: the defaults, then its own patterns. */
export class SecretNames {
  private readonly patterns: PatternList;

  constructor(patterns: readonly string[]) {
    this.patterns = new PatternList(patterns);
  }

  /** True when the variable `name` holds a secret. */
  secret(name: string): boolean {
    return this.patterns.matches(name);
  }
}
