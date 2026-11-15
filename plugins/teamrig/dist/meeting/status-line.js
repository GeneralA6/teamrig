import { phaseOf } from "./state.js";
/** The short title of the owner's daily meeting, the one a team's `meeting start` opens. */
export const DAILY_MEETING_TITLE = 'daily';
/**
 * The tab's meeting mark: the meeting tab's when its session started its team's open meeting, else the held text
 * while its team or a team above has one open; undefined with the marks off or none open, ended or lapsed alike.
 */
export function statusLineMeetingOf(input) {
    const { shown, own, above, now, tab } = input;
    const open = (meeting) => meeting !== undefined && phaseOf(meeting, now).kind === 'open';
    if (!shown.enabled || (!open(own) && !above.some(open))) {
        return undefined;
    }
    return open(own) && own?.by === tab
        ? { kind: 'tab', colour: shown.colour, title: DAILY_MEETING_TITLE }
        : { kind: 'held', colour: shown.colour, text: shown.heldText };
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
