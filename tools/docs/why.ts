/**
 * The README's why-it's-different picture: six cards in rows of three, one idea each, on what no single Claude Code
 * session gives you. It follows the reader's light or dark colour scheme and does not move.
 */
import { icon, type Card } from './icons.ts';
import { escapeXml, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';

const WIDTH = 960;
const CARD_WIDTH = 304;
const CARD_HEIGHT = 196;
const GAP = 24;
const PER_ROW = 3;

/** Each card must stay true to the code: a claim the code does not back is a bug in this picture. */
export const MOAT: readonly Card[] = [
  { icon: 'plan', title: 'A built-in project manager', lines: ["Plans your week and flags what's", 'late, stuck or forgotten.'] },
  { icon: 'gauge', title: 'Thrifty with your tokens', lines: ['Lean, capped rules, and notes that', 'wait instead of waking anyone.'] },
  { icon: 'learn', title: 'Smarter every day', lines: ['What one member works out becomes', 'a skill the whole team reuses.'] },
  { icon: 'fresh', title: 'Never loses the thread', lines: ['When its memory runs high, a member', 'leaves a handover for a fresh start.'] },
  { icon: 'proof', title: 'Done means proven', lines: ['A task closes only with evidence', 'and a lesson the team keeps.'] },
  { icon: 'shield', title: 'Safe by default', lines: ['Asks before a push to main, refuses', 'blind force-pushes and keys in notes.'] },
];

/** The picture's height: its rows of cards, with a gap between rows. */
export const WHY_HEIGHT = Math.ceil(MOAT.length / PER_ROW) * (CARD_HEIGHT + GAP) - GAP;

/** One card: its tile, its icon on a purple chip, its title and its lines. */
function card(moat: Card, i: number): string[] {
  const x = (i % PER_ROW) * (CARD_WIDTH + GAP);
  const y = Math.floor(i / PER_ROW) * (CARD_HEIGHT + GAP);
  return [
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="14" class="card"/>`,
    `<rect x="${x + 24}" y="${y + 24}" width="48" height="48" rx="12" class="chip"/>`,
    icon(moat.icon, x + 34, y + 34, 28, 'icon'),
    `<text x="${x + 24}" y="${y + 114}" class="cardtitle">${escapeXml(moat.title)}</text>`,
    ...moat.lines.map((line, j) => `<text x="${x + 24}" y="${y + 143 + j * 21}" class="sub">${escapeXml(line)}</text>`),
  ];
}

/** The picture as an SVG file. */
export function renderWhy(): string {
  return renderSvg({
    width: WIDTH,
    height: WHY_HEIGHT,
    label: 'Why teamrig is different: ' + MOAT.map((moat) => `${moat.title}. ${moat.lines.join(' ')}`).join(' '),
    style: [
      ...themeStyle(),
      '.cardtitle{font-size:18px;font-weight:700}.sub{font-size:14.5px;fill:var(--muted)}',
      '.card{fill:var(--tile);stroke:var(--line)}.chip{fill:var(--purple);fill-opacity:.12}',
      '.icon{fill:none;stroke:var(--purple);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    ],
    body: MOAT.flatMap(card),
  });
}
