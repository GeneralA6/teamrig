import type { SecretShapes } from '../core/secret-shapes.ts';
import { uniqueFindings, type SecretFinding } from './findings.ts';

/**
 * The secrets a command line holds as text (T1369 R2), by the write-time shapes: the line itself lands in the
 * transcript, so a quiet run counts too. Each names the shape, never the value.
 */
export function literalFindings(command: string, shapes: SecretShapes): SecretFinding[] {
  return uniqueFindings(shapes.hitsIn(command).map(({ id, description }): SecretFinding => ({ kind: 'literal', id, description })));
}
