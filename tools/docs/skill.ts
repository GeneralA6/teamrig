/**
 * The README's skill picture: a procedure becomes a skill, and the scorecard shows it earns its place. In api's tab, api
 * deploys after a retry and some digging, writes the steps down as a skill in the same turn, and its task's record names
 * the skill; a week on, in the lead's tab, `teamrig skills scorecard` shows the skill loaded with fewer calls a run than
 * the procedure took by hand, and another skill never loaded while its procedure ran by hand. The scorecard's lines are
 * printed by the CLI's own code (src/skills/scorecard-report.ts), cut to its first columns to fit the window. It is the
 * terminal view's window (terminal-view.ts) with no pane, in the reader's light or dark colour scheme: one 28 s CSS loop
 * and no script, so GitHub shows it in an <img>. With motion turned off it is a still of the lead reading the scorecard.
 */
import { renderScorecard, type ScorecardFooter, type ScorecardRow } from '../../src/skills/scorecard-report.ts';
import { lineParts, trackMarks, type Line, type TabStory } from './story.ts';
import { renderSvg } from './svg.ts';
import { mark, statusKey, tabOutline, tabX, text, VIEW_HEIGHT, WIDTH, WINDOW_STYLE, windowFrame } from './terminal-view.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

/** 28 s a loop; the parts hide at 27 s; the still shows 24.5 s, the lead reading the scorecard. */
export const SKILL_CLOCK: Clock = { loop: 28, end: 27, rest: 24.5 };

/** api's tab is in view until the lead's comes into view, a week on. */
export const SWITCH = 11.4;
/** api's task is done once it has written the skill and named it on the task. */
export const API_DONE = 9.4;

/** The tabs, left to right: api's in view first, then the lead's. */
export const TABS: readonly TabStory[] = [
  { name: 'lead', track: 'working' },
  { name: 'api', track: [{ status: 'working', at: 0.2 }, { status: 'done', at: API_DONE }] },
  { name: 'web', track: 'working' },
  { name: 'data', track: 'done' },
];

/** The skill api writes, and the one web has that is never loaded. */
export const SKILL = 'api-deploy';
export const SKIPPED = 'web-release';

/** The scorecard's rows a week on: api-deploy loaded and cheaper than by hand, web-release never loaded. */
export const ROWS: readonly ScorecardRow[] = [
  {
    skill: SKILL,
    loads: 6,
    missed: 0,
    callsPerRun: 4.2,
    baseCallsPerRun: 11.5,
    errorsPerRun: 0.2,
    baseErrorsPerRun: 1.5,
    refused: 0,
    edits: 1,
    lastVerified: '2030-01-05',
    descriptionWords: 14,
    flags: [],
  },
  {
    skill: SKIPPED,
    loads: 0,
    missed: 3,
    callsPerRun: undefined,
    baseCallsPerRun: 7,
    errorsPerRun: undefined,
    baseErrorsPerRun: 1,
    refused: 0,
    edits: 0,
    lastVerified: '2030-01-03',
    descriptionWords: 11,
    flags: ['not loaded'],
  },
];

const FOOTER: ScorecardFooter = {
  window: { from: '2030-01-09', to: '2030-01-15' },
  baseline: { from: '2030-01-02', to: '2030-01-08' },
  since: '2029-12-01',
  files: 14,
  bytesRead: 40_055_603,
  catchingUp: false,
};

/** How many of the scorecard's columns fit the window: skill to base err/run. */
export const COLUMNS_SHOWN = 7;

/** The scorecard as `teamrig skills scorecard` prints it: its heading, then its table cut to the first columns. */
export const SCORECARD: readonly string[] = (() => {
  const printed = renderScorecard(ROWS, FOOTER);
  const table = printed.filter((line) => line.startsWith('| ')).map((line) => `${line.split(' | ').slice(0, COLUMNS_SHOWN).join(' | ')} |`);
  return [printed[0] ?? '', ...table];
})();

const one = (value: number | undefined): string => (value === undefined ? '-' : value.toFixed(1));
const [deployRow, skippedRow] = ROWS;

