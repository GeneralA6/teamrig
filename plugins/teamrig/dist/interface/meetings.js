import { ServedText } from "./text.js";
/**
 * The `meetings` document's body. Every text a person typed, or that a hand-edited file may hold, is looked at for a
 * secret's shape, each element of a list by itself, so one cut never takes its neighbours with it.
 */
export function meetingsBody(input) {
    const served = new ServedText(input.shapes);
    const meetings = input.rows.map((row) => ({
        id: row.id,
        at: row.at,
        atText: row.atText,
        minutes: row.minutes,
        session: served.plain(row.id, 'session', row.session),
        with: row.with.map((session) => served.plain(row.id, 'with', session)),
        tasks: row.tasks.map((task) => served.plain(row.id, 'tasks', task)),
        about: served.plain(row.id, 'about', row.about),
        brief: served.plainOrNull(row.id, 'brief', row.brief),
        status: row.status,
        missed: row.missed,
    }));
    return { meetings, cuts: served.cuts };
}
