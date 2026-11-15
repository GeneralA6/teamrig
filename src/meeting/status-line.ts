import type { MeetingConfig } from '../config/types.ts';
import { phaseOf, type Meeting } from './state.ts';

/**
 * How a tab's status line marks an open meeting (T2513): the meeting tab, the one whose session started it, leads its
 * line with `Meeting: <title>` in the meeting colour; every other tab its meeting covers ends its line in the held
 * text, in the same colour. Only the mark takes the colour, so the rest of the line reads as usual (T2985).
 */
export type StatusLineMeeting =
  | { readonly kind: 'tab'; readonly colour: string; readonly title: string }
  | { readonly kind: 'held'; readonly colour: string; readonly text: string };

/** The short title of the owner's daily meeting, the one a team's `meeting start` opens. */
export const DAILY_MEETING_TITLE = 'daily';

export interface StatusLineMeetingInput {
  readonly shown: MeetingConfig['statusLine'];
  /** The latest meeting of the tab's own team. */
  readonly own: Meeting | undefined;
  /** The latest meetings of the teams above the tab's: each covers the tab's team too (T2985). */
  readonly above: readonly (Meeting | undefined)[];
  readonly now: number;
  /** The tab's session on its own team; undefined in a tab no session of the team holds. */
  readonly tab: string | undefined;
}

/**
 * The tab's meeting mark: the meeting tab's when its session started its team's open meeting, else the held text
 * while its team or a team above has one open; undefined with the marks off or none open, ended or lapsed alike.
 */
export function statusLineMeetingOf(input: StatusLineMeetingInput): StatusLineMeeting | undefined {
  const { shown, own, above, now, tab } = input;
  const open = (meeting: Meeting | undefined): boolean => meeting !== undefined && phaseOf(meeting, now).kind === 'open';
  if (!shown.enabled || (!open(own) && !above.some(open))) {
    return undefined;
  }
  return open(own) && own?.by === tab
    ? { kind: 'tab', colour: shown.colour, title: DAILY_MEETING_TITLE }
    : { kind: 'held', colour: shown.colour, text: shown.heldText };
}

/** The meeting tab's mark as its status line leads with it, uncoloured: `Meeting: daily`. */
export function meetingLabel(title: string): string {
  return `Meeting: ${title}`;
}

/** `text` in the 24-bit foreground `colour` (`#rrggbb`, as the config takes it), reset after it so nothing else takes the colour. */
export function coloured(text: string, colour: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
