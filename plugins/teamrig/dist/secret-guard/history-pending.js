import { join } from 'node:path';
import { errorMessage, isStringArray, numberField, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { cleanHistory, historyPlaces } from "./history-clean.js";
const PENDING_FORMAT = 1;
const LOG_FORMAT = 1;
/** A record still pending after this long is dropped: its prompt was written long ago, or never will be. */
const EXPIRE_MS = 24 * 60 * 60 * 1000;
/** A clean this long after the block finds the prompt's line if Claude Code wrote it after the hook; none found, none comes. */
const SETTLE_MS = 10 * 60 * 1000;
const RECORD_SUFFIX = '.json';
/** The folder under the kit home that holds the pending records and the log. */
export function historyCleanFolder(kitHome) {
    return join(kitHome, 'history-clean');
}
/**
 * Keeps a blocked prompt's secrets out of Claude Code's history (T1481) whenever Claude Code writes its line: before
 * the hook ran, so the clean at the block removes it, or after, so a clean at a later prompt does. A blocked prompt is
 * cleaned at once and always recorded as pending, since a line found then may be an older prompt with the same secret;
 * each later prompt cleans again until the record settles: its line was found and removed, or a clean ran 10 minutes
 * after the block and found none. Logs counts to `history-clean/log.jsonl`, never a value.
 */
export class HistoryPending {
    files;
    clock;
    secrets;
    pendingDir;
    logPath;
    constructor(files, clock, secrets, kitHome) {
        this.files = files;
        this.clock = clock;
        this.secrets = secrets;
        this.pendingDir = join(historyCleanFolder(kitHome), 'pending');
        this.logPath = join(historyCleanFolder(kitHome), 'log.jsonl');
    }
    /** At a block: records the prompt as pending, then cleans; the clean, or undefined when it failed (logged). */
    async blocked(claude, claudeDir, found) {
        const hashes = [...new Set(found.map(({ hash }) => hash))];
        const at = this.clock.now();
        const record = { at, claude, claudeDir, hashes };
        await this.files.createExclusive(join(this.pendingDir, `${at}-${hashes[0]?.slice(0, 12) ?? 'none'}${RECORD_SUFFIX}`), JSON.stringify({ [VERSION_FIELD]: PENDING_FORMAT, ...record }));
        const shapes = [...new Set(found.map(({ id }) => id))];
        try {
            const clean = await cleanHistory(this.files, historyPlaces(claudeDir), this.secrets, new Set(hashes));
            await this.log('blocked', { shapes, lines: clean.lines, pastes: clean.pastes });
            return clean;
        }
        catch (error) {
            await this.log('failed', { shapes, error: errorMessage(error) });
            return undefined;
        }
    }
    /** At a prompt that was not blocked: cleans again for each pending record, one clean per Claude Code folder. */
    async sweep() {
        const now = this.clock.now();
        const live = new Map();
        for (const name of await this.files.list(this.pendingDir)) {
            if (!name.endsWith(RECORD_SUFFIX)) {
                continue;
            }
            const path = join(this.pendingDir, name);
            const record = pendingOf(await this.files.read(path));
            if (record === undefined || now - record.at > EXPIRE_MS) {
                await this.files.remove(path);
                await this.log('expired', {});
                continue;
            }
            live.set(record.claudeDir, [...(live.get(record.claudeDir) ?? []), { path, record }]);
        }
        for (const [claudeDir, pending] of live) {
            await this.sweepFolder(claudeDir, pending, now);
        }
    }
    async sweepFolder(claudeDir, pending, now) {
        let clean;
        try {
            clean = await cleanHistory(this.files, historyPlaces(claudeDir), this.secrets, new Set(pending.flatMap(({ record }) => record.hashes)));
        }
        catch (error) {
            await this.log('failed', { error: errorMessage(error) });
            return;
        }
        if (clean.lines > 0 || clean.pastes > 0) {
            await this.log('cleaned', { lines: clean.lines, pastes: clean.pastes });
        }
        if (!clean.settled) {
            await this.log('failed', { error: 'the history changed under every attempt' });
            return;
        }
        for (const { path, record } of pending) {
            if (record.hashes.some((hash) => clean.hits.has(hash)) || now - record.at >= SETTLE_MS) {
                await this.files.remove(path);
                await this.log('settled', {});
            }
        }
    }
    async log(event, counts) {
        await this.files.append(this.logPath, toJsonlLine({ [VERSION_FIELD]: LOG_FORMAT, at: this.clock.now(), event, ...counts }));
    }
}
/** A pending record from its file; undefined for a damaged or foreign one, which the sweep drops. */
function pendingOf(text) {
    const record = text === undefined ? undefined : parseObject(text);
    if (record === undefined) {
        return undefined;
    }
    const at = numberField(record, 'at');
    const claude = stringField(record, 'claude');
    const claudeDir = stringField(record, 'claudeDir');
    const hashes = record['hashes'];
    return at === undefined || claude === undefined || claudeDir === undefined || !isStringArray(hashes) ? undefined : { at, claude, claudeDir, hashes };
}
