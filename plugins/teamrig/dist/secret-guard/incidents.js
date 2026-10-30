import { isStringArray, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The team's secret incidents, an append-only log (`<state>/secret-incidents.jsonl`): each kind of secret a tool's
 * result held, which the secret redactor kept from the model (T1369 R8), with the session, the tool, the call (its id,
 * the session's transcript and the helper that made it), the accounts a URL's credentials named and the task that has it
 * rotated; never the value. It is audit data: nothing trims it. A newer format is skipped on read and refuses a write;
 * format 1, before the call's fields, and format 2, before the accounts (both T1545), are read.
 */
export const SECRET_INCIDENTS_FORMAT = 3;
const READ_FORMATS = new Set([1, 2, SECRET_INCIDENTS_FORMAT]);
/** One incident as written; undefined for a line that is not one. */
export function parseSecretIncident(record) {
    const at = stringField(record, 'at');
    const tool = stringField(record, 'tool');
    const kind = stringField(record, 'kind');
    if (at === undefined || !Number.isFinite(Date.parse(at)) || tool === undefined || kind === undefined) {
        return undefined;
    }
    const session = stringField(record, 'session');
    const toolUseId = stringField(record, 'toolUseId');
    const transcript = stringField(record, 'transcript');
    const agent = stringField(record, 'agent');
    const accounts = record['accounts'];
    const task = stringField(record, 'task');
    return {
        at,
        ...(session === undefined ? {} : { session }),
        tool,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(transcript === undefined ? {} : { transcript }),
        ...(agent === undefined ? {} : { agent }),
        kind,
        ...(isStringArray(accounts) ? { accounts } : {}),
        ...(task === undefined ? {} : { task }),
    };
}
/**
 * The task a session's incident of this kind was given on the zone's day of `now`, the newest one; undefined when
 * none was, so a filing that failed is tried again at the next incident.
 */
export function filedToday(incidents, kind, session, now, zone) {
    const day = zone.day(now);
    return incidents.findLast((incident) => incident.kind === kind && incident.session === session && incident.task !== undefined && zone.day(new Date(incident.at)) === day)?.task;
}
/** The team's append-only log of secret incidents, oldest first. */
export class SecretIncidentLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const incidents = [];
        for (const { record, version } of parse.records) {
            const parsed = READ_FORMATS.has(version) ? parseSecretIncident(record) : undefined;
            if (parsed !== undefined) {
                incidents.push(parsed);
            }
        }
        return { incidents, skipped: parse.unreadable + parse.records.length - incidents.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(incident) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), SECRET_INCIDENTS_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine({ [VERSION_FIELD]: SECRET_INCIDENTS_FORMAT, ...incident })}`);
    }
}
