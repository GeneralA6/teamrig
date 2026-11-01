import { stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_DAY } from "../core/time.js";
import { formatEndTime } from "./format.js";
/**
 * A leader's cut, for today at most, of one session to its own daily budget: past that budget the session is held
 * whatever room the team has left today, so it wakes, and is reopened, for p0 work only, and `budget.overAction`
 * holds its new helpers back as it says. Without a cut a session past its part uses the room the others left (src/budget/warn.ts
 * `isHeld`). A cut leaves a lift in force: the session works up to its lifted part, then is held. It ends at its
 * `--until`, the end of the budget day, or a lift of the session given after it, whichever comes first; a newer cut
 * replaces an older one.
 */
/** The format of the cut log's records; any other is skipped on read, and a newer one refuses a write. */
export const CUT_FORMAT = 1;
/** Whether the cut may be given, and when it ends: at `--until`, or the end of the budget day when that comes first. */
export function decideCut(request, zone) {
    const { now, until } = request;
    if (until !== undefined && until <= now) {
        return { kind: 'refused', reason: `--until ${zone.minute(new Date(until))} has passed` };
    }
    const dayEnd = now - (now % MS_PER_DAY) + MS_PER_DAY;
    return { kind: 'cut', cut: { session: request.session, endsAt: Math.min(until ?? dayEnd, dayEnd), reason: request.reason, by: request.by, at: now } };
}
/**
 * The cut of `session` in force at `now`: the newest one given by now, not yet ended by its time nor by a lift of
 * the session given after it (a group's lift is not one).
 */
export function activeCut(cuts, lifts, session, now) {
    const newest = cuts.filter((cut) => cut.session === session && cut.at <= now).at(-1);
    if (newest === undefined || now >= newest.endsAt) {
        return undefined;
    }
    const lifted = lifts.some((lift) => lift.session === session && !lift.group && lift.at > newest.at && lift.at <= now);
    return lifted ? undefined : newest;
}
/**
 * What a cut does, after "cut", on the team's clock: `alpha to its own daily budget until 18:00 IDT: past it, it is
 * held whatever room the team has, ...`.
 */
export function cutText(cut, name, zone) {
    return (`${name} to its own daily budget until ${formatEndTime(cut.endsAt, zone)}: past it, it is held whatever room the team has, ` +
        'so it wakes for p0 work only and budget.overAction holds its new helpers back as it says; a lift in force still sets that budget, and a new lift of it ends the cut.');
}
/**
 * Why a cut session past its budget is held, for its budget lines, with `by` the leader that gave the cut as the lines
 * name it: `the lead cut it to its own daily budget until 18:00 IDT`, `its leader app-bravo cut it ...`.
 */
export function cutClause(cut, by, zone) {
    return `${by} cut it to its own daily budget until ${formatEndTime(cut.endsAt, zone)}`;
}
function cutRecord(cut) {
    return {
        [VERSION_FIELD]: CUT_FORMAT,
        session: cut.session,
        endsAt: new Date(cut.endsAt).toISOString(),
        reason: cut.reason,
        by: cut.by,
        at: new Date(cut.at).toISOString(),
    };
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One record as a cut; undefined when it is damaged. */
export function parseCut(record) {
    const session = stringField(record, 'session');
    const reason = stringField(record, 'reason');
    const by = stringField(record, 'by');
    const endsAt = instantOf(record, 'endsAt');
    const at = instantOf(record, 'at');
    if (session === undefined || reason === undefined || by === undefined || endsAt === undefined || at === undefined) {
        return undefined;
    }
    return { session, endsAt, reason, by, at };
}
/** The team's append-only log of cuts, `<state>/usage/cuts.jsonl`, oldest first. */
export class CutLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const cuts = [];
        for (const { record, version } of parse.records) {
            const cut = version === CUT_FORMAT ? parseCut(record) : undefined;
            if (cut !== undefined) {
                cuts.push(cut);
            }
        }
        return { cuts, skipped: parse.unreadable + parse.records.length - cuts.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(cut) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), CUT_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(cutRecord(cut))}`);
    }
}
