import { escapeXml } from './svg.ts';

/**
 * Draws terminal text as an SVG picture of a terminal window: a tab bar over one or more panes side by side.
 * Its lines come from the real CLI's output (demo.ts), so a picture never shows something the CLI does not print.
 */

export type Tone = 'text' | 'command' | 'dim' | 'prompt' | 'id' | 'priority' | 'good' | 'warn' | 'bad';

export interface Span {
  readonly text: string;
  readonly tone: Tone;
}

export type Line = readonly Span[];

export interface Pane {
  readonly title: string;
  readonly lines: readonly Line[];
}

export interface Tab {
  readonly label: string;
  readonly active: boolean;
}

export interface TerminalScreen {
  /** The picture's text alternative, for screen readers. */
  readonly label: string;
  readonly tabs: readonly Tab[];
  readonly panes: readonly Pane[];
  /** Side by side (the default) or one above the other. */
  readonly layout?: 'side-by-side' | 'stacked';
}

/** A dark terminal theme, so the picture reads the same on GitHub's light and dark pages. */
const PALETTE: Readonly<Record<Tone, string>> = {
  text: '#d4d4d4',
  command: '#ffffff',
  dim: '#8b8b8b',
  prompt: '#569cd6',
  id: '#4ec9b0',
  priority: '#c586c0',
  good: '#89d185',
  warn: '#dcdcaa',
  bad: '#f48771',
};
const CHROME = { window: '#1e1e1e', bar: '#2d2d2d', border: '#3c3c3c', accent: '#569cd6' } as const;

const FONT_SIZE = 13;
/** The widest common monospace advance at FONT_SIZE (Menlo, DejaVu Sans Mono); narrower fonts only leave space. */
const CHAR_WIDTH = 7.83;
const LINE_HEIGHT = 18;
/** An empty line (the gap between two commands) is drawn shorter than a text line, to keep the picture short. */
const GAP_HEIGHT = 8;
const PAD = 14;
const TAB_HEIGHT = 32;
const PANE_TITLE_HEIGHT = 26;

/** The longest line a pane shows; a longer one is cut with an ellipsis. */
export const DEFAULT_COLUMNS = 72;

/** Output words that get a colour, in the order they are tried at each position. */
const TOKENS: readonly (readonly [string, Tone])[] = [
  ['^(?:ADDED|SET|UPDATED|POSTED|READ|VALID|OK)\\b', 'good'],
  ['^(?:REFUSED|FAILED)\\b', 'bad'],
  ['\\bT\\d+\\b', 'id'],
  ['\\bp\\d{1,2}(?=,)', 'priority'],
  ['\\bdone\\b', 'good'],
  ['\\bin-progress\\b', 'warn'],
  ['\\bblocked\\b', 'bad'],
  ['\\bdue \\d\\d-\\d\\d\\b', 'dim'],
  ['^- \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d', 'dim'],
];
const TOKEN = new RegExp(TOKENS.map(([pattern], index) => `(?<t${index}>${pattern})`).join('|'), 'g');

function toneOf(groups: Readonly<Record<string, string | undefined>>): Tone {
  const index = TOKENS.findIndex((_token, at) => groups[`t${at}`] !== undefined);
  return TOKENS[index]?.[1] ?? 'text';
}

/** One line of CLI output, coloured: `$ ` starts a typed command; ids, priorities, statuses and verdicts stand out. */
export function highlight(text: string): Line {
  if (text.startsWith('$ ')) {
    return [
      { text: '$ ', tone: 'prompt' },
      { text: text.slice(2), tone: 'command' },
    ];
  }
  const spans: Span[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > at) spans.push({ text: text.slice(at, match.index), tone: 'text' });
    spans.push({ text: match[0], tone: toneOf(match.groups ?? {}) });
    at = match.index + match[0].length;
  }
  if (at < text.length) spans.push({ text: text.slice(at), tone: 'text' });
  return spans;
}

export const lineLength = (line: Line): number => line.reduce((sum, span) => sum + span.text.length, 0);

/** The line cut to `columns` characters, the last one an ellipsis, when it is longer. */
export function truncate(line: Line, columns: number): Line {
  if (lineLength(line) <= columns) return line;
  const kept: Span[] = [];
  let room = columns - 1;
  for (const span of line) {
    if (room <= 0) break;
    kept.push({ text: span.text.slice(0, room), tone: span.tone });
    room -= span.text.length;
  }
  const last = kept.at(-1);
  return last === undefined ? [{ text: '…', tone: 'dim' }] : [...kept.slice(0, -1), { text: `${last.text}…`, tone: last.tone }];
}

