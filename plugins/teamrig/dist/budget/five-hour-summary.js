import { join } from 'node:path';
import { numberField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from "../core/jsonl.js";
/**
 * The five-hour summary: the current five-hour window's readings folded into one, kept beside the snapshots as
 * `<snapshot folder>/.five-hour` by `teamrig statusline`. Not every plan has this window: Claude Code's status input
 * then reads `five_hour` null, no reading reaches the fold, no file is written and every reader shows nothing. The
 * format, one JSON object:
 *
 * - `v`: `FIVE_HOUR_SUMMARY_FORMAT`;
 * - `resets_at`: when the window resets, in epoch seconds;
 * - `used_percentage`, `at`: its highest reading, and when that was last shown, ISO 8601 UTC;
 * - `first_percentage`, `first_at`: its earliest reading, which a rate needs.
 *
 * The folder holds no history of a window, so a reader opens this file alone, and a missing or damaged one starts
 * again from the next reading: rebuilding it from every snapshot would cost an account with no window that read on
 * each status line run, for nothing. Its name is not a `.json` one, so no reader takes it for a snapshot.
 */
export const FIVE_HOUR_SUMMARY_FILE = '.five-hour';
/** The five-hour summary's format; a field added to it raises this. */
export const FIVE_HOUR_SUMMARY_FORMAT = 1;
const MS_PER_SECOND = 1000;
/**
 * The snapshot's reading as a fold of one, if it shows a window. It is dated by when its session began to show it, as
 * the week's is: a redraw rewrites the file with the same reading.
 */
function readingOf(snapshot) {
    const window = snapshot.rateLimits?.fiveHour ?? null;
    const at = Date.parse(snapshot.rateLimitsSince ?? snapshot.ts);
    if (window === null || Number.isNaN(at)) {
        return undefined;
    }
    return { resetsAt: window.resetsAt, usedPct: window.usedPct, at, firstPct: window.usedPct, firstAt: at };
}
/**
 * Two folds as one. Windows float, so only `resets_at` tells them apart: the later one counts, whole. Within a window
 * the highest counts, because readings of it have fallen by a point between tabs; of equal ones the later, so a window
 * gone quiet shows a falling rate.
 */
function mergeFiveHour(a, b) {
    if (a.resetsAt !== b.resetsAt) {
        return a.resetsAt > b.resetsAt ? a : b;
    }
    const top = b.usedPct > a.usedPct || (b.usedPct === a.usedPct && b.at > a.at) ? b : a;
    const first = b.firstAt < a.firstAt ? b : a;
    return { resetsAt: a.resetsAt, usedPct: top.usedPct, at: top.at, firstPct: first.firstPct, firstAt: first.firstAt };
}
/** The fold as the summary file's text. */
export function formatFiveHourSummary(fold) {
    return JSON.stringify({
        [VERSION_FIELD]: FIVE_HOUR_SUMMARY_FORMAT,
        resets_at: Math.round(fold.resetsAt / MS_PER_SECOND),
        used_percentage: fold.usedPct,
        at: new Date(fold.at).toISOString(),
        first_percentage: fold.firstPct,
        first_at: new Date(fold.firstAt).toISOString(),
    });
}
function storedTime(value) {
    const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
}
/** The summary file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseFiveHourSummary(text) {
    const stored = parseObject(text);
    if (stored === undefined || recordVersion(stored) !== FIVE_HOUR_SUMMARY_FORMAT) {
        return undefined;
    }
    const resetsAt = numberField(stored, 'resets_at');
    const usedPct = numberField(stored, 'used_percentage');
    const firstPct = numberField(stored, 'first_percentage');
    const at = storedTime(stored['at']);
    const firstAt = storedTime(stored['first_at']);
    if (resetsAt === undefined || usedPct === undefined || firstPct === undefined || at === undefined || firstAt === undefined) {
        return undefined;
    }
    return { resetsAt: resetsAt * MS_PER_SECOND, usedPct, at, firstPct, firstAt };
}
/** The folder's five-hour window when one is running at `now`: undefined for an account with none, or one that has reset. */
export async function readFolderFiveHour(files, dir, now) {
    const text = await files.read(join(dir, FIVE_HOUR_SUMMARY_FILE));
    const fold = text === undefined ? undefined : parseFiveHourSummary(text);
    return fold === undefined || fold.resetsAt <= now ? undefined : fold;
}
/**
 * Folds a snapshot just saved in the folder into its summary, written only when that changes it. A snapshot with no
 * window touches nothing. Two status lines that fold at once may lose one's reading (the later write wins); that
 * session's next run folds it again. Returns whether it wrote the summary. A summary a newer teamrig wrote is refused
 * (`NewerDataError`), never overwritten.
 */
export async function foldIntoFiveHourSummary(files, dir, snapshot) {
    const reading = readingOf(snapshot);
    if (reading === undefined) {
        return false;
    }
    const path = join(dir, FIVE_HOUR_SUMMARY_FILE);
    const text = await files.read(path);
    writableObject(path, text, FIVE_HOUR_SUMMARY_FORMAT);
    const kept = text === undefined ? undefined : parseFiveHourSummary(text);
    const next = formatFiveHourSummary(kept === undefined ? reading : mergeFiveHour(kept, reading));
    if (next === text) {
        return false;
    }
    await files.write(path, next);
    return true;
}
