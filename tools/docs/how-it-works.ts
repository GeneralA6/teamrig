/**
 * The README's how-it-works picture: four steps from a wish to a result, in a row, each an icon in a soft halo, a
 * title and one line, joined by small arrows. It follows the reader's light or dark colour scheme and does not move.
 */
import { icon, type Card } from './icons.ts';
import { escapeXml, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';

const WIDTH = 960;
const HEIGHT = 210;

export const STEPS: readonly Card[] = [
  { icon: 'say', title: 'Tell the lead', lines: ['what you want, in plain words.'] },
  { icon: 'hire', title: 'It hires a team', lines: ['and gives each member a job.'] },
  { icon: 'build', title: 'The team builds it', lines: ['together, each in its own tab.'] },
  { icon: 'done', title: 'You get the result', lines: ['the lead calls you back.'] },
];

/** One step: its halo and icon (purple, or green for the last step, the result), its title and its lines. */
function step(card: Card, i: number): string[] {
  const cx = 120 + i * 240;
  const tone = i === STEPS.length - 1 ? 'done' : 'lead';
  const out = [
    `<circle cx="${cx}" cy="58" r="46" class="halo ${tone}"/>`,
    icon(card.icon, cx - 20, 38, 40, `icon ${tone}`),
    `<text x="${cx}" y="152" text-anchor="middle" class="steptitle">${escapeXml(card.title)}</text>`,
    ...card.lines.map((line, j) => `<text x="${cx}" y="${180 + j * 21}" text-anchor="middle" class="sub">${escapeXml(line)}</text>`),
  ];
  if (i < STEPS.length - 1) out.push(`<path d="m${cx + 116} 50 8 8-8 8" class="arrow"/>`);
  return out;
}

/** The picture as an SVG file. */
export function renderHowItWorks(): string {
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label: 'How teamrig works: ' + STEPS.map((card, i) => `${i + 1}. ${card.title}, ${card.lines.join(' ')}`).join(' '),
    style: [
      ...themeStyle(),
      '.steptitle{font-size:19px;font-weight:700}.sub{font-size:14.5px;fill:var(--muted)}',
      '.halo.lead{fill:var(--purple);fill-opacity:.12}.halo.done{fill:var(--green);fill-opacity:.14}',
      '.icon{fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.icon.lead{stroke:var(--purple)}.icon.done{stroke:var(--green)}',
      '.arrow{fill:none;stroke:var(--line);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}',
    ],
    body: STEPS.flatMap(step),
  });
}
