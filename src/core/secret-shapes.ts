import { createHash } from 'node:crypto';
import { SECRET_LITERAL_PATTERNS, SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS, type SecretPattern } from './secret-patterns.ts';
import { configuredPatterns } from './secrets.ts';

/** One secret a text holds: its shape and its value. The caller hashes or drops the value; nothing prints it. */
export interface SecretShapeHit {
  readonly id: string;
  readonly description: string;
  readonly value: string;
}

/** `password: x` is ordinary prose in a prompt or a note, so the broad assignment shape stays out of the write-time set. */
const PROSE_SHAPES: ReadonlySet<string> = new Set(['secret-assignment']);

/**
 * The write-time set (T1369 R11): the shapes a secret a session writes (a prompt, a command line, a file) is found by,
 * so every check that refuses one agrees: the tokens, the framed text shapes, an API key header and a quoted literal
 * given to a secret-like name. The broad `SecretScanner` set stays for register and inbox text.
 */
export const WRITE_TIME_SHAPES: readonly SecretPattern[] = [
  ...SECRET_TOKEN_PATTERNS,
  ...SECRET_TEXT_PATTERNS.filter(({ id }) => !PROSE_SHAPES.has(id)),
  ...SECRET_LITERAL_PATTERNS,
];

/** A framed value shorter than this is a word, not a secret (`https://u:p@host` in an example); security's tools skip them too. */
const MIN_FRAMED_SECRET = 6;
/**
 * A value that refers to a secret kept elsewhere: `${TOKEN}`, `$TOKEN`, `$(cat f)`, `<token>`, `%TOKEN%`, `{token}`,
 * `[token]`. A `%` must close the name, as a percent-encoded password (`%40bc...`) is a real one.
 */
const REFERENCE = /^(?:[<{[]|\$[{(A-Za-z_]|%[A-Za-z_]\w*%)/;
/** A value masked, redacted or cut short: `*****`, `ab***yz`, `ab12...`, `ab12…`, one character repeated (`xxxxxxxx`, `00000000`). */
const MASKED = /\*{3}|\.{3}|…|^(.)\1+$/;
/** A word that stands in for a secret: `password`, `changeme`, `your_token`, `put-key-here`. */
const PLACEHOLDER_WORD = /^(?:pass(?:word|wd)?|pwd|secret|token|user(?:name)?|changeme|example|sample|dummy|placeholder|redacted|your[\w-]*|[\w-]*[_-]here)$/i;
/**
 * The SHA-256 of sample tokens every tutorial prints, held as hashes because the scrub refuses their shape: jwt.io's
 * HS256 samples, the classic one and the one with `"admin": true`.
 */
const SAMPLE_HASHES: ReadonlySet<string> = new Set([
  '7f75367e7881255134e1375e723d1dea8ad5f6a4fdb79d938df1f1754a830606',
  'c794fa6d20c64efb9adf980ae93af472a1679775862d421ffe55d4a57fad5b3e',
]);

/**
 * True when a framing shape's `value` only stands in for a secret. The value alone is judged, never the host or the
 * whole match (T1099 gap 1): a real password on `localhost` or a host named `example` is still a credential.
 */
export function isPlaceholderValue(value: string): boolean {
  return value.length < MIN_FRAMED_SECRET || REFERENCE.test(value) || MASKED.test(value) || PLACEHOLDER_WORD.test(value) || isSample(value);
}

/** True when the value a framing `shape` caught is not a secret: a placeholder, or a value the shape itself allows. */
export function isFramedPlaceholder(shape: SecretPattern, value: string): boolean {
  return isPlaceholderValue(value) || (shape.isAllowedValue?.(value) ?? false);
}

/** True when `value` is a published sample token rather than anyone's secret. */
function isSample(value: string): boolean {
  return SAMPLE_HASHES.has(createHash('sha256').update(value, 'utf8').digest('hex'));
}

interface ScanPattern {
  readonly shape: SecretPattern;
  /** The shape's pattern with the `g` flag, built once, so one scan finds every match. */
  readonly global: RegExp;
}

/** Finds the secrets a text holds by the write-time set plus a team's own patterns. */
export class SecretShapes {
  private readonly patterns: readonly ScanPattern[];

  /** `extra` are the team config's `secretPatterns` sources, matched case-insensitively. */
  constructor(extra: readonly string[] = []) {
    this.patterns = [...WRITE_TIME_SHAPES, ...configuredPatterns(extra)].map((shape) => ({ shape, global: new RegExp(shape.pattern.source, `${shape.pattern.flags}g`) }));
  }

  /**
   * Every secret in `text`, shape by shape in the order found. A placeholder in a framing shape is not one, nor is a
   * published sample token: a token shape's prefix already says it is a credential, so only the samples pass.
   */
  hitsIn(text: string): SecretShapeHit[] {
    const hits: SecretShapeHit[] = [];
    for (const { shape, global } of this.patterns) {
      for (const match of text.matchAll(global)) {
        const value = shape.secretGroup === undefined ? match[0] : match[shape.secretGroup];
        if (value === undefined || value === '' || (shape.secretGroup === undefined ? isSample(value) : isFramedPlaceholder(shape, value))) continue;
        hits.push({ id: shape.id, description: shape.description, value });
      }
    }
    return hits;
  }
}
