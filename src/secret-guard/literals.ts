import type { SecretShapes } from '../core/secret-shapes.ts';
import { uniqueFindings, type SecretFinding } from './findings.ts';

/**
 * The secrets a command line holds as text (T1369 R2), by the write-time shapes: the line itself lands in the
 * transcript, so a quiet run counts too. Each names the shape, never the value.
 */
export function literalFindings(command: string, shapes: SecretShapes): SecretFinding[] {
  return uniqueFindings(shapes.hitsIn(command).map(({ id, description }): SecretFinding => ({ kind: 'literal', id, description })));
}

/**
 * The secrets the texts a file-writing call writes hold (T1369 R3), by the same shapes: the call's input lands in the
 * transcript and its text in the file. Each names the shape, never the value.
 */
export function writtenFindings(texts: readonly string[], shapes: SecretShapes): SecretFinding[] {
  return uniqueFindings(texts.flatMap((text) => shapes.hitsIn(text)).map(({ id, description }): SecretFinding => ({ kind: 'written', id, description })));
}
