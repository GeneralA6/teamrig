/**
 * The README's why-it's-different picture: six cards in rows of three, one major feature each, written as the finished
 * product. The README's Coming line under the picture names every part not built yet, and a card whose whole feature
 * is still to come also carries a small "Coming" tag. It follows the reader's light or dark colour scheme and does not
 * move.
 */
import { icon, type Card } from './icons.ts';
import { escapeXml, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';

const WIDTH = 960;
const CARD_WIDTH = 304;
const CARD_HEIGHT = 196;
const GAP = 24;
const PER_ROW = 3;
const TAG_WIDTH = 70;

/** A card of the picture: a feature, and whether it is still to come. */
export interface Feature extends Card {
  /** True while none of the feature is built: the card is tagged "Coming". */
  readonly coming: boolean;
}

/**
 * Each card must stay true to the code: a claim the code does not back is a bug unless the card is tagged coming or the
 * README's Coming line under the picture names it (today: planning the week from the token budget).
 */
export const MOAT: readonly Feature[] = [
  { icon: 'proof', title: 'A built-in project manager', lines: ['One task list for the whole team:', 'owner, priority, due date and proof.'], coming: false },
  { icon: 'plan', title: 'Your week, planned', lines: ['Scheduled from your token budget;', "flags what's late, stuck or off-plan."], coming: false },
  { icon: 'sun', title: 'Your day back', lines: ['One meeting in the morning. Each', 'decision comes with a recommendation.'], coming: true },
  { icon: 'learn', title: 'Improves itself', lines: ['What one session works out becomes', 'a skill, and each lesson a team rule.'], coming: false },
  { icon: 'fresh', title: 'Survives a crash or reboot', lines: ['Sessions reopen where they left off;', 'tasks and notes are safe on disk.'], coming: true },
  { icon: 'terminal', title: 'Just your terminal', lines: ['Claude Code in the terminal you have.', 'No IDE, no desktop app, no server.'], coming: false },
];

/** The picture's height: its rows of cards, with a gap between rows. */
export const WHY_HEIGHT = Math.ceil(MOAT.length / PER_ROW) * (CARD_HEIGHT + GAP) - GAP;

/** One card: its tile, its icon on a purple chip, its "Coming" tag if it has one, its title and its lines. */
function card(feature: Feature, i: number): string[] {
  const x = (i % PER_ROW) * (CARD_WIDTH + GAP);
  const y = Math.floor(i / PER_ROW) * (CARD_HEIGHT + GAP);
  const tagX = x + CARD_WIDTH - 24 - TAG_WIDTH;
  const tag = feature.coming
    ? [
        `<rect x="${tagX + 0.5}" y="${y + 36.5}" width="${TAG_WIDTH - 1}" height="23" rx="11.5" class="tag"/>`,
        `<text x="${tagX + TAG_WIDTH / 2}" y="${y + 52.5}" text-anchor="middle" class="tagtext">Coming</text>`,
      ]
    : [];
  return [
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="14" class="card"/>`,
    `<rect x="${x + 24}" y="${y + 24}" width="48" height="48" rx="12" class="chip"/>`,
    icon(feature.icon, x + 34, y + 34, 28, 'icon'),
    ...tag,
    `<text x="${x + 24}" y="${y + 114}" class="cardtitle">${escapeXml(feature.title)}</text>`,
    ...feature.lines.map((line, j) => `<text x="${x + 24}" y="${y + 143 + j * 21}" class="sub">${escapeXml(line)}</text>`),
  ];
}

/** The card as its text alternative says it: the title, "(coming)" when it is, then its lines. */
const spoken = (feature: Feature): string => `${feature.title}${feature.coming ? ' (coming)' : ''}. ${feature.lines.join(' ')}`;

/** The picture as an SVG file. */
export function renderWhy(): string {
  return renderSvg({
    width: WIDTH,
    height: WHY_HEIGHT,
    label: 'Why teamrig is different: ' + MOAT.map(spoken).join(' '),
    style: [
      ...themeStyle(),
      '.cardtitle{font-size:18px;font-weight:700}.sub{font-size:14.5px;fill:var(--muted)}',
      '.card{fill:var(--tile);stroke:var(--line)}.chip{fill:var(--purple);fill-opacity:.12}',
      '.tag{fill:none;stroke:var(--muted)}.tagtext{font-size:12.5px;font-weight:600;fill:var(--muted)}',
      '.icon{fill:none;stroke:var(--purple);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    ],
    body: MOAT.flatMap(card),
  });
}
