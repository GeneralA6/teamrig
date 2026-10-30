import { numberField, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The extra-usage pool (T531 case c): dollars the user adds once the week reads 100%, a pool apart from the week,
 * spent on purpose and never read as a new week. `teamrig budget extra` appends one line to the account's extra log,
 * `<state>/usage/extra-log.jsonl` of the team that keeps the account's week files (`accountHolderOf`): an `add` of dollars to the pool, or a `spent` reading of the dollars claude.ai
 * shows spent from it so far, each with the week's use and the W metered since the period's start. Successive spent
 * readings of one period past 100% teach the pool's W per dollar; until a pair exists a configured rate stands in,
 * else the pool is known in dollars only. Instants are stored as ISO strings, like the meter log.
 */
/** The format of the extra log's records; a newer one is skipped on read and refuses a write. */
export const EXTRA_LOG_FORMAT = 1;
/** The week's use from which metered W comes out of the pool instead of the week. */
export const FULL_PCT = 100;
const KINDS = ['add', 'spent'];
/** What sets the team's allowance past the weekly limit; undefined below 100%, where the week's remainder sets it. */
export function pastLimitOf(usedPct, pool) {
    if (usedPct < FULL_PCT) {
        return undefined;
    }
    const leftW = pool?.leftW;
    if (leftW !== undefined && leftW > 0) {
        return 'pool';
    }
    return pool !== undefined && pool.leftUsd > 0 && pool.wPerUsd === undefined ? 'unpriced' : 'empty';
}
function isKind(text) {
    return KINDS.some((kind) => kind === text);
}
function byTime(a, b) {
    return a.at - b.at;
}
function spentReadings(entries) {
    return entries.filter((entry) => entry.kind === 'spent').sort(byTime);
}
/**
 * W per dollar through 0 over successive spent readings of one period, both made at or past 100% (least squares of
 * the W metered between them on the dollars spent between them); undefined with no such pair. All W metered while
 * the week reads 100% comes out of the pool, so each pair prices the pool's dollar.
 */
export function fitWPerUsd(entries) {
    const full = spentReadings(entries).filter((entry) => (entry.weekPct ?? 0) >= FULL_PCT);
    const steps = full.flatMap((entry, index) => {
        const before = index === 0 ? undefined : full[index - 1];
        if (before === undefined || before.start !== entry.start) {
            return [];
        }
        const usd = entry.usd - before.usd;
        const w = entry.w - before.w;
        return usd > 0 && w >= 0 ? [{ usd, w }] : [];
    });
    if (steps.length === 0) {
        return undefined;
    }
    const wByUsd = steps.reduce((sum, step) => sum + step.w * step.usd, 0);
    const usdSquared = steps.reduce((sum, step) => sum + step.usd * step.usd, 0);
    const wPerUsd = wByUsd / usdSquared;
    return wPerUsd > 0 ? { wPerUsd, pairs: steps.length } : undefined;
}
/**
 * The pool at `sight`; undefined while nothing was added. Dollars spent since the last spent reading count only while
 * the week reads 100% or more, from the later of that reading (when it is of this period) and the period's 100%
 * crossing; without either, or without a rate, the last reading stands.
 */
export function poolOf(entries, sight) {
    const addedUsd = entries.reduce((sum, entry) => (entry.kind === 'add' ? sum + entry.usd : sum), 0);
    if (addedUsd <= 0) {
        return undefined;
    }
    const rate = fitWPerUsd(entries);
    const wPerUsd = rate?.wPerUsd ?? sight.configuredWPerUsd;
    const spent = spentReadings(entries);
    const last = spent[spent.length - 1];
    const anchors = [last?.start === sight.start ? last.w : undefined, sight.wAtFull].filter((w) => w !== undefined);
    const sinceW = sight.usedPct >= FULL_PCT && anchors.length > 0 ? Math.max(0, sight.w - Math.max(...anchors)) : 0;
    const spentUsd = (last?.usd ?? 0) + (wPerUsd === undefined ? 0 : sinceW / wPerUsd);
    const leftUsd = Math.max(0, addedUsd - spentUsd);
    return { addedUsd, spentUsd, leftUsd, wPerUsd, learned: rate !== undefined, leftW: wPerUsd === undefined ? undefined : leftUsd * wPerUsd };
}
/**
 * The W metered to the period's 100% crossing: the first meter log line of the period starting at `start` at or past
 * 100% of the week (`PoolSight.wAtFull`); undefined before the week reached it.
 */
export function wAtFullOf(readings, start) {
    return readings.find((reading) => reading.start === start && reading.usedPct >= FULL_PCT)?.w;
}
function iso(at) {
    return new Date(at).toISOString();
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One entry as the log's JSON record. */
export function extraRecordOf(entry) {
    return {
        [VERSION_FIELD]: EXTRA_LOG_FORMAT,
        at: iso(entry.at),
        kind: entry.kind,
        usd: entry.usd,
        ...(entry.weekPct === undefined ? {} : { weekPct: entry.weekPct }),
        start: iso(entry.start),
        end: iso(entry.end),
        w: entry.w,
    };
}
/** One record as an entry; undefined when it is damaged (an add of no dollars counts as damaged). */
export function parseExtraRecord(record) {
    const at = instantOf(record, 'at');
    const kind = stringField(record, 'kind');
    const usd = numberField(record, 'usd');
    const weekPct = numberField(record, 'weekPct');
    const start = instantOf(record, 'start');
    const end = instantOf(record, 'end');
    const w = numberField(record, 'w');
    if (at === undefined || !isKind(kind) || usd === undefined || usd < 0 || start === undefined || end === undefined || start >= end || w === undefined || w < 0) {
        return undefined;
    }
    if ((kind === 'add' && usd === 0) || ('weekPct' in record && (weekPct === undefined || weekPct < 0))) {
        return undefined;
    }
    return { at, kind, usd, weekPct, start, end, w };
}
/** The team's append-only log of extra-usage entries, oldest first. A line per user command keeps it a few lines a week. */
export class ExtraLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /** Every entry, oldest first; damaged lines and lines from a newer teamrig are skipped. */
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        return parse.records.flatMap(({ record, version }) => {
            const entry = version === EXTRA_LOG_FORMAT ? parseExtraRecord(record) : undefined;
            return entry === undefined ? [] : [entry];
        });
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(entry) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), EXTRA_LOG_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(extraRecordOf(entry))}`);
    }
}
