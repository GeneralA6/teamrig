/** Always refused, whatever a team adds: credentials in URLs and `password=`-style assignments. */
const BUILT_IN: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:password|passwd|secret|api[_-]?key)\s*[=:]\s*\S/i,
];

/** Refuses text that looks like it carries a secret, before it lands in a shared file. */
export class SecretScanner {
  private readonly patterns: readonly RegExp[];

  /** `extra` are regular expression sources from the config, matched case-insensitively. */
  constructor(extra: readonly string[] = []) {
    this.patterns = [...BUILT_IN, ...extra.map((source) => new RegExp(source, 'iu'))];
  }

  looksSecret(text: string): boolean {
    return this.patterns.some((pattern) => pattern.test(text));
  }
}
