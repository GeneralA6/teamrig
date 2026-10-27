/**
 * The README's lead-meeting picture: your morning meeting in the lead's tab. You say good morning; the lead opens the
 * meeting, and the sessions hold the messages that aren't critical until it ends. It folds its tool run into one line,
 * says what got done, what is late and what your earlier OK already started, then brings three decisions as numbered
 * cards: each with its task, what it is with the facts in numbers, the options with their cost, its pick with a reason
 * and what happens with no answer. You answer all three in one line; the lead records them on their tasks and closes
 * the meeting, and web, whose question was the first card, goes back to work. It is the terminal view's window
 * (terminal-view.ts), taller, with the conversation across it and no pane: one 32 s CSS loop and no script, so GitHub
 * shows it in an <img>. With motion turned off it is a still of the whole meeting.
 */
import { lineParts, trackMarks, type Line, type TabStory } from './story.ts';
import { escapeXml, renderSvg } from './svg.ts';
import { mark, MONO_SIZE, statusKey, tabOutline, tabX, text, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT, WINDOW_STYLE, windowFrame } from './terminal-view.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

/** 32 s a loop; the parts hide at 31 s; the still shows 28 s, when the whole meeting is told. */
export const LEAD_MEETING_CLOCK: Clock = { loop: 32, end: 31, rest: 28 };

/** web goes back to work once the lead has recorded your answer to its card. */
export const WEB_ANSWERED = 22.4;

/** The window is taller than the terminal view's, to hold three cards; the key sits under it as there. */
export const MEETING_WINDOW_HEIGHT = 560;
export const MEETING_VIEW_HEIGHT = MEETING_WINDOW_HEIGHT + VIEW_HEIGHT - WINDOW_HEIGHT;

/** The tabs, left to right; the lead's is in view. web's question waits for the meeting. */
export const TABS: readonly TabStory[] = [
  { name: 'lead', track: 'working' },
  { name: 'api', track: 'working' },
  { name: 'web', track: [{ status: 'needs-you', at: 0.2 }, { status: 'working', at: WEB_ANSWERED }] },
  { name: 'data', track: 'working' },
];

/** A decision card: its first line's baseline, when it appears, its task, what it is, its options A and B and the lead's pick. */
export interface Card {
  readonly y: number;
  readonly from: number;
  readonly task: string;
  readonly ask: string;
  readonly options: readonly [string, string];
  readonly rec: string;
}

/** The step from one line of a card to the next. */
export const CARD_LINE = 22;

/** The room between a card's two options, about three characters: a text's run of spaces would show as one. */
export const OPTION_GAP = 2 * MONO_SIZE;

/** The three decisions: a product call, a budget call and a contract other teams read. */
export const CARDS: readonly Card[] = [
  {
    y: 254,
    from: 9.0,
    task: 'T52',
    ask: 'Guest checkout: let buyers pay without an account? 31% of carts stop at sign-up.',
    options: ["A: add guest checkout, 2 days of web's work.", 'B: keep sign-up as it is, no cost.'],
    rec: 'Rec: A, it wins back the most carts. With no answer: B, nothing changes.',
  },
  {
    y: 334,
    from: 12.6,
    task: 'T60',
    ask: 'A second test database: the tests wait 9 minutes a day for the shared one.',
    options: ['A: rent one, $14 a month.', 'B: run the slow tests at night, free, results a day late.'],
    rec: 'Rec: A, the wait costs more than $14. With no answer: B.',
  },
  {
    y: 414,
    from: 16.2,
    task: 'T66',
    ask: 'Retire the old v1 API: 3 clients still call it, about 40 calls a day.',
    options: ['A: switch it off on Friday, after a notice.', 'B: keep it until the month ends.'],
    rec: 'Rec: B, it gives the 3 clients time to move. With no answer: B.',
  },
];

/** Your answer, in your own words, to all three cards in one line. */
export const ANSWER = '1 A, 2 B, 3 as recommended';

