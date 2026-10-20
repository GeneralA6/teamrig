import { createHash } from 'node:crypto';

/**
 * A short, stable fingerprint of a text: an inbox line, a handover note (`refresh --ready`), or a rule line and the
 * core rule it was judged against (src/rules/verdicts.ts). It is
 * the first 16 hex digits of the SHA-256 of the text's UTF-8 bytes, so a reader without `node:crypto`
 * can compute the same value and pass it to `unreadOf`.
 */
export function lineHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
