import { join } from 'node:path';
import { stringField } from "./guards.js";
import { parseObject } from "./jsonl.js";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The prompt hook's dedup logs (inbox-shown, bind-hints): a record older than a week belongs to a Claude Code
 * session that has almost always ended. One still running past it is shown an unread line or a hint once more.
 */
export const DEDUP_LOG_AGE = { keepDays: 7, slackDays: 1 };
/** A line's `at` in epoch milliseconds; undefined for a line that is not a record with a readable `at`. */
function dateOf(line) {
    const record = parseObject(line.trim());
    const at = record === undefined ? undefined : stringField(record, 'at');
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isNaN(ms) ? undefined : ms;
}
function countLines(lines) {
    return lines.filter((line) => line.trim() !== '').length;
}
/**
 * Splits a log at its first record dated at or after `cutoffMs`. Only that leading run moves, never an old record
 * written after a newer one: readers take a key's newest record by file order (inbox/shown.ts, hooks/hint-log.ts),
 * so every key that keeps a record keeps the same newest one.
 */
export function splitByAge(text, cutoffMs) {
    const lines = text.split(/(?<=\n)/);
    const first = lines.findIndex((line) => (dateOf(line) ?? Number.NEGATIVE_INFINITY) >= cutoffMs);
    const end = first === -1 ? lines.length : first;
    const moved = lines.slice(0, end);
    const kept = lines.slice(end);
    return { moved: moved.join(''), movedLines: countLines(moved), kept: kept.join(''), keptLines: countLines(kept) };
}
/**
 * A log whose writes keep it short: an append that finds its oldest record over `keepDays` + `slackDays` old moves
 * every record older than `keepDays` to the state archive, in the same lock (T336).
 */
export class AgedLogFile {
    deps;
    paths;
    policy;
    constructor(deps, paths, policy = DEDUP_LOG_AGE) {
        this.deps = deps;
        this.paths = paths;
        this.policy = policy;
    }
    read() {
        return this.deps.files.read(this.paths.live);
    }
    /** Appends under the log's lock, then archives when due. A failed archive leaves the append saved; the next write retries it. */
    async append(text) {
        await this.deps.mutex.run(async () => {
            await this.deps.files.append(this.paths.live, text);
            // The append is the caller's; the archive is upkeep that the next write runs again.
            await this.archiveIfDue().catch(() => undefined);
        });
    }
    /** What archiving now would move and keep; it reads only and takes no lock. */
    plan() {
        return this.planBefore(this.cutoffMs(this.policy.keepDays));
    }
    /** Moves every record older than `keepDays` to the archive under the log's lock, due or not, and returns what it moved. */
    archive() {
        return this.deps.mutex.run(() => this.archiveBefore(this.cutoffMs(this.policy.keepDays)));
    }
    async archiveIfDue() {
        const text = (await this.deps.files.read(this.paths.live)) ?? '';
        if (splitByAge(text, this.cutoffMs(this.policy.keepDays + this.policy.slackDays)).moved !== '') {
            await this.archiveBefore(this.cutoffMs(this.policy.keepDays));
        }
    }
    async archiveBefore(cutoffMs) {
        const plan = await this.planBefore(cutoffMs);
        if (plan.split.moved !== '') {
            // The archive is written first: a rewrite that then fails leaves the records in both files, never in neither.
            await this.deps.files.append(plan.archiveFile, plan.split.moved);
            await this.deps.files.write(this.paths.live, plan.split.kept);
        }
        return plan;
    }
    async planBefore(cutoffMs) {
        const text = (await this.deps.files.read(this.paths.live)) ?? '';
        const day = new Date(this.deps.clock.now()).toISOString().slice(0, 10).replaceAll('-', '');
        return {
            name: this.paths.name,
            cutoff: new Date(cutoffMs),
            split: splitByAge(text, cutoffMs),
            archiveFile: join(this.paths.archive, `${this.paths.name}-${day}.jsonl`),
        };
    }
    cutoffMs(days) {
        return this.deps.clock.now() - days * DAY_MS;
    }
}
