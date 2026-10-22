/**
 * The README's task-flow picture: one task's trip, as you see it in the terminal you already have. In the lead's tab
 * you ask for a password reset; the lead adds T17 for api and it appears in teamrig-pane's list. The view moves to
 * api's tab, where api starts T17, tests it and lands it with `teamrig integrate`, waiting in line while web holds the
 * lock. web's task and then T17 turn done in the pane. It is the terminal view's window (terminal-view.ts), in the
 * reader's light or dark colour scheme: one 18 s CSS loop and no script, so GitHub shows it in an <img>. With motion
 * turned off it is a still of api's tab with T17 done.
 */
import { escapeXml, renderSvg } from './svg.ts';
import {
  bullet,
  DIVIDER_X,
  mark,
  paneHeading,
  PANE_LEFT,
  ROW_STEP,
  ROW_TOP,
  type Status,
  statusKey,
  tabOutline,
  tabX,
  text,
  VIEW_HEIGHT,
  WIDTH,
  WINDOW_HEIGHT,
  WINDOW_STYLE,
  windowFrame,
} from './terminal-view.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock, type TypingSegment } from './timeline.ts';

/** 18 s a loop; the parts hide at 16.8 s; the still shows 15.6 s, when web's task and T17 are done. */
export const TASK_FLOW_CLOCK: Clock = { loop: 18, end: 16.8, rest: 15.6 };

/** The monospace advance at the terminal's 13.5px, which the typed text is forced to with textLength. */
export const CHAR_WIDTH = 8.1;

/** The story's moments, in seconds into the loop. The pane's rows below T17 move down to make room for it. */
export const ROWS_MOVE = 3.6;
/** T17 appears in the pane. */
export const ADDED = 4.0;
/** The tab outline starts its move to api's tab. */
export const OUTLINE_MOVE = 5.6;
/** api's tab is in view: the lead's talk is gone and the tab names swap weight. */
export const SWITCHED = 5.7;
/** api starts T17. */
export const API_STARTS = 6.3;
/** web's task is done, which frees the lock api waits for. */
export const WEB_DONE = 11.0;
/** T17 is done. */
export const API_DONE = 13.0;
/** The outline and the rows move back, ready for the next loop. */
export const BACK = 16.9;

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

