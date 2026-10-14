import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDemo, type DemoRun, type DemoStep } from './demo.ts';
import { highlight, renderTerminal, type Line, type TerminalScreen } from './terminal-svg.ts';
import { renderWordmark } from './wordmark.ts';

/**
 * The README's pictures: the wordmark, and terminal screens drawn from a demo run of the real CLI (demo.ts), so a
 * change to what the CLI prints changes the picture, and `images-cli.ts --check` fails until it is redrawn.
 */

export const IMAGES_DIR = 'docs/images';

export interface Picture {
  /** The file name under IMAGES_DIR. */
  readonly file: string;
  readonly svg: string;
}

/** A pane's lines: each command after a `$ ` prompt, then what it printed, with a blank line between commands. */
export function paneLines(runs: readonly DemoRun[]): Line[] {
  return runs.flatMap((run, index) => [...(index === 0 ? [] : [[]]), highlight(`$ ${run.command}`), ...run.output.map(highlight)]);
}

const runsOf = (runs: readonly DemoRun[], session: string): DemoRun[] => runs.filter((run) => run.session === session);

/** The hero: the lead hands out work and tells web about it; web reads its inbox and starts. */
export const HERO_STEPS: readonly DemoStep[] = [
  { session: 'lead', argv: ['add', '--title', 'Saved-card API', '--tier', '1', '--owner', 'api'] },
  { session: 'lead', argv: ['add', '--title', 'Card checkout page', '--tier', '1', '--owner', 'web'] },
  { session: 'lead', argv: ['inbox', 'add', '--to', 'web', '--text', "T2 is yours; it uses T1's API"] },
  { session: 'web', argv: ['inbox', 'read'] },
  { session: 'web', argv: ['set', 'T2', '--status', 'in-progress'] },
];
/** Wide enough that no hero line is cut, narrow enough (~720 px) that GitHub shows it without shrinking the text. */
export const HERO_COLUMNS = 88;

export async function heroScreen(): Promise<TerminalScreen> {
  const runs = await runDemo(HERO_STEPS);
  return {
    label: 'Four Claude Code tabs named lead, api, web and data. In the lead tab, the lead adds a task for api and one for web, and tells web its task is ready. In the web tab, web reads that note and starts its task.',
    tabs: ['lead', 'api', 'web', 'data'].map((label) => ({ label, active: label === 'lead' })),
    panes: [
      { title: 'lead: a Claude Code session; Claude runs these commands', lines: paneLines(runsOf(runs, 'lead')) },
      { title: 'web: another Claude Code session', lines: paneLines(runsOf(runs, 'web')) },
    ],
    layout: 'stacked',
  };
}

export async function drawPictures(): Promise<Picture[]> {
  return [
    { file: 'wordmark.svg', svg: renderWordmark() },
    { file: 'hero.svg', svg: renderTerminal(await heroScreen(), HERO_COLUMNS) },
  ];
}

const pathOf = (root: string, picture: Picture): string => join(root, IMAGES_DIR, picture.file);
const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** The pictures whose file under `root` is missing or differs from a fresh drawing, as repo paths. */
export function stalePictures(root: string, pictures: readonly Picture[]): string[] {
  return pictures.filter((picture) => readOrNull(pathOf(root, picture)) !== picture.svg).map((picture) => `${IMAGES_DIR}/${picture.file}`);
}

/** Writes every picture under `root`; returns the repo paths written. */
export function writePictures(root: string, pictures: readonly Picture[]): string[] {
  mkdirSync(join(root, IMAGES_DIR), { recursive: true });
  for (const picture of pictures) writeFileSync(pathOf(root, picture), picture.svg);
  return pictures.map((picture) => `${IMAGES_DIR}/${picture.file}`);
}
