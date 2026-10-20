import { join } from 'node:path';
/** How many logs are kept for each session (and for runs with no session); older ones are removed. */
export const KEPT_LOGS = 20;
const SUFFIX = '.log';
/** The start of every log name of a session, or of runs with no session: `test-<session>-` or `test-`. */
function prefixOf(session) {
    return session === null ? 'test-' : `test-${session}-`;
}
/** The run number in a log name, or undefined for another session's log or any other file. */
function numberOf(name, prefix) {
    if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) {
        return undefined;
    }
    const digits = name.slice(prefix.length, -SUFFIX.length);
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
}
/** The run numbers of a session's logs in `dir`, newest first. */
async function runNumbers(files, dir, prefix) {
    const numbers = (await files.list(dir)).map((name) => numberOf(name, prefix)).filter((n) => n !== undefined);
    return numbers.sort((a, b) => b - a);
}
/**
 * Creates the next log of a session (`session` null: of runs with no session), numbered one past its
 * newest, holding `firstText`; the run's output is appended to it when the run ends. Two runs that start together get different numbers,
 * since a name already taken moves on to the next.
 */
export async function reserveLog(files, dir, session, firstText) {
    const prefix = prefixOf(session);
    const [newest = 0] = await runNumbers(files, dir, prefix);
    for (let next = newest + 1;; next += 1) {
        const path = join(dir, `${prefix}${next}${SUFFIX}`);
        if (await files.createExclusive(path, firstText)) {
            return path;
        }
    }
}
/** Removes a session's logs past the newest `keep`. */
export async function pruneLogs(files, dir, session, keep = KEPT_LOGS) {
    const prefix = prefixOf(session);
    for (const old of (await runNumbers(files, dir, prefix)).slice(keep)) {
        await files.remove(join(dir, `${prefix}${old}${SUFFIX}`));
    }
}
/** How the command ended, as the log's last line: `exit 1`, or `ended by SIGTERM`. */
export function endLine(end) {
    return end.kind === 'exited' ? `exit ${end.code}` : `ended by ${end.signal}`;
}
/** The first line of a log: the command line, as a shell prompt shows it. */
export function commandHeader(command) {
    return `$ ${command}\n`;
}
/**
 * What a log holds after its command line: everything the command printed and how it ended. It is
 * appended, never written over the log: on Windows a file a reader or a virus scan holds open cannot
 * be replaced (T696).
 */
export function logBody(output, end) {
    const printed = output === '' || output.endsWith('\n') ? output : `${output}\n`;
    return `${printed}${endLine(end)}\n`;
}