/** A row of the pane: a task, its owner, its priority, when it is due while open, and its status over the loop. */
export interface Row {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly priority: string;
  readonly due: string;
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

/** What you type into the input box, when, how fast, and when it is sent. */
export interface Typing {
  readonly text: string;
  readonly from: number;
  readonly perChar: number;
  readonly sent: number;
}

/** The tabs, left to right; the lead's is in view first, then api's. */
export const TABS: readonly TabStory[] = [
  { name: 'lead', track: 'working' },
  { name: 'api', track: [{ status: 'not-started', at: 0.2 }, { status: 'working', at: API_STARTS }, { status: 'done', at: API_DONE }] },
  { name: 'web', track: [{ status: 'working', at: 0.2 }, { status: 'done', at: WEB_DONE }] },
  { name: 'tests', track: 'working' },
  { name: 'docs', track: 'not-started' },
];
/** The tabs in view, by their place in TABS: the lead's, then api's. */
const LEAD_TAB = 0;
const API_TAB = 1;
/** When each tab in view is in view, by its place in TABS. */
const IN_VIEW: ReadonlyMap<number, { readonly from: number; readonly to: number }> = new Map([
  [LEAD_TAB, { from: 0.2, to: SWITCHED }],
  [API_TAB, { from: SWITCHED, to: TASK_FLOW_CLOCK.end }],
]);

export const ASK = 'Users need a password reset.';
export const ASK_TYPING: Typing = { text: ASK, from: 0.7, perChar: 0.06, sent: 2.7 };

/** The pane's rows above the new task, the new task, and the rows below it, in plan order. */
export const ROWS_ABOVE: readonly Row[] = [
  { id: 'T12', title: 'Signup form', owner: 'web', priority: 'p1', due: 'due today', track: [{ status: 'working', at: 0.2 }, { status: 'done', at: WEB_DONE }] },
];
export const NEW_ROW: Row = {
  id: 'T17',
  title: 'Password reset',
  owner: 'api',
  priority: 'p1',
  due: 'due today',
  track: [{ status: 'not-started', at: ADDED }, { status: 'working', at: API_STARTS }, { status: 'done', at: API_DONE }],
};
export const ROWS_BELOW: readonly Row[] = [
  { id: 'T16', title: 'End-to-end tests', owner: 'tests', priority: 'p2', due: 'due Fri', track: 'working' },
  { id: 'T15', title: 'API docs', owner: 'docs', priority: 'p2', due: 'due Fri', track: 'not-started' },
  { id: 'T11', title: 'Release notes', owner: 'docs', priority: 'p3', due: 'done', track: 'done' },
];

/** The lead's talk, gone when api's tab comes into view. A p1 task handed to an idle session wakes it (wake.priority). */
export const LEAD_TALK: readonly Line[] = [
  { y: 86, from: ASK_TYPING.sent, words: ASK, look: 'ask' },
  { y: 122, from: 3.2, words: `Added ${NEW_ROW.id} ${NEW_ROW.title}: ${NEW_ROW.owner}, ${NEW_ROW.priority}, ${NEW_ROW.due}.`, look: 'said' },
  { y: 158, from: 4.6, words: `${NEW_ROW.owner} is idle, so the task wakes it.`, look: 'said' },
];

/** api's talk: it starts T17, tests it, and lands it with integrate, which waits in line for the lock. */
export const API_TALK: readonly Line[] = [
  { y: 86, from: 6.2, words: `Starting ${NEW_ROW.id} ${NEW_ROW.title} (${NEW_ROW.priority}, from lead).`, look: 'said' },
  { y: 110, from: 7.2, words: 'Edited 3 files, ran 6 shell commands', look: 'output' },
  { y: 146, from: 8.4, words: 'Tests pass: 58 of 58. Landing it on main.', look: 'said' },
  { y: 182, from: 9.2, words: 'teamrig integrate', look: 'command' },
  { y: 206, from: 9.6, words: 'Waiting in line: web holds the lock.', look: 'output' },
  { y: 230, from: 11.4, words: 'Lock taken: rebased on main, pushed.', look: 'output' },
  { y: 266, from: 12.6, words: `${NEW_ROW.id} done. Proof: a reset email arrives.`, look: 'said' },
];

const LABEL =
  `One task's trip in your terminal. In the lead's tab you type: ${ASK} The lead adds ${NEW_ROW.id} ${NEW_ROW.title} for ` +
  `${NEW_ROW.owner}, ${NEW_ROW.priority}, ${NEW_ROW.due}, and it appears in teamrig-pane's list. In api's tab, api starts it, ` +
  'edits and tests, then lands it with teamrig integrate: it waits in line while web holds the lock, then rebases on main ' +
  `and pushes. web's task and then ${NEW_ROW.id} turn done in the pane.`;

/** A track's marks: one still mark for a held status, else one per change, each shown until the next. */
function marks(t: Timeline, track: Track, draw: (status: Status) => string): string[] {
  if (typeof track === 'string') return [draw(track)];
  return track.map((change, i) => `<g class="${t.show(change.at, { to: track[i + 1]?.at ?? TASK_FLOW_CLOCK.end, motion: 'fade' })}">${draw(change.status)}</g>`);
}

/** The tab strip: the outline moving from the lead's tab to api's, each tab's mark, and its name, bold while in view. */
function tabs(t: Timeline): string[] {
  const outline = t.steps('translateX(0)', [
    { at: OUTLINE_MOVE, duration: 0.35, value: `translateX(${tabX(API_TAB) - tabX(LEAD_TAB)}px)` },
    { at: BACK, duration: 0.35, value: 'translateX(0)' },
  ]);
  const tab = (story: TabStory, index: number): string[] => {
    const x = tabX(index);
    const view = IN_VIEW.get(index);
    const strong = view === undefined ? [] : [`<g class="${t.show(view.from, { to: view.to, motion: 'fade' })}">${text(x + 31, 32, story.name, 'mono strong')}</g>`];
    return [...marks(t, story.track, (status) => mark(status, x + 18, 27.5)), text(x + 31, 32, story.name, 'mono muted'), ...strong];
  };
  return [`<g class="${outline}">${tabOutline(tabX(LEAD_TAB))}</g>`, ...TABS.flatMap(tab)];
}

/** A line of talk as its look draws it. */
function lineParts(line: Line): string[] {
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

/** The talk: the lead's lines until api's tab is in view, then api's. */
function conversation(t: Timeline): string[] {
  const shown = (line: Line, to: number): string[] => [`<g class="${t.show(line.from, { to })}">`, ...lineParts(line), '</g>'];
  return [...LEAD_TALK.flatMap((line) => shown(line, SWITCHED)), ...API_TALK.flatMap((line) => shown(line, TASK_FLOW_CLOCK.end))];
}

/** The input box, where you type the ask: a cover slides right one character at a time to reveal it, the caret with it. */
function inputBox(t: Timeline): string[] {
  const promptY = WINDOW_HEIGHT - 43.5;
  const chars = ASK_TYPING.text.length;
  const span = chars * CHAR_WIDTH;
  const typing = t.slide([{ from: ASK_TYPING.from, duration: chars * ASK_TYPING.perChar, chars, reset: ASK_TYPING.sent } satisfies TypingSegment], CHAR_WIDTH);
  return [
    `<rect x="16.5" y="${WINDOW_HEIGHT - 70.5}" width="${DIVIDER_X - 32}" height="44" rx="8" class="box"/>`,
    text(32, promptY, '>', 'mono accent'),
    `<g class="${t.show(ASK_TYPING.from - 0.05, { to: ASK_TYPING.sent, motion: 'fade' })}">`,
    `<text x="50" y="${promptY}" class="mono" textLength="${span.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(ASK_TYPING.text)}</text>`,
    `<rect x="49" y="${promptY - 15.5}" width="${(span + 10).toFixed(1)}" height="21" class="${typing} cover"/>`,
    '</g>',
    `<g class="${typing}"><rect x="51" y="${promptY - 11.5}" width="7.5" height="15" class="caret blink"/></g>`,
  ];
}

/** A pane row whose first line's baseline is at y: its marks, its id, and its title and owner line, muted once done. */
function row(t: Timeline, entry: Row, y: number): string[] {
  const words = (status: Status): string[] => [
    text(PANE_LEFT + 64, y, entry.title, status === 'done' ? 'mono muted' : 'mono'),
    text(PANE_LEFT + 64, y + 19, `${entry.owner} · ${entry.priority} · ${status === 'done' ? 'done' : entry.due}`, 'mono muted'),
  ];
  const out = [...marks(t, entry.track, (status) => mark(status, PANE_LEFT + 6, y - 4.5)), text(PANE_LEFT + 20, y, entry.id, 'mono muted')];
  if (typeof entry.track === 'string') return [...out, ...words(entry.track)];
  const [first] = entry.track;
  const done = entry.track.find((change) => change.status === 'done');
  out.push(`<g class="${t.show(first.at, { to: done?.at ?? TASK_FLOW_CLOCK.end, motion: 'fade' })}">`, ...words(first.status), '</g>');
  if (done !== undefined) out.push(`<g class="${t.show(done.at, { motion: 'fade' })}">`, ...words('done'), '</g>');
  return out;
}

/** teamrig-pane: its heading, the rows above the new task, the new task rising in, and the rows below moving down for it. */
function pane(t: Timeline): string[] {
  const rowY = (index: number): number => ROW_TOP + index * ROW_STEP;
  const below = t.steps('translateY(0)', [
    { at: ROWS_MOVE, duration: 0.4, value: `translateY(${ROW_STEP}px)` },
    { at: BACK, duration: 0.4, value: 'translateY(0)' },
  ]);
  return [
    ...paneHeading(),
    ...ROWS_ABOVE.flatMap((entry, i) => row(t, entry, rowY(i))),
    `<g class="${t.show(ADDED)}">`,
    ...row(t, NEW_ROW, rowY(ROWS_ABOVE.length)),
    '</g>',
    `<g class="${below}">`,
    ...ROWS_BELOW.flatMap((entry, i) => row(t, entry, rowY(ROWS_ABOVE.length + i))),
    '</g>',
  ];
}

/** The picture as an SVG file. */
export function renderTaskFlow(): string {
  const t = new Timeline(TASK_FLOW_CLOCK);
  const body = [...windowFrame(), ...tabs(t), ...conversation(t), ...inputBox(t), ...pane(t), ...statusKey()];
  return renderSvg({
    width: WIDTH,
    height: VIEW_HEIGHT,
    label: LABEL,
    style: [
      ...themeStyle(),
      ...WINDOW_STYLE,
      '.cover{fill:var(--bg)}.caret{fill:var(--fg)}',
      '@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}.blink{animation:blink 1.1s steps(1,end) infinite}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body,
  });
}
