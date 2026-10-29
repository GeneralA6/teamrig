import { SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS, type SecretPattern } from './secret-patterns.ts';
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
 * so every check that refuses one agrees. The broad `SecretScanner` set stays for register and inbox text.
 */
export const WRITE_TIME_SHAPES: readonly SecretPattern[] = [...SECRET_TOKEN_PATTERNS, ...SECRET_TEXT_PATTERNS.filter(({ id }) => !PROSE_SHAPES.has(id))];

/** A value a framing shape holds that only stands in for a secret: `<pass>`, `${TOKEN}`, `*****`, `changeme`, `...`. */
const PLACEHOLDER = /[<>${}*[\]]|^(?:pass|password|passwd|pwd|secret|user|xxx+|changeme|example|redacted|\.\.\.)$/i;
/** A framed value shorter than this is a word, not a secret (`https://u:p@host` in an example). */
const MIN_FRAMED_SECRET = 6;

/** True when a framing shape's `value` only stands in for a secret. */
export function isPlaceholderValue(value: string): boolean {
  return value.length < MIN_FRAMED_SECRET || PLACEHOLDER.test(value);
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

  /** Every secret in `text`, shape by shape in the order found; a placeholder in a framing shape is not one. */
  hitsIn(text: string): SecretShapeHit[] {
    const hits: SecretShapeHit[] = [];
    for (const { shape, global } of this.patterns) {
      for (const match of text.matchAll(global)) {
        const value = shape.secretGroup === undefined ? match[0] : match[shape.secretGroup];
        if (value === undefined || value === '' || (shape.secretGroup !== undefined && isPlaceholderValue(value))) continue;
        hits.push({ id: shape.id, description: shape.description, value });
      }
    }
    return hits;
  }
}
