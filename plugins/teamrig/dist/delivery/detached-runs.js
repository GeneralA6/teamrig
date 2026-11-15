import { join } from 'node:path';
import { isRecord, numberField, stringField } from "../core/guards.js";
/** The suffix of a detached run's record, beside its log in the detached folder (`detachedDirOf`). */
export const RUN_RECORD_SUFFIX = '.run.json';
/** The record of the detached run `id` in the detached folder `dir`. */
export function runRecordPathOf(dir, id) {
    return join(dir, `${id}${RUN_RECORD_SUFFIX}`);
}
export function formatRunRecord(record) {
    return `${JSON.stringify(record)}\n`;
}
/** The record in `text`, or undefined when it is not one (a torn or foreign file is left for no one to report). */
export function parseRunRecord(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value) || value['v'] !== 1) {
        return undefined;
    }
    const [id, team, session, what, log, startedAt, pid] = [
        stringField(value, 'id'),
        stringField(value, 'team'),
        stringField(value, 'session'),
        stringField(value, 'what'),
        stringField(value, 'log'),
        stringField(value, 'startedAt'),
        numberField(value, 'pid'),
    ];
    if (id === undefined || team === undefined || session === undefined || what === undefined || log === undefined || startedAt === undefined || pid === undefined || !Number.isSafeInteger(pid)) {
        return undefined;
    }
    const runningAt = stringField(value, 'runningAt');
    return { v: 1, id, team, session, what, log, pid, startedAt, ...(runningAt === undefined ? {} : { runningAt }) };
}
/**
 * The runs of `team` in the detached folder `dir` whose process is gone. A reused pid makes a dead run look alive until
 * that process ends too: its death is told late, never falsely.
 */
export async function deadRunsOf(ports, dir, team) {
    const dead = [];
    for (const name of await ports.files.list(dir)) {
        if (!name.endsWith(RUN_RECORD_SUFFIX)) {
            continue;
        }
        const path = join(dir, name);
        const text = await ports.files.read(path);
        const record = text === undefined ? undefined : parseRunRecord(text);
        if (record !== undefined && record.team === team && !ports.alive(record.pid)) {
            dead.push({ path, record });
        }
    }
    return dead;
}
/** The line a dead run's session hears: what died, at which stage, and that nothing will report its end. */
export function diedText(record) {
    const stage = record.runningAt === undefined ? 'while it waited for its turn' : 'while its step ran';
    return `queue ${record.id} died ${stage}: ${record.what}: its process (pid ${record.pid}) ended with no end of its own, so nothing else reports it; re-run it; log ${record.log}`;
}