/** api's talk: it deploys, the first try fails, and it writes the steps down as a skill in the same turn. */
export const API_TALK: readonly Line[] = [
  { y: 86, from: 0.6, words: 'Deploy api and prove the new version serves.', look: 'ask' },
  { y: 110, from: 1.8, words: 'Ran 12 shell commands', look: 'output' },
  { y: 146, from: 3.4, words: 'Deployed, and v2.4 serves. The first try hit a stale build lock, so it took a retry and some digging.', look: 'said' },
  { y: 182, from: 5.4, words: "I'll run this again, so I'm writing the steps and the trap down as a skill now.", look: 'said' },
  { y: 206, from: 7.0, words: `Wrote 21 lines to ~/.claude/skills/${SKILL}/SKILL.md`, look: 'output' },
  { y: 242, from: 8.6, words: `T42 is done, and its record names the skill it left: ${SKILL}.`, look: 'said' },
];

/** The lead's talk a week on: it reads the scorecard and says which skill earns its place. */
export const LEAD_TALK: readonly Line[] = [
  { y: 86, from: 12.4, words: 'A week on: which skills earn their place?', look: 'ask' },
  { y: 110, from: 13.6, words: 'teamrig skills scorecard', look: 'command' },
  ...SCORECARD.map((words, i): Line => ({ y: 134 + i * 22, from: 14.4 + i * 0.15, words, look: 'output' })),
  {
    y: 270,
    from: 17.4,
    words: `${SKILL} pays its way: ${deployRow?.loads ?? 0} runs at ${one(deployRow?.callsPerRun)} calls each, against ${one(deployRow?.baseCallsPerRun)} by hand before it.`,
    look: 'said',
  },
  {
    y: 306,
    from: 20.0,
    words: `${SKIPPED} was never loaded while web ran it by hand ${skippedRow?.missed ?? 0} times, so I'll ask web why.`,
    look: 'said',
  },
];

const LABEL =
  "A procedure becomes a skill. In api's tab, api deploys and proves the new version serves; the first try hit a stale " +
  'build lock, so it took a retry and some digging. It will run this again, so it writes the steps and the trap down as ' +
  `a skill, ${SKILL}, in the same turn, and its task's record names the skill. A week on, in the lead's tab, teamrig ` +
  `skills scorecard shows ${SKILL} loaded ${deployRow?.loads ?? 0} times at ${one(deployRow?.callsPerRun)} calls a run, ` +
  `against ${one(deployRow?.baseCallsPerRun)} by hand before it, and ${SKIPPED} never loaded while its procedure ran by ` +
  `hand ${skippedRow?.missed ?? 0} times, so the lead asks web why.`;

/** The tab strip: api's tab in view, then the lead's, the one in view named in bold; each tab's mark over the loop. */
function tabs(t: Timeline): string[] {
  const inView = (index: number, from: number, to?: number): string =>
    `<g class="${t.show(from, to === undefined ? { motion: 'fade' } : { to, motion: 'fade' })}">${tabOutline(tabX(index))}</g>`;
  const name = (story: TabStory, index: number): string[] => {
    const x = tabX(index) + 31;
    const named = (classes: string, from: number, to?: number): string =>
      `<g class="${t.show(from, to === undefined ? { motion: 'fade' } : { to, motion: 'fade' })}">${text(x, 32, story.name, classes)}</g>`;
    if (story.name === 'api') return [named('mono strong', 0.2, SWITCH), named('mono muted', SWITCH)];
    if (story.name === 'lead') return [named('mono muted', 0.2, SWITCH), named('mono strong', SWITCH)];
    return [text(x, 32, story.name, 'mono muted')];
  };
  const strip = TABS.flatMap((story, index) => [
    ...trackMarks(t, story.track, SKILL_CLOCK.end, (status) => mark(status, tabX(index) + 18, 27.5)),
    ...name(story, index),
  ]);
  return [inView(1, 0.2, SWITCH), inView(0, SWITCH), ...strip];
}

/** A tab's talk, each line rising in at its moment, gone at `to` when its tab leaves the view. */
function talk(t: Timeline, lines: readonly Line[], to: number | undefined): string[] {
  return lines.flatMap((line) => [`<g class="${t.show(line.from, to === undefined ? {} : { to })}">`, ...lineParts(line), '</g>']);
}

/** The picture as an SVG file. */
export function renderSkill(): string {
  const t = new Timeline(SKILL_CLOCK);
  const body = [...windowFrame({ pane: false }), ...tabs(t), ...talk(t, API_TALK, SWITCH), ...talk(t, LEAD_TALK, undefined), ...statusKey()];
  return renderSvg({
    width: WIDTH,
    height: VIEW_HEIGHT,
    label: LABEL,
    style: [...themeStyle(), ...WINDOW_STYLE, t.css(), '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'],
    body,
  });
}
