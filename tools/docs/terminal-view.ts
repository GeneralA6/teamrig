/**
 * The README's just-your-terminal picture: how teamrig looks in the terminal you already have. One window with a tab
 * per session, the lead's conversation on the left, teamrig-pane's task list on the right, and a key to the status
 * marks under the window. It follows the reader's light or dark colour scheme and does not move.
 */
import { escapeXml, MONO_FONTS, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';

/** Where a session or a task stands, as its mark shows it. */
export type Status = 'working' | 'needs-you' | 'not-started' | 'done';

/** A session's tab: its name and where its work stands. */
export interface Tab {
  readonly name: string;
  readonly status: Status;
}

/** A decision the lead brings to you: the member that needs it, the question and the lead's pick. */
export interface Decision {
  readonly from: string;
  readonly ask: string;
  readonly pick: string;
}

/** A row of the pane: a task, its owner, its priority, when it is due and where it stands. */
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly priority: string;
  readonly due: string;
  readonly status: Status;
}

/** The tabs, left to right; the first is the one in view. */
export const TABS: readonly Tab[] = [
  { name: 'lead', status: 'working' },
  { name: 'api', status: 'working' },
  { name: 'web', status: 'needs-you' },
  { name: 'data', status: 'needs-you' },
  { name: 'docs', status: 'not-started' },
  { name: 'tests', status: 'working' },
];

/** What you type in the lead's tab. */
export const ASK = 'Morning. What needs me?';
/** The lead's answer: its opening line, the decisions, and its closing line. */
export const OPENING = 'Two decisions, each with my pick:';
export const DECISIONS: readonly Decision[] = [
  { from: 'data', ask: 'Keep logs 30 days or 90?', pick: '30, it halves the storage.' },
  { from: 'web', ask: 'Offer Google sign-in on the form?', pick: 'not yet, email first.' },
];
export const CLOSING = 'Everything else is on plan.';
/** Your reply, still in the prompt. */
export const ANSWER = '1 yes, 2 yes';

/** The pane's rows, in plan order. */
export const TASKS: readonly Task[] = [
  { id: 'T12', title: 'Signup form', owner: 'web', priority: 'p1', due: 'due today', status: 'needs-you' },
  { id: 'T13', title: 'Signup endpoint', owner: 'api', priority: 'p1', due: 'due today', status: 'working' },
  { id: 'T14', title: 'Log retention', owner: 'data', priority: 'p2', due: 'due Thu', status: 'needs-you' },
  { id: 'T16', title: 'End-to-end tests', owner: 'tests', priority: 'p2', due: 'due Fri', status: 'working' },
  { id: 'T15', title: 'API docs', owner: 'docs', priority: 'p2', due: 'due Fri', status: 'not-started' },
  { id: 'T11', title: 'Release notes', owner: 'docs', priority: 'p3', due: 'done', status: 'done' },
];

/** The key under the window: each status's name. */
export const KEY: Readonly<Record<Status, string>> = { working: 'working', 'needs-you': 'needs you', 'not-started': 'not started', done: 'done' };
/** The key's order, left to right. */
export const KEY_ORDER: readonly Status[] = ['working', 'needs-you', 'not-started', 'done'];

export const WIDTH = 960;
/** The window's height; the key sits under it. */
export const WINDOW_HEIGHT = 392;
export const VIEW_HEIGHT = 436;
/** The line between the conversation and the pane, and the pane's own left and right edges. */
export const DIVIDER_X = 600;
export const PANE_LEFT = 616;
export const PANE_RIGHT = 944;
/** The size of the terminal's text. */
export const MONO_SIZE = 13.5;

/** The tab strip's height, and each tab's width and the gap after it. */
export const STRIP_HEIGHT = 44;
export const TAB_WIDTH = 92;
export const TAB_GAP = 4;
/** The baseline of the pane's first task row, and the step to the next row. */
export const ROW_TOP = 124;
export const ROW_STEP = 46;

