/**
 * The README's reboot picture: after a reboot, the tab teamrig opens at logon (`Restore Claude sessions`) lists the
 * Claude Code sessions the shutdown killed, counts down, and reopens each in its own tab, the ones that had work going
 * prompted to carry on; then it closes by itself and the lead's tab comes into view, its first prompt saying how its
 * team came back. The restore's lines are built by the CLI's own code (src/restore), so the picture says what the
 * command prints. It is the terminal view's window (terminal-view.ts) with no pane, in the reader's light or dark
 * colour scheme: one 28 s CSS loop and no script, so GitHub shows it in an <img>. With motion turned off it is a still
 * of the restore's whole list with every tab back.
 */
import { countdownLine } from '../../src/restore/countdown.ts';
import { continuePrompt, describeLostWork, summarizeRestore, type RestoreMode } from '../../src/restore/plan.ts';
import { COUNTDOWN_SECONDS } from '../../src/restore/run.ts';
import { lineParts, type Line } from './story.ts';
import { renderSvg } from './svg.ts';
import { mark, statusKey, TAB_GAP, TAB_WIDTH, tabOutline, tabX, text, type Status, VIEW_HEIGHT, WIDTH, WINDOW_STYLE, windowFrame } from './terminal-view.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

/** 28 s a loop; the parts hide at 27 s; the still shows 13.6 s, the restore's whole list with every tab back. */
export const REBOOT_CLOCK: Clock = { loop: 28, end: 27, rest: 13.6 };

/** The restore's tab closes by itself once every session is open; the tabs after it slide left into its place. */
export const RESTORE_CLOSED = 14.6;
const SLIDE = 0.4;
/** The lead's tab is in view once the slide is over. */
export const LEAD_IN_VIEW = RESTORE_CLOSED + SLIDE + 0.1;

/** Why the restore lists a session: no end was ever recorded, or it ended inside the shutdown. */
export type RestoreReason = 'killed without exiting' | 'closed by the shutdown';

/** A session the shutdown killed: its tab, how the restore lists it, when it reopens and its mark once open. */
export interface Reopened {
  /** Its tab's name. */
  readonly name: string;
  /** Its name in the restore's lines: the team session's name. */
  readonly label: string;
  readonly reason: RestoreReason;
  readonly mode: RestoreMode;
  /** Why it continues, or `nothing live` when it reopens idle. */
  readonly why: string;
  readonly folder: string;
  /** When its `Opened` line prints and its tab opens. */
  readonly opened: number;
  readonly status: Status;
}

/** The sessions, in the order they were first opened, which is the order they reopen. web had nothing going, so it reopens idle. */
export const SESSIONS: readonly Reopened[] = [
  { name: 'lead', label: 'shop-lead', reason: 'killed without exiting', mode: 'continue', why: 'lead', folder: 'D:\\code\\shop', opened: 7.0, status: 'working' },
  { name: 'api', label: 'shop-api', reason: 'killed without exiting', mode: 'continue', why: 'mid-turn', folder: 'D:\\code\\shop-api', opened: 8.6, status: 'working' },
  { name: 'web', label: 'shop-web', reason: 'closed by the shutdown', mode: 'idle', why: 'nothing live', folder: 'D:\\code\\shop-web', opened: 10.2, status: 'done' },
  {
    name: 'data',
    label: 'shop-data',
    reason: 'closed by the shutdown',
    mode: 'continue',
    why: describeLostWork({ background: 0, crons: 1, wake: false }) ?? '',
    folder: 'D:\\code\\shop-data',
    opened: 11.8,
    status: 'working',
  },
];

/** How the restore names a session's mode, as `restore run` prints it. */
export const modeWords = (session: Pick<Reopened, 'mode' | 'why'>): string => (session.mode === 'continue' ? `continue: ${session.why}` : 'idle');

/** A line the restore prints: its baseline, when it shows, its words, and how it looks: a plain line, a listed session or the muted note. */
export interface Printed {
  readonly y: number;
  readonly from: number;
  readonly words: string;
  readonly look: 'plain' | 'item' | 'note';
}

/** The note `restore run` prints under its list, split where it fits the window. */
export const CONTINUE_NOTE = [
  'Sessions marked "continue" resume with a message to re-check the state and carry on',
  '(mid-turn, an API error, work live at the shutdown, or the lead); the others reopen idle, with no prompt.',
] as const;

/** One space for each run of spaces: a browser draws a run as one space anyway. */
const singleSpaced = (words: string): string => words.trim().replace(/ {2,}/g, ' ');

/** The reboot the picture shows left no tab closed outside a shutdown, so its countdown offers no `[a]`. */
const CLOSED_TABS = 0;

/** The countdown as it starts, before anyone presses a key. */
export const COUNTDOWN = singleSpaced(countdownLine(COUNTDOWN_SECONDS, CLOSED_TABS).replace('\r', ''));

/** What the restore's tab prints, in time order: its list, its note, its countdown, then each tab it opens. */
export const PRINTED: readonly Printed[] = [
  { y: 86, from: 0.8, words: `Claude Code sessions the last shutdown interrupted (${SESSIONS.length}):`, look: 'plain' },
  ...SESSIONS.map((session, i): Printed => ({
    y: 110 + i * 22,
    from: 1.6 + i * 0.15,
    words: `${session.label} [${session.reason}; ${modeWords(session)}] ${session.folder}`,
    look: 'item',
  })),
  ...CONTINUE_NOTE.map((words, i): Printed => ({ y: 206 + i * 22, from: 3.2 + i * 0.1, words, look: 'note' })),
  { y: 258, from: 5.0, words: COUNTDOWN, look: 'plain' },
  ...SESSIONS.map((session, i): Printed => ({ y: 288 + i * 22, from: session.opened, words: `Opened ${session.label} (${modeWords(session)})`, look: 'plain' })),
];

