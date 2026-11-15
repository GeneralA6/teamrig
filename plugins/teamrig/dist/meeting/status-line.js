import { meetingInTabOf, meetingTitleOf } from "./schedule.js";
import { phaseOf } from "./state.js";
/** The short title of the owner's daily meeting, the one a team's `meeting start` opens. */
export const DAILY_MEETING_TITLE = 'daily';
/**
 * The tab's meeting mark: the meeting tab's when its session started its team's open daily meeting (titled daily), or
 * is met in a booked or on-the-spot meeting on now (titled by what it is about); else the held text while its team or
 * a team above has its daily meeting open; undefined with the marks off or none on, ended or lapsed alike.
 */
export function statusLineMeetingOf(input) {
    const { shown, own, above, booked, now, tab } = input;
    if (!shown.enabled) {
        return undefined;
    }
    const open = (meeting) => meeting !== undefined && phaseOf(meeting, now).kind === 'open';
    if (open(own) && own?.by === tab) {
        return { kind: 'tab', colour: shown.colour, title: DAILY_MEETING_TITLE };
    }
    const inTab = tab === undefined ? undefined : meetingInTabOf(booked, tab, now);
    if (inTab !== undefined) {
        return { kind: 'tab', colour: shown.colour, title: meetingTitleOf(inTab) };
    }
    return open(own) || above.some(open) ? { kind: 'held', colour: shown.colour, text: shown.heldText } : undefined;
}
/** The meeting tab's mark as its status line leads with it, uncoloured: `Meeting: daily`. */
export function meetingLabel(title) {
    return `Meeting: ${title}`;
}
/** `text` in the 24-bit foreground `colour` (`#rrggbb`, as the config takes it), reset after it so nothing else takes the colour. */
export function coloured(text, colour) {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
