/**
 * The README's how-it-works picture: the four steps from a wish to a result, and six tiles on what keeps the team
 * on track. It follows the reader's light or dark colour scheme; the only motion is the dashed arrows' flow, which
 * stops when the reader asks for reduced motion.
 */
import { icon, type IconName } from './icons.ts';
import { escapeXml, renderSvg, SANS_FONTS } from './svg.ts';

const WIDTH = 960;
const HEIGHT = 500;

/** One step or tile: an icon, a title and two short lines under it. */
interface Card {
  readonly icon: IconName;
  readonly title: string;
  readonly lines: readonly [string, string];
}

export const STEPS: readonly Card[] = [
  { icon: 'say', title: 'Say what you want', lines: ['one sentence to the', 'lead session'] },
  { icon: 'lead', title: 'The lead plans it', lines: ['proposes a team and splits', 'the work into tasks'] },
  { icon: 'team', title: 'The team builds it', lines: ['each session takes its own', 'tasks, in its own tab'] },
  { icon: 'done', title: 'You get the result', lines: ['the lead tells you', 'when it is ready'] },
];

export const TILES: readonly Card[] = [
  { icon: 'list', title: 'One owner per task', lines: ['a shared task list, so no two', 'sessions do the same work'] },
  { icon: 'note', title: 'Notes between sessions', lines: ['they message each other;', 'no server to run'] },
  { icon: 'rules', title: 'Your rules, every time', lines: ['each session starts with', "your team's rules"] },
  { icon: 'shield', title: 'Safe pushes', lines: ['nobody force-pushes', 'your main branch'] },
  { icon: 'fresh', title: 'Fresh context', lines: ['a long session writes a handover', 'and picks up from it, clean'] },
  { icon: 'local', title: 'All on your machine', lines: ['plain files, no account,', 'works offline'] },
];

/** The colour tokens, each with its light value and its dark value. */
export const TOKENS: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  fg: ['#1f2328', '#e6edf3'],
  muted: ['#59636e', '#9198a1'],
  line: ['#d1d9e0', '#3d444d'],
  tile: ['#f6f8fa', '#151b23'],
  accent: ['#8250df', '#a371f7'],
  soft: ['#f5f0ff', '#211836'],
  bg: ['#ffffff', '#0d1117'],
};

const SUMMARY =
  'How teamrig works: 1, say what you want in one sentence to the lead session. 2, the lead proposes a team and splits the work into tasks. ' +
  '3, each session takes its own tasks in its own tab. 4, the lead tells you when it is ready. What keeps the team on track: one owner per task, ' +
  "notes between sessions, your team's rules in every session, safe pushes, a fresh context from a handover, and everything on your machine.";

const text = (x: number, y: number, cls: string, words: string, anchor = ''): string =>
  `<text x="${x}" y="${y}"${anchor === '' ? '' : ` text-anchor="${anchor}"`} class="${cls}">${escapeXml(words)}</text>`;

/** The four steps in a row, each a numbered badge, joined by flowing arrows. */
function steps(): string[] {
  const out: string[] = [];
  STEPS.forEach((step, i) => {
    const cx = 120 + i * 240;
    out.push(
      `<circle cx="${cx}" cy="70" r="40" class="badge"/>`,
      icon(step.icon, cx - 19, 51, 38),
      `<circle cx="${cx - 30}" cy="38" r="12" class="num"/>${text(cx - 30, 42.5, 'numtext', String(i + 1), 'middle')}`,
      text(cx, 144, 'title', step.title, 'middle'),
      text(cx, 168, 'sub', step.lines[0], 'middle'),
      text(cx, 188, 'sub', step.lines[1], 'middle'),
    );
    if (i < STEPS.length - 1) out.push(`<path d="M${cx + 54} 70H${cx + 182}" class="flow"/><path d="m${cx + 178} 64 8 6-8 6" class="arrow"/>`);
  });
  return out;
}

/** The six tiles, three to a row, under their heading. */
function tiles(): string[] {
  const out = [text(20, 246, 'label', 'WHAT KEEPS THE TEAM ON TRACK')];
  TILES.forEach((tile, i) => {
    const x = 20 + (i % 3) * 312;
    const y = 264 + Math.floor(i / 3) * 112;
    out.push(
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="295" height="99" rx="12" class="tile"/>`,
      icon(tile.icon, x + 20, y + 22, 28),
      text(x + 64, y + 38, 'tiletitle', tile.title),
      text(x + 64, y + 62, 'sub', tile.lines[0]),
      text(x + 64, y + 81, 'sub', tile.lines[1]),
    );
  });
  return out;
}

/** The tokens' declarations for one side: `--fg:#1f2328;--muted:...`. */
function declarations(side: 0 | 1): string {
  return Object.entries(TOKENS)
    .map(([name, values]) => `--${name}:${values[side]}`)
    .join(';');
}

/**
 * The picture as an SVG file. It paints its own background: a picture in an <img> follows the operating system's
 * colour scheme, not GitHub's theme, so on a page whose theme differs from the system's its text stays readable.
 */
export function renderHowItWorks(): string {
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label: SUMMARY,
    style: [
      `:root{${declarations(0)}}`,
      `@media (prefers-color-scheme:dark){:root{${declarations(1)}}}`,
      `text{font-family:${SANS_FONTS};fill:var(--fg)}`,
      '.title{font-size:17px;font-weight:600}.tiletitle{font-size:15px;font-weight:600}.sub{font-size:13.5px;fill:var(--muted)}',
      '.label{font-size:12px;font-weight:600;letter-spacing:.09em;fill:var(--muted)}',
      '.badge{fill:var(--soft);stroke:var(--accent);stroke-width:1.5}.num{fill:var(--accent)}.numtext{font-size:13px;font-weight:700;fill:#fff}',
      '.icon{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}',
      '.tile{fill:var(--tile);stroke:var(--line)}',
      '.bg{fill:var(--bg)}',
      '.flow{stroke:var(--accent);stroke-width:2;stroke-dasharray:3 7;stroke-linecap:round;animation:flow 1.2s linear infinite}',
      '.arrow{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '@keyframes flow{to{stroke-dashoffset:-20}}',
      '@media (prefers-reduced-motion:reduce){.flow{animation:none}}',
    ],
    body: [`<rect width="${WIDTH}" height="${HEIGHT}" rx="12" class="bg"/>`, ...steps(), ...tiles()],
  });
}
