import { uniqueFindings } from "./findings.js";
/**
 * The secrets a command line holds as text (T1369 R2), by the write-time shapes: the line itself lands in the
 * transcript, so a quiet run counts too. Each names the shape, never the value.
 */
export function literalFindings(command, shapes) {
    return uniqueFindings(shapes.hitsIn(command).map(({ id, description }) => ({ kind: 'literal', id, description })));
}
