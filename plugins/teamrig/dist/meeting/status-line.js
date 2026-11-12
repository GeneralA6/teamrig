import { phaseOf } from "./state.js";
/** The tab's meeting mark; undefined with the marks off or no meeting open, ended or lapsed alike. */
export function statusLineMeetingOf(input) {
    const { shown, meeting, now, tab } = input;
    if (!shown.enabled || meeting === undefined || phaseOf(meeting, now).kind !== 'open') {
        return undefined;
    }
    return tab === meeting.by ? { kind: 'tab', colour: shown.colour } : { kind: 'held', text: shown.heldText };
}
/** `text` in the 24-bit foreground `colour` (`#rrggbb`, as the config takes it), reset after it so nothing else takes the colour. */
export function coloured(text, colour) {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