/** The lead's first prompt, the one the restore resumed it with: how every other session of its team came back. */
export const LEAD_PROMPT = continuePrompt(
  { background: 0, crons: 0, wake: false },
  summarizeRestore(SESSIONS.filter((session) => session.name !== 'lead').map(({ label, mode, why }) => ({ label, mode, why }))),
);
const OTHERS_AT = LEAD_PROMPT.indexOf('Other sessions restored: ');

/** The prompt as the lead's tab shows it: its first sentence, then, a line under it, how the others came back. */
export const PROMPT_SHOWN = [`${LEAD_PROMPT.slice(0, LEAD_PROMPT.indexOf('. ') + 1)} …`, LEAD_PROMPT.slice(OTHERS_AT)] as const;
/** When the prompt shows in the lead's tab, and the baseline of its two lines. */
export const PROMPT_FROM = LEAD_IN_VIEW + 0.7;
const PROMPT_Y = [86, 108] as const;

/** The lead's talk once its tab is in view: it re-checks the state, says how the team came back and carries on. */
export const TALK: readonly Line[] = [
  { y: 144, from: 17.6, words: 'Ran 4 shell commands', look: 'output' },
  { y: 180, from: 19.2, words: 'Back after the restart: api and data carry on where they stopped, and web reopened idle.', look: 'said' },
  { y: 216, from: 21.6, words: 'Tasks, notes and inboxes were on disk, so nothing was lost. On with the plan.', look: 'said' },
];

const LABEL =
  `After a reboot, a tab named Restore Claude sessions opens at logon and lists the ${SESSIONS.length} Claude Code sessions ` +
  'the shutdown killed, each with its folder: the lead, api mid-turn, web with nothing going and data with a cron job ' +
  'live. Those marked continue resume with a message to re-check the state and carry on; web reopens idle, with no ' +
  'prompt. After a countdown you can cut short or cancel, each one reopens in its own tab, and the restore tab closes ' +
  "by itself. In the lead's tab, its first prompt says how its team came back. The lead re-checks the state, says api " +
  'and data carry on and web reopened idle, and goes on with the plan: tasks, notes and inboxes were on disk, so ' +
  'nothing was lost.';

/** A printed line as the restore's tab draws it: plain from the left margin, a listed session indented, the note muted. */
function printedParts(line: Printed): string {
  if (line.look === 'item') return text(40, line.y, line.words, 'mono');
  return text(24, line.y, line.words, line.look === 'note' ? 'mono muted' : 'mono');
}

/**
 * The tab strip: the restore's tab in view until it closes; each session's tab opening with its mark as its `Opened`
 * line prints, all sliding one tab left when the restore's closes; then the lead's tab in view, its name bold.
 */
function tabs(t: Timeline): string[] {
  const restore = [`<g class="${t.show(0.2, { to: RESTORE_CLOSED, motion: 'fade' })}">`, tabOutline(tabX(0)), text(tabX(0) + 18, 32, 'restore', 'mono strong'), '</g>'];
  const leadOutline = [`<g class="${t.show(LEAD_IN_VIEW, { motion: 'fade' })}">`, tabOutline(tabX(0)), '</g>'];
  const name = (session: Reopened, x: number): string[] =>
    session.name === 'lead'
      ? [
          `<g class="${t.show(session.opened, { to: LEAD_IN_VIEW, motion: 'fade' })}">${text(x + 31, 32, session.name, 'mono muted')}</g>`,
          `<g class="${t.show(LEAD_IN_VIEW, { motion: 'fade' })}">${text(x + 31, 32, session.name, 'mono strong')}</g>`,
        ]
      : [text(x + 31, 32, session.name, 'mono muted')];
  const opened = SESSIONS.flatMap((session, i) => {
    const x = tabX(i + 1);
    return [`<g class="${t.show(session.opened, { motion: 'fade' })}">`, mark(session.status, x + 18, 27.5), ...name(session, x), '</g>'];
  });
  const slide = t.steps('translateX(0)', [{ at: RESTORE_CLOSED, duration: SLIDE, value: `translateX(-${TAB_WIDTH + TAB_GAP}px)` }]);
  return [...leadOutline, ...restore, `<g class="${slide}">`, ...opened, '</g>'];
}

/** The restore's tab: each line printing at its moment, all gone as the tab closes. */
function restoreOutput(t: Timeline): string[] {
  return PRINTED.map((line) => `<g class="${t.show(line.from, { to: RESTORE_CLOSED })}">${printedParts(line)}</g>`);
}

/** The lead's tab: the prompt it was resumed with, then its talk. */
function leadTab(t: Timeline): string[] {
  const [first, second] = PROMPT_SHOWN;
  const prompt = [`<g class="${t.show(PROMPT_FROM)}">`, ...lineParts({ y: PROMPT_Y[0], from: PROMPT_FROM, words: first, look: 'ask' }), text(42, PROMPT_Y[1], second, 'mono'), '</g>'];
  return [...prompt, ...TALK.flatMap((line) => [`<g class="${t.show(line.from)}">`, ...lineParts(line), '</g>'])];
}

/** The picture as an SVG file. */
export function renderReboot(): string {
  const t = new Timeline(REBOOT_CLOCK);
  const body = [...windowFrame({ pane: false }), ...tabs(t), ...restoreOutput(t), ...leadTab(t), ...statusKey()];
  return renderSvg({
    width: WIDTH,
    height: VIEW_HEIGHT,
    label: LABEL,
    style: [...themeStyle(), ...WINDOW_STYLE, t.css(), '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'],
    body,
  });
}
