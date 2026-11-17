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
 *
 * A stop (`--stop`, T3455) cuts the session to nothing: it is held whatever its use, so from the day's start on it is
 * woken and reopened for p0 work only, which a plain cut cannot say, as a session with its day's part left is never
 * past it. A stop may last to the week's reset, so an order to stop a session until then outlives the budget day.
 */
/**
 * The format of the cut log's records: 2 added `stop`. Format 1 is still read, as a plain cut; any other is skipped
 * on read, and a newer one refuses a write.
 */
export const CUT_FORMAT = 2;
/** The format before `stop`: its cuts are plain ones. */
const PLAIN_CUT_FORMAT = 1;
/**
 * Whether the cut may be given, and when it ends: at `--until`, or at the latest the end of the budget day for a
 * plain cut, the week's reset for a stop (the day's end while the reset is not known).
 */
export function decideCut(request, zone) {
    const { now, until, stop, reset } = request;
    if (until !== undefined && until <= now) {
        return { kind: 'refused', reason: `--until ${zone.minute(new Date(until))} has passed` };
    }
    const dayEnd = now - (now % MS_PER_DAY) + MS_PER_DAY;
    const latest = stop && reset !== undefined && reset > now ? reset : dayEnd;
    return { kind: 'cut', cut: { session: request.session, endsAt: Math.min(until ?? latest, latest), stop, reason: request.reason, by: request.by, at: now } };
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
    if (cut.stop) {
        return (`${name} stopped until ${formatEndTime(cut.endsAt, zone)}: it is held whatever its use, so it wakes and is reopened for p0 work only ` +
            'and budget.overAction holds its new helpers back as it says; a new lift of it ends the stop.');
    }
    return (`${name} to its own daily budget until ${formatEndTime(cut.endsAt, zone)}: past it, it is held whatever room the team has, ` +
        'so it wakes for p0 work only and budget.overAction holds its new helpers back as it says; a lift in force still sets that budget, and a new lift of it ends the cut.');
}
/**
 * Why a cut session is held, for its budget lines, with `by` the leader that gave the cut as the lines name it: `the
 * lead cut it to its own daily budget until 18:00 IDT`, `its leader app-bravo stopped it until ...`.
 */
export function cutClause(cut, by, zone) {
    return cut.stop ? `${by} stopped it until ${formatEndTime(cut.endsAt, zone)}` : `${by} cut it to its own daily budget until ${formatEndTime(cut.endsAt, zone)}`;
}
function cutRecord(cut) {
    return {
        [VERSION_FIELD]: CUT_FORMAT,
        session: cut.session,
        endsAt: new Date(cut.endsAt).toISOString(),
        stop: cut.stop,
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
/** A format 2 record's `stop`; a format 1 record is a plain cut. Undefined when it is damaged. */
function stopOf(record, version) {
    if (version === PLAIN_CUT_FORMAT) {
        return false;
    }
    const stop = record['stop'];
    return typeof stop === 'boolean' ? stop : undefined;
}
/** One record of format `version` (1 or 2) as a cut; undefined when it is damaged. */
export function parseCut(record, version) {
    const session = stringField(record, 'session');
    const reason = stringField(record, 'reason');
    const by = stringField(record, 'by');
    const endsAt = instantOf(record, 'endsAt');
    const at = instantOf(record, 'at');
    const stop = stopOf(record, version);
    if (session === undefined || reason === undefined || by === undefined || endsAt === undefined || at === undefined || stop === undefined) {
        return undefined;
    }
    return { session, endsAt, stop, reason, by, at };
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
            const cut = version === CUT_FORMAT || version === PLAIN_CUT_FORMAT ? parseCut(record, version) : undefined;
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
