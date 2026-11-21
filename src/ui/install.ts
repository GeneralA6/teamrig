/**
 * Where a read archive of the dedicated UI lives on this machine (T4761): its files written under one folder of the
 * kit home, `ui/<version>`, and a mark written last that names the archive they came from. A folder counts as
 * installed only by its mark, so a write that stopped partway is written again, never started. The archive given
 * here is one `readArchive` answered: every path in it is already known to stay under the folder.
 */
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';
import { isArchivePath, type UiArchive } from './archive.ts';

/** The mark's file name. No archive path starts with a dot, so no file of an archive can be written over it. */
export const INSTALLED_MARK = '.installed';

/** What the mark holds: the archive's sha256 and its entry. */
interface Mark {
  readonly sha256: string;
  readonly entry: string;
}

/** The folder the UI of `version` is written into, under the kit home. */
export function uiFolder(home: string, version: string): string {
  return join(home, 'ui', version);
}

function pathIn(folder: string, path: string): string {
  return join(folder, ...path.split('/'));
}

function markOf(text: string | undefined): Mark | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { sha256, entry } = value;
  return typeof sha256 === 'string' && typeof entry === 'string' && isArchivePath(entry) ? { sha256, entry } : undefined;
}

/**
 * The entry script of the UI installed in `folder` from the archive whose sha256 is `pin`, undefined when the folder
 * holds none, another archive's files, a write that never finished, or no entry script any more.
 */
export async function installedEntry(files: Files, folder: string, pin: string): Promise<string | undefined> {
  const mark = markOf(await files.read(join(folder, INSTALLED_MARK)));
  if (mark === undefined || mark.sha256 !== pin.toLowerCase()) return undefined;
  const entry = pathIn(folder, mark.entry);
  return (await files.size(entry)) === undefined ? undefined : entry;
}

/**
 * Writes `archive` (the one whose sha256 is `pin`) into `folder` and answers its entry script. The old mark goes
 * first and the new one is written last, so whatever stops the write leaves a folder that reads as not installed.
 */
export async function installArchive(files: Files, folder: string, archive: UiArchive, pin: string): Promise<string> {
  const mark = join(folder, INSTALLED_MARK);
  await files.remove(mark);
  for (const file of archive.files) {
    await files.write(pathIn(folder, file.path), file.text);
  }
  const held: Mark = { sha256: pin.toLowerCase(), entry: archive.entry };
  await files.write(mark, `${JSON.stringify(held)}\n`);
  return pathIn(folder, archive.entry);
}