/** The window's stylesheet lines after the theme's: fonts, text colours, the frame, and one class per status mark. */
export const WINDOW_STYLE: readonly string[] = [
  `.mono{font-family:${MONO_FONTS};font-size:${MONO_SIZE}px}.muted{fill:var(--muted)}.accent{fill:var(--purple)}.strong{font-weight:700}`,
  '.key{font-size:13.5px;fill:var(--muted)}',
  '.window{fill:var(--bg);stroke:var(--line)}.strip{fill:var(--tile)}.tab{fill:var(--bg);stroke:var(--line)}',
  '.rule,.box{fill:none;stroke:var(--line)}.bullet{fill:var(--muted)}',
  '.working{fill:var(--green)}.needs{fill:var(--amber)}.open{fill:none;stroke:var(--muted);stroke-width:1.5}',
  '.done{fill:none;stroke:var(--muted);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
];

/** The left edge of the tab at `index`, counted from 0. */
export const tabX = (index: number): number => 12 + index * (TAB_WIDTH + TAB_GAP);

/** The outline of the tab in view, whose left edge is at x. */
export const tabOutline = (x: number): string =>
  `<path d="M${x + 0.5} ${STRIP_HEIGHT + 1.5}V16a8 8 0 0 1 8-8h${TAB_WIDTH - 17}a8 8 0 0 1 8 8V${STRIP_HEIGHT + 1.5}" class="tab"/>`;

/** The mark for a status, centred on (cx, cy). */
export function mark(status: Status, cx: number, cy: number): string {
  if (status === 'working') return `<circle cx="${cx}" cy="${cy}" r="4.5" class="working"/>`;
  if (status === 'needs-you') return `<rect x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9" rx="1.5" class="needs"/>`;
  if (status === 'not-started') return `<circle cx="${cx}" cy="${cy}" r="4" class="open"/>`;
  return `<path d="M${cx - 4.5} ${cy}l3 3 6-6.5" class="done"/>`;
}

/** A line of text at (x, y) with the given classes, its words escaped. */
export function text(x: number, y: number, words: string, classes: string, anchor: 'start' | 'end' = 'start'): string {
  const anchorAttribute = anchor === 'end' ? ' text-anchor="end"' : '';
  return `<text x="${x}" y="${y}"${anchorAttribute} class="${classes}">${escapeXml(words)}</text>`;
}

/** The bullet before a line the lead says, for a line whose baseline is at y. */
export const bullet = (y: number): string => `<circle cx="28.5" cy="${y - 4.5}" r="3.5" class="bullet"/>`;

/** teamrig-pane's heading: its title, its name, and the rule under them. */
export function paneHeading(): string[] {
  return [text(PANE_LEFT, 86, 'Tasks', 'mono strong'), text(PANE_RIGHT, 86, 'teamrig-pane', 'mono muted', 'end'), `<path d="M${PANE_LEFT} 98.5H${PANE_RIGHT}" class="rule"/>`];
}

/** How the window is split: the conversation beside teamrig-pane, or the conversation alone across the window. */
export interface FrameOptions {
  readonly pane?: boolean;
}

/** The empty window: its body, its tab strip, the line under the strip and, with the pane, the line between the conversation and the pane. */
export function windowFrame({ pane = true }: FrameOptions = {}): string[] {
  const divider = pane ? `M${DIVIDER_X + 0.5} ${STRIP_HEIGHT + 1}V${WINDOW_HEIGHT - 1}` : '';
  return [
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${WINDOW_HEIGHT - 1}" rx="12" class="window"/>`,
    `<path d="M1 ${STRIP_HEIGHT}V12.5A11.5 11.5 0 0 1 12.5 1H${WIDTH - 12.5}A11.5 11.5 0 0 1 ${WIDTH - 1} 12.5V${STRIP_HEIGHT}z" class="strip"/>`,
    `<path d="M1 ${STRIP_HEIGHT + 0.5}H${WIDTH - 1}${divider}" class="rule"/>`,
  ];
}

