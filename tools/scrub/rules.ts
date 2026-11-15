import { PRIVATE_SHAPES } from '../../src/core/private-shapes.ts';
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
  ...PRIVATE_SHAPES.map((shape): ScrubRule => ({ ...shape, revealMatch: false })),
  ...WRITE_TIME_SHAPES.map(secret),
];
