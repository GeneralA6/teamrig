import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS_COLUMNS, commandsScreen } from './commands-screen.ts';
import { renderGrowth } from './growth.ts';
import { renderHero } from './hero.ts';
import { renderHowItWorks } from './how-it-works.ts';
import { renderLeadMeeting } from './lead-meeting.ts';
import { renderLeadMorning } from './lead-morning.ts';
import { renderPlan } from './plan.ts';
import { renderReboot } from './reboot.ts';
import { renderSkill } from './skill.ts';
import { renderTaskFlow } from './task-flow.ts';
import { renderTerminalView } from './terminal-view.ts';
import { renderTerminal } from './terminal-svg.ts';
import { renderWhy } from './why.ts';
import { renderWordmark } from './wordmark.ts';

/**
 * The docs' pictures, all drawn in code: the README's wordmark, hero, how-it-works, task-flow, lead-morning, why,
 * terminal view, lead-meeting, plan, skill, reboot and growth pictures, in the README's order, and the commands doc's terminal
 * screen, drawn from a demo run of the real CLI (demo.ts). A change to a drawing, or to what the CLI prints, changes a picture, and
 * `images-cli.ts --check` fails until it is redrawn.
 */

export const IMAGES_DIR = 'docs/images';

export interface Picture {
  /** The file name under IMAGES_DIR. */
  readonly file: string;
  readonly svg: string;
}

export async function drawPictures(): Promise<Picture[]> {
  return [
    { file: 'wordmark.svg', svg: renderWordmark() },
    { file: 'hero.svg', svg: renderHero() },
    { file: 'how-it-works.svg', svg: renderHowItWorks() },
    { file: 'task-flow.svg', svg: renderTaskFlow() },
    { file: 'lead-morning.svg', svg: renderLeadMorning() },
    { file: 'why.svg', svg: renderWhy() },
    { file: 'terminal-view.svg', svg: renderTerminalView() },
    { file: 'lead-meeting.svg', svg: renderLeadMeeting() },
    { file: 'plan.svg', svg: renderPlan() },
    { file: 'skill.svg', svg: renderSkill() },
    { file: 'reboot.svg', svg: renderReboot() },
    { file: 'growth.svg', svg: renderGrowth() },
    { file: 'commands.svg', svg: renderTerminal(await commandsScreen(), COMMANDS_COLUMNS) },
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