/** The window, its tab strip and the tabs, the first one in view. */
function frame(): string[] {
  const tabs = TABS.flatMap((tab, i) => {
    const x = tabX(i);
    const inView = i === 0;
    return [...(inView ? [tabOutline(x)] : []), mark(tab.status, x + 18, 27.5), text(x + 31, 32, tab.name, inView ? 'mono strong' : 'mono muted')];
  });
  return [
    ...windowFrame(),
    ...tabs,
  ];
}

/** The lead's tab: your question, the lead's answer with its decisions, and your reply in the prompt. */
function conversation(): string[] {
  const decisions = DECISIONS.flatMap((decision, i) => {
    const y = 154 + i * 52;
    return [
      text(42, y, String(i + 1), 'mono muted'),
      text(62, y, decision.from, 'mono accent'),
      text(114, y, decision.ask, 'mono'),
      text(114, y + 22, `My pick: ${decision.pick}`, 'mono muted'),
    ];
  });
  const closingY = 154 + DECISIONS.length * 52 + 4;
  const promptY = WINDOW_HEIGHT - 43.5;
  return [
    text(24, 86, '>', 'mono accent'),
    text(42, 86, ASK, 'mono'),
    bullet(122),
    text(42, 122, OPENING, 'mono'),
    ...decisions,
    bullet(closingY),
    text(42, closingY, CLOSING, 'mono'),
    `<rect x="16.5" y="${WINDOW_HEIGHT - 70.5}" width="${DIVIDER_X - 32}" height="44" rx="8" class="box"/>`,
    text(32, promptY, '>', 'mono accent'),
    text(50, promptY, ANSWER, 'mono'),
  ];
}

/** teamrig-pane: its heading, then each task on two lines, its mark beside the first. */
function pane(): string[] {
  const rows = TASKS.flatMap((task, i) => {
    const y = ROW_TOP + i * ROW_STEP;
    return [
      mark(task.status, PANE_LEFT + 6, y - 4.5),
      text(PANE_LEFT + 20, y, task.id, 'mono muted'),
      text(PANE_LEFT + 64, y, task.title, task.status === 'done' ? 'mono muted' : 'mono'),
      text(PANE_LEFT + 64, y + 19, `${task.owner} · ${task.priority} · ${task.due}`, 'mono muted'),
    ];
  });
  return [...paneHeading(), ...rows];
}

/** The key under the window: each status's mark and its name. */
export function statusKey(): string[] {
  return KEY_ORDER.flatMap((status, i) => {
    const x = 24 + i * 132;
    return [mark(status, x, VIEW_HEIGHT - 20.5), text(x + 14, VIEW_HEIGHT - 16, KEY[status], 'key')];
  });
}

/** A pane row as its text alternative says it. */
const spokenTask = (task: Task): string =>
  `${task.id} ${task.title}, ${task.owner}, ${task.priority}, ${task.status === 'done' ? 'done' : `${task.due}, ${KEY[task.status]}`}.`;

/** The picture as an SVG file. */
export function renderTerminalView(): string {
  const decisions = DECISIONS.map((decision, i) => `${i + 1}, ${decision.from}: ${decision.ask} My pick: ${decision.pick}`).join(' ');
  return renderSvg({
    width: WIDTH,
    height: VIEW_HEIGHT,
    label:
      `teamrig in your terminal: one window, one tab per session (${TABS.map((tab) => tab.name).join(', ')}). ` +
      `In the lead's tab you ask: ${ASK} The lead answers: ${OPENING} ${decisions} ${CLOSING} You reply: ${ANSWER}. ` +
      `Beside the conversation, teamrig-pane lists the team's tasks: ${TASKS.map(spokenTask).join(' ')}`,
    style: [...themeStyle(), ...WINDOW_STYLE],
    body: [...frame(), ...conversation(), ...pane(), ...statusKey()],
  });
}
