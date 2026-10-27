/**
 * The pieces the animated terminal pictures (task-flow.ts, lead-morning.ts, lead-meeting.ts) tell their story with: a
 * status a tab or a pane row goes through over the loop, and a line of talk as a session's tab shows it.
 */
import { bullet, type Status, text } from './terminal-view.ts';
import type { Timeline } from './timeline.ts';

/** A status a tab or a task row takes from `at` seconds into the loop. */
export interface Change {
  readonly status: Status;
  readonly at: number;
}

/** A status held the whole loop, or the changes it goes through, the first when it appears. */
export type Track = Status | readonly [Change, ...Change[]];

/** A session's tab and its status over the loop. */
export interface TabStory {
  readonly name: string;
  readonly track: Track;
}

/** How a line of talk looks: your ask after the prompt mark, a line the session says, its tool's output, or a command it runs. */
export type Look = 'ask' | 'said' | 'output' | 'command';

/** A line of talk: its baseline, when it appears, its words and its look. */
export interface Line {
  readonly y: number;
  readonly from: number;
  readonly words: string;
  readonly look: Look;
}

/** A track's marks: one still mark for a held status, else one per change, each shown until the next or until `end`. */
export function trackMarks(t: Timeline, track: Track, end: number, draw: (status: Status) => string): string[] {
  if (typeof track === 'string') return [draw(track)];
  return track.map((change, i) => `<g class="${t.show(change.at, { to: track[i + 1]?.at ?? end, motion: 'fade' })}">${draw(change.status)}</g>`);
}

/** A line of talk as its look draws it. */
export function lineParts(line: Line): string[] {
  switch (line.look) {
    case 'ask':
      return [text(24, line.y, '>', 'mono accent'), text(42, line.y, line.words, 'mono')];
    case 'said':
      return [bullet(line.y), text(42, line.y, line.words, 'mono')];
    case 'output':
      return [text(42, line.y, line.words, 'mono muted')];
    case 'command':
      return [bullet(line.y), text(42, line.y, line.words, 'mono accent')];
  }
}
