import { ENTITY_TAG } from "./gh.js";
import { plainLine } from "./issues.js";
import { exitText } from "../open/processes.js";
/** The status line `gh api -i` prints first, such as `HTTP/2.0 304 Not Modified`. */
const STATUS_LINE = /^HTTP\/[0-9.]+ ([1-5][0-9]{2})\b/;
const NOT_MODIFIED = 304;
const ETAG_HEADER = 'etag';
/**
 * Reads a probe's answer from what `gh api -i` printed: its status line and headers come first on stdout whatever
 * the status, and gh exits 1 on a 304 as on any status that is not a success, so the status line decides, not the
 * exit code. A tag that is no ENTITY_TAG is dropped, so the next probe reads the whole answer rather than send it.
 */
export function probeAnswerOf(result) {
    const [head = ''] = result.stdout.split(/\r?\n\r?\n/, 1);
    const [statusLine = '', ...headers] = head.split(/\r?\n/);
    const status = STATUS_LINE.exec(statusLine)?.[1];
    if (status === undefined) {
        const how = result.end.kind === 'signal' ? `was stopped (${result.end.signal})` : exitText(result.end.code, result.stderr);
        return { kind: 'failed', reason: plainLine(`gh api ${how}`) };
    }
    const code = Number(status);
    if (code === NOT_MODIFIED) {
        return { kind: 'unchanged' };
    }
    if (code >= 200 && code < 300) {
        const tag = headerOf(headers, ETAG_HEADER);
        return { kind: 'changed', tag: tag !== undefined && ENTITY_TAG.test(tag) ? tag : undefined };
    }
    return { kind: 'failed', reason: plainLine(`GitHub answered HTTP ${code}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().split(/\r?\n/)[0] ?? ''}`}`) };
}
/** A header's value, its name matched in any case, or undefined when the answer has none. */
function headerOf(lines, name) {
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) {
            return line.slice(colon + 1).trim();
        }
    }
    return undefined;
}
