/**
 * The README's lead-morning picture: the lead runs the team's morning in its own tab and says what it does in one plain
 * sentence a step, each tool run folded into one "Ran N shell commands" line, as Claude Code shows it. It answers
 * data's operational question itself and sends data the answer, fills the week's plan, and closes two idle sessions
 * when the host runs short of memory; web's product question waits for your meeting. It is the terminal view's window
 * (terminal-view.ts) with the conversation across it and no pane, in the reader's light or dark colour scheme: one
 * 28 s CSS loop and no script, so GitHub shows it in an <img>. With motion turned off it is a still of the whole
 * morning, with docs' and tests' tabs closed.
 */
import { lineParts, trackMarks, type Line, type TabStory } from './story.ts';
import { renderSvg } from './svg.ts';
import { mark, statusKey, tabOutline, tabX, text, VIEW_HEIGHT, WIDTH, WINDOW_STYLE, windowFrame } from './terminal-view.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

/** 28 s a loop; the parts hide at 27 s; the still shows 24.5 s, when the whole morning is told. */
export const LEAD_MORNING_CLOCK: Clock = { loop: 28, end: 27, rest: 24.5 };

/** The story's moments, in seconds into the loop. data goes back to work once it has the lead's answer. */
export const DATA_ANSWERED = 5.0;
/** The lead closes docs, then tests, to free the host's memory. */
export const DOCS_CLOSED = 17.2;
export const TESTS_CLOSED = 17.6;

/** A session's tab, its status over the loop and, for a session the lead closes, when its tab goes. */
export interface MorningTab extends TabStory {
  readonly closed?: number;
}

/** The tabs, left to right; the lead's is in view. web's product question needs you all morning. */
export const TABS: readonly MorningTab[] = [
  { name: 'lead', track: 'working' },
  { name: 'api', track: 'working' },
  { name: 'web', track: 'needs-you' },
  { name: 'data', track: [{ status: 'needs-you', at: 0.2 }, { status: 'working', at: DATA_ANSWERED }] },
  { name: 'docs', track: 'done', closed: DOCS_CLOSED },
  { name: 'tests', track: 'done', closed: TESTS_CLOSED },
];

/** The week's plan before and after the lead fills it: its tasks, the tasks due this week outside it, and the open flags. */
export const PLAN = { before: 7, missing: 41, after: 48, flagsBefore: 63, flagsAfter: 12 } as const;
/** The host's free memory before and after the lead closes the idle sessions. */
export const FREE = { before: '1.8 GB', after: '3.9 GB' } as const;

/** The lead's talk: one plain sentence a step, each tool run folded into one line. */
export const TALK: readonly Line[] = [
  { y: 86, from: 0.6, words: "Morning. data asks whether to rerun last night's failed import now: operational, so my call.", look: 'said' },
  { y: 110, from: 3.4, words: 'Ran 3 shell commands', look: 'output' },
  { y: 134, from: 4.4, words: '"Rerun it now, before the 10:00 report." → sent to data', look: 'output' },
  { y: 170, from: 7.0, words: `Next, the week's plan: it holds only ${PLAN.before} tasks, and ${PLAN.missing} due this week aren't in it.`, look: 'said' },
  { y: 194, from: 9.6, words: 'Ran 7 shell commands', look: 'output' },
  {
    y: 230,
    from: 10.8,
    words: `The plan now holds ${PLAN.after} tasks (was ${PLAN.before}) and fits the week's tokens. Flags fell from ${PLAN.flagsBefore} to ${PLAN.flagsAfter}.`,
    look: 'said',
  },
  { y: 266, from: 14.4, words: `Host memory is low: ${FREE.before} free. docs and tests are idle with nothing to start, so I'll close them.`, look: 'said' },
  { y: 290, from: 16.8, words: 'Ran 2 shell commands', look: 'output' },
  { y: 326, from: 18.4, words: `${FREE.after} free now, and teamrig open resumes either one where it left off.`, look: 'said' },
  { y: 362, from: 21.4, words: "That's the morning. web's question is a product call, so it waits for your 09:30 meeting.", look: 'said' },
];

const LABEL =
  "A lead's morning in its own tab, one plain sentence a step, each tool run folded into one line. data asks whether to " +
  "rerun last night's failed import now; that is operational, so the lead decides it, sends data the answer, and data " +
  `goes back to work. The week's plan holds only ${PLAN.before} tasks; the lead fills it to ${PLAN.after}, fitted to the ` +
  `week's tokens, and the flags fall from ${PLAN.flagsBefore} to ${PLAN.flagsAfter}. Host memory is low, ${FREE.before} ` +
  `free, so it closes docs and tests, idle with nothing to start: ${FREE.after} free, and teamrig open resumes either ` +
  "one. web's question is a product call, so it waits for your morning meeting.";

/** The tab strip: the lead's tab in view, each tab's mark and name, and the tabs the lead closes fading out. */
function tabs(t: Timeline): string[] {
  const tab = (story: MorningTab, index: number): string[] => {
    const x = tabX(index);
    const parts = [
      ...trackMarks(t, story.track, LEAD_MORNING_CLOCK.end, (status) => mark(status, x + 18, 27.5)),
      text(x + 31, 32, story.name, index === 0 ? 'mono strong' : 'mono muted'),
    ];
    return story.closed === undefined ? parts : [`<g class="${t.show(0.2, { to: story.closed, motion: 'fade' })}">`, ...parts, '</g>'];
  };
  return [tabOutline(tabX(0)), ...TABS.flatMap(tab)];
}

/** The lead's talk, each line rising in at its moment. */
function conversation(t: Timeline): string[] {
  return TALK.flatMap((line) => [`<g class="${t.show(line.from)}">`, ...lineParts(line), '</g>']);
}

/** The picture as an SVG file. */
export function renderLeadMorning(): string {
  const t = new Timeline(LEAD_MORNING_CLOCK);
  const body = [...windowFrame({ pane: false }), ...tabs(t), ...conversation(t), ...statusKey()];
  return renderSvg({
    width: WIDTH,
    height: VIEW_HEIGHT,
    label: LABEL,
    style: [...themeStyle(), ...WINDOW_STYLE, t.css(), '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'],
    body,
  });
}