/** The talk around the cards: your greeting and answer, and the lead's lines, its tool run folded into one. */
export const TALK: readonly Line[] = [
  { y: 86, from: 0.6, words: 'Morning.', look: 'ask' },
  { y: 122, from: 1.8, words: "Meeting open at 09:30. Sessions hold the messages that aren't critical until it ends.", look: 'said' },
  { y: 146, from: 3.4, words: 'Read 1 file, ran 4 shell commands', look: 'output' },
  { y: 182, from: 4.8, words: 'Since yesterday 14 tasks are done and 1 is late: T33, the CSV export, now due Thursday.', look: 'said' },
  { y: 218, from: 6.8, words: "Your OK last night already started api's release. Three decisions; answer in your own words.", look: 'said' },
  { y: 494, from: 20.0, words: ANSWER, look: 'ask' },
  {
    y: 530,
    from: 21.8,
    words: 'Recorded on T52, T60 and T66, and web starts guest checkout. Meeting closed: the held messages go out now.',
    look: 'said',
  },
];

const spokenCard = (card: Card, index: number): string => `${index + 1}, ${card.task}: ${card.ask} ${card.options.join(' ')} ${card.rec}`;

const LABEL =
  "Your morning meeting in the lead's tab. You say Morning. The lead opens the meeting at 09:30, and the sessions " +
  "hold the messages that aren't critical until it ends. Since yesterday 14 tasks are done and 1 is late, the CSV " +
  "export, now due Thursday; your OK last night already started api's release. Then three decisions, each a numbered " +
  'card with what it is, the facts in numbers, the options with their cost, the pick and what happens with no answer. ' +
  `${CARDS.map(spokenCard).join(' ')} You answer all three in one line: ${ANSWER}. The lead records them on their ` +
  'tasks, web starts guest checkout, and the meeting closes: the held messages go out.';

/** The tab strip: the lead's tab in view, and each tab's mark and name. */
function tabs(t: Timeline): string[] {
  const tab = (story: TabStory, index: number): string[] => {
    const x = tabX(index);
    return [
      ...trackMarks(t, story.track, LEAD_MEETING_CLOCK.end, (status) => mark(status, x + 18, 27.5)),
      text(x + 31, 32, story.name, index === 0 ? 'mono strong' : 'mono muted'),
    ];
  };
  return [tabOutline(tabX(0)), ...TABS.flatMap(tab)];
}

/** A card's options on one line, B a gap after A. */
function optionsLine(y: number, [a, b]: Card['options']): string {
  return `<text x="102" y="${y}" class="mono">${escapeXml(a)}<tspan dx="${OPTION_GAP}">${escapeXml(b)}</tspan></text>`;
}

/** A card's lines: its number and task, what it is, its options under that and the lead's pick under them. */
function cardParts(card: Card, index: number): string[] {
  return [
    text(42, card.y, String(index + 1), 'mono muted'),
    text(62, card.y, card.task, 'mono accent'),
    text(102, card.y, card.ask, 'mono'),
    optionsLine(card.y + CARD_LINE, card.options),
    text(102, card.y + 2 * CARD_LINE, card.rec, 'mono muted'),
  ];
}

/** The meeting, each line of talk and each card rising in at its moment. */
function conversation(t: Timeline): string[] {
  const talk = TALK.flatMap((line) => [`<g class="${t.show(line.from)}">`, ...lineParts(line), '</g>']);
  const cards = CARDS.flatMap((card, i) => [`<g class="${t.show(card.from)}">`, ...cardParts(card, i), '</g>']);
  return [...talk, ...cards];
}

/** The picture as an SVG file. */
export function renderLeadMeeting(): string {
  const t = new Timeline(LEAD_MEETING_CLOCK);
  const body = [...windowFrame({ pane: false, height: MEETING_WINDOW_HEIGHT }), ...tabs(t), ...conversation(t), ...statusKey(MEETING_VIEW_HEIGHT)];
  return renderSvg({
    width: WIDTH,
    height: MEETING_VIEW_HEIGHT,
    label: LABEL,
    style: [...themeStyle(), ...WINDOW_STYLE, t.css(), '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'],
    body,
  });
}