/** One decimal at most, so the same picture always prints the same bytes. */
const n = (value: number): string => String(Math.round(value * 10) / 10);

function textRow(x: number, y: number, line: Line): string {
  const spans = line.map((span) => `<tspan fill="${PALETTE[span.tone]}">${escapeXml(span.text)}</tspan>`).join('');
  return `<text x="${n(x)}" y="${n(y)}">${spans}</text>`;
}

const paneWidth = (pane: Pane): number => PAD * 2 + CHAR_WIDTH * Math.max(pane.title.length, ...pane.lines.map(lineLength));
const rowHeight = (line: Line): number => (line.length === 0 ? GAP_HEIGHT : LINE_HEIGHT);
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const paneHeight = (pane: Pane): number => PANE_TITLE_HEIGHT + PAD + sum(pane.lines.map(rowHeight)) + PAD / 2;

function drawPane(pane: Pane, x: number, y: number): string[] {
  const rows = [textRow(x + PAD, y + PANE_TITLE_HEIGHT - 8, [{ text: pane.title, tone: 'dim' }])];
  let baseline = y + PANE_TITLE_HEIGHT + PAD;
  for (const line of pane.lines) {
    if (line.length > 0) rows.push(textRow(x + PAD, baseline, line));
    baseline += rowHeight(line);
  }
  return rows;
}

function drawTabs(tabs: readonly Tab[]): { readonly width: number; readonly parts: string[] } {
  const parts: string[] = [];
  let x = PAD / 2;
  for (const tab of tabs) {
    const width = CHAR_WIDTH * (tab.label.length + 4) + PAD;
    if (tab.active) parts.push(`<rect x="${n(x)}" y="6" width="${n(width)}" height="${TAB_HEIGHT - 6}" rx="5" fill="${CHROME.window}"/>`);
    parts.push(`<circle cx="${n(x + PAD)}" cy="${n(TAB_HEIGHT / 2 + 3)}" r="4" fill="${tab.active ? CHROME.accent : PALETTE.dim}"/>`);
    parts.push(textRow(x + PAD + CHAR_WIDTH * 1.5, TAB_HEIGHT / 2 + 7, [{ text: tab.label, tone: tab.active ? 'command' : 'dim' }]));
    x += width;
  }
  return { width: x + PAD / 2, parts };
}

/**
 * The screen as an SVG terminal window. Panes sit side by side, or `stacked` one above the other (a narrower
 * picture, which GitHub shows without shrinking the text). Lines longer than `columns` are cut with an ellipsis.
 */
export function renderTerminal(screen: TerminalScreen, columns: number = DEFAULT_COLUMNS): string {
  const panes = screen.panes.map((full) => {
    const pane: Pane = { title: full.title, lines: full.lines.map((line) => truncate(line, columns)) };
    return { pane, width: paneWidth(pane), height: paneHeight(pane) };
  });
  const stacked = screen.layout === 'stacked';
  const widths = panes.map((drawn) => drawn.width);
  const heights = panes.map((drawn) => drawn.height);
  const tabs = drawTabs(screen.tabs);
  const width = Math.ceil(Math.max(tabs.width, stacked ? Math.max(0, ...widths) : sum(widths)));
  const height = Math.ceil(TAB_HEIGHT + (stacked ? sum(heights) : Math.max(0, ...heights)));
  const body: string[] = [
    `<rect width="${width}" height="${height}" rx="8" fill="${CHROME.window}" stroke="${CHROME.border}"/>`,
    `<path d="M0 8a8 8 0 0 1 8-8h${width - 16}a8 8 0 0 1 8 8v${TAB_HEIGHT - 8}h-${width}z" fill="${CHROME.bar}"/>`,
    ...tabs.parts,
  ];
  let x = 0;
  let y = TAB_HEIGHT;
  panes.forEach((drawn, index) => {
    if (index > 0) {
      const ends = stacked ? `x1="0" y1="${n(y)}" x2="${width}" y2="${n(y)}"` : `x1="${n(x)}" y1="${TAB_HEIGHT}" x2="${n(x)}" y2="${height}"`;
      body.push(`<line ${ends} stroke="${CHROME.border}"/>`);
    }
    body.push(...drawPane(drawn.pane, x, y));
    if (stacked) y += drawn.height;
    else x += drawn.width;
  });
  const label = escapeXml(screen.label);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xml:space="preserve" role="img" aria-label="${label}">`,
    `<title>${label}</title>`,
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace;font-size:${FONT_SIZE}px;white-space:pre}</style>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

