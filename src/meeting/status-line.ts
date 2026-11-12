import type { MeetingConfig } from '../config/types.ts';
import { phaseOf, type Meeting } from './state.ts';

/**
 * How a tab's status line marks an open meeting (T2513): the meeting tab, the root lead's that started it, prints its
 * whole line in the meeting colour; every other tab adds the held text, so a glance at any tab says the team waits.
 */
export type StatusLineMeeting = { readonly kind: 'tab'; readonly colour: string } | { readonly kind: 'held'; readonly text: string };

export interface StatusLineMeetingInput {
  readonly shown: MeetingConfig['statusLine'];
  /** The root team's latest meeting: the owner meets only the root team's lead. */
  readonly meeting: Meeting | undefined;
  readonly now: number;
  /** The tab's session on the root team; undefined in a sub-team's tab or a tab no session of the root team holds. */
  readonly tab: string | undefined;
}

/** The tab's meeting mark; undefined with the marks off or no meeting open, ended or lapsed alike. */
export function statusLineMeetingOf(input: StatusLineMeetingInput): StatusLineMeeting | undefined {
  const { shown, meeting, now, tab } = input;
  if (!shown.enabled || meeting === undefined || phaseOf(meeting, now).kind !== 'open') {
    return undefined;
  }
  return tab === meeting.by ? { kind: 'tab', colour: shown.colour } : { kind: 'held', text: shown.heldText };
}

/** `text` in the 24-bit foreground `colour` (`#rrggbb`, as the config takes it), reset after it so nothing else takes the colour. */
export function coloured(text: string, colour: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}
