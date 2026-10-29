import { join } from 'node:path';
import { taskFolder } from '../core/home.ts';
import type { CliRuntime } from './runtime.ts';

/** The most entries `show`'s files line names before it counts the rest. */
export const FILES_LINE_MAX_NAMES = 12;

/**
 * `show`'s files line (T1457): the folder of a task's files in the team whose register holds it, and what it holds,
 * a folder marked with a slash, so a session finds a task's design and evidence without searching; `none yet` while
 * it is empty or missing. It only reads: `teamrig files` makes the folder.
 */
export async function taskFilesLine(runtime: CliRuntime, kitHome: string, team: string, id: string): Promise<string> {
  const folder = taskFolder(kitHome, team, id);
  const names = (await runtime.files.list(folder)).sort();
  if (names.length === 0) {
    return `files in ${folder}: none yet`;
  }
  const shown = await Promise.all(
    names.slice(0, FILES_LINE_MAX_NAMES).map(async (name) => ((await runtime.probe.kind(join(folder, name))) === 'folder' ? `${name}/` : name)),
  );
  const more = names.length - shown.length;
  return `files in ${folder}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}
