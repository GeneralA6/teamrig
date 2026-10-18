import { findLineAtOrAfter, readLines } from "../budget/cursor.js";
import { discoverTranscripts } from "../budget/discover.js";
import { parseTranscriptLine } from "../budget/line.js";
import { formatUtcDay, MS_PER_DAY } from "../core/time.js";
import { newThread, ScorecardTally, ThreadFold } from "./scorecard.js";
/** Days and cursors a scorecard keeps: about a quarter, so a trend across skill changes stays readable. */
export const SCORECARD_DAYS_KEPT = 92;
/** A thread idle this long has its open runs charged, so a run in a session that ended still counts. */
export const RUN_IDLE_MS = MS_PER_DAY;
/** The most transcript bytes one scan reads; the rest waits for the next scan. */
export const SCAN_MAX_BYTES = 512 * 1024 * 1024;
/** One read's size, which bounds the memory a scan holds at once. */
export const SCAN_CHUNK_BYTES = 32 * 1024 * 1024;
/**
 * Reads what the transcripts gained since the last scan into the saved scorecard. A file read for the first time
 * starts at its first line at or after `since`, found by a binary search; one that shrank (rewritten) resumes after
 * its last counted time. Threads idle a day have their open runs charged; days and cursors past the kept window go.
 */
export async function scanTranscripts(deps, run) {
    const now = deps.clock.now();
    const keptFrom = startOfDay(now) - (SCORECARD_DAYS_KEPT - 1) * MS_PER_DAY;
    const since = Math.max(run.since, keptFrom);
    const stored = await deps.store.load();
    const tally = new ScorecardTally(stored?.days ?? {});
    const cursors = { ...stored?.cursors };
    let budget = run.maxBytes;
    let bytesRead = 0;
    let files = 0;
    let catchingUp = false;
    const paths = (await discoverTranscripts(deps.source, run.projectsDir, since)).flatMap((session) => [...session.main, ...session.subagents]);
    for (const path of paths) {
        const size = await deps.source.size(path);
        if (size === undefined) {
            continue;
        }
        const cursor = await cursorAt(deps.source, path, size, cursors[path], since);
        const fold = new ThreadFold(cursor, tally, run.skills);
        let offset = cursor.offset;
        while (offset < size && budget > 0) {
            const batch = await readLines(deps.source, path, offset, size, Math.min(SCAN_CHUNK_BYTES, budget));
            if (batch.end === offset) {
                break;
            }
            budget -= batch.bytes;
            bytesRead += batch.bytes;
            for (const raw of batch.lines) {
                const line = parseTranscriptLine(raw);
                if (line !== undefined) {
                    fold.line(line);
                }
            }
            offset = batch.end;
        }
        files += offset > cursor.offset ? 1 : 0;
        catchingUp ||= offset < size && budget <= 0;
        cursors[path] = fold.cursor(offset, size);
    }
    for (const [path, cursor] of Object.entries(cursors)) {
        if (cursor.open.length > 0 && cursor.lastAt <= now - RUN_IDLE_MS) {
            const fold = new ThreadFold(cursor, tally, run.skills);
            fold.closeAll();
            cursors[path] = fold.cursor(cursor.offset, cursor.size);
        }
    }
    const keptDay = formatUtcDay(new Date(keptFrom));
    const state = {
        since: stored === undefined ? formatUtcDay(new Date(since)) : stored.since,
        days: Object.fromEntries(Object.entries(tally.days()).filter(([day]) => day >= keptDay)),
        cursors: Object.fromEntries(Object.entries(cursors).filter(([, cursor]) => cursor.lastAt >= keptFrom)),
    };
    await deps.store.save(state);
    return { state, files, bytesRead, catchingUp };
}
function startOfDay(at) {
    return at - (at % MS_PER_DAY);
}
async function cursorAt(source, path, size, stored, since) {
    if (stored === undefined) {
        return newThread(await findLineAtOrAfter(source, path, size, since), size, since);
    }
    return stored.offset <= size ? stored : { ...stored, offset: await findLineAtOrAfter(source, path, size, stored.lastAt + 1), size };
}
