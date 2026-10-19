import { appendRecord, parseLedger } from "./ledger.js";
/** A load's id is the start of a new id, unique among the ledger's loads: short enough to type into `teamrig load end`. */
const ID_LENGTH = 8;
/** New ids tried before giving up; with random ids, one clash is already rare. */
const ID_TRIES = 10;
/** An instant as the team reads it: `2030-01-08 12:00 IST`. */
function minuteText(ms, zone) {
    return zone.minute(new Date(ms));
}
function isLoad(record) {
    return record.type === 'load';
}
function refused(reason) {
    return { kind: 'refused', reason };
}
function startRefusal(rules, start) {
    if (start.startedAt > rules.nowMs) {
        return `a load cannot start in the future (${minuteText(start.startedAt, rules.zone)})`;
    }
    if (start.targets !== 'host') {
        const unknown = start.targets.filter((target) => !rules.knownTargets.includes(target));
        if (unknown.length > 0) {
            return `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a deploy target of this team (known: ${[...rules.knownTargets, 'host'].join(', ')})`;
        }
    }
    return rules.scanner.refusal('what the load is', start.what);
}
function freshId(ports, taken) {
    for (let tries = 0; tries < ID_TRIES; tries += 1) {
        const id = ports.newId().slice(0, ID_LENGTH);
        if (!taken.has(id)) {
            return id;
        }
    }
    throw new Error(`no free load id after ${ID_TRIES} tries`);
}
/**
 * Declares a background load from `start.startedAt` with a new id, written to the ledger. Refused for a start in the
 * future, a target no repository deploys, or a secret in what it is, since the ledger is shared.
 */
export async function startLoad(ports, ledger, rules, start) {
    const refusal = startRefusal(rules, start);
    if (refusal !== undefined) {
        return refused(refusal);
    }
    const taken = new Set(parseLedger((await ports.files.read(ledger)) ?? '').filter(isLoad).map((load) => load.id));
    const record = {
        type: 'load',
        id: freshId(ports, taken),
        session: start.session,
        what: start.what,
        targets: start.targets,
        startedAt: new Date(start.startedAt).toISOString(),
        endedAt: null,
    };
    await appendRecord(ports.files, ledger, record);
    return { kind: 'done', record };
}
/** Ends the session's open load `end.id`. Refused for no such open load, another session's, or an end in the future or before its start. */
export async function endLoad(ports, ledger, end) {
    const records = parseLedger((await ports.files.read(ledger)) ?? '').filter((record) => isLoad(record) && record.id === end.id);
    const started = records.find((record) => record.endedAt === null);
    if (started === undefined || records.some((record) => record.endedAt !== null)) {
        return refused(`no open load "${end.id}"`);
    }
    if (started.session !== end.session) {
        return refused(`load "${end.id}" belongs to ${started.session}`);
    }
    if (end.endedAt > end.nowMs) {
        return refused(`a load cannot end in the future (${minuteText(end.endedAt, end.zone)})`);
    }
    const startedAt = Date.parse(started.startedAt);
    if (end.endedAt < startedAt) {
        return refused(`load "${end.id}" started at ${minuteText(startedAt, end.zone)}, after ${minuteText(end.endedAt, end.zone)}`);
    }
    const record = { ...started, endedAt: new Date(end.endedAt).toISOString() };
    await appendRecord(ports.files, ledger, record);
    return { kind: 'done', record };
}
