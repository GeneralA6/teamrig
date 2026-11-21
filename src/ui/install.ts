/**
 * Where a read archive of the dedicated UI lives on this machine (T4761): one folder of the kit home per pin,
 * `ui/<version>-<sha256>`, holding the archive's files and a mark, `.installed`, that is the archive's own text.
 *
 * The folder is written whole into a staging folder beside it and moved into place last, so it is either there with
 * every file or not there at all: a write that stops partway, or two starts at once, never leave a mixed folder under
 * the pinned name. Each start then reads the folder again: the mark must still hash to the pin, which comes from
 * teamrig's source, and every file must be the archive's text, with none missing and none added. A folder edited after
 * its install is refused, never run. The archive given here is one `readArchive` answered: every path in it is already
 * known to stay under the folder.
 */
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { readArchive, type UiArchive } from './archive.ts';

/** The mark's file name. No archive path starts with a dot, so no file of an archive can be written over it. */
export const INSTALLED_MARK = '.installed';

/** What a pin's folder holds: nothing yet, the pinned UI as it was installed, or files changed since. */
export type Installed =
  | { readonly state: 'none' }
  | { readonly state: 'ok'; readonly entry: string }
  | { readonly state: 'changed'; readonly reason: string };

/** The folder the UI of `version` pinned to `pin` is installed in, under the kit home. */
export function uiFolder(home: string, version: string, pin: string): string {
  return join(home, 'ui', `${version}-${pin.toLowerCase()}`);
}

/** A staging folder beside the installed ones, named by `nonce` so two starts at once never share one. */
export function stagingFolder(home: string, nonce: string): string {
  return join(home, 'ui', `.staging-${nonce}`);
}

function pathIn(folder: string, path: string): string {
  return join(folder, ...path.split('/'));
}

/** Every file under `folder`, as `/`-separated paths from it. A name with no size is a folder, read in turn. */
async function filesUnder(files: Files, folder: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const name of await files.list(folder)) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const full = join(folder, name);
    if ((await files.size(full)) === undefined) found.push(...(await filesUnder(files, full, path)));
    else found.push(path);
  }
  return found;
}

/**
 * What the folder of `pin` holds now. The mark is read and held to the pin as a fetched archive is, then every file
 * the archive names is compared to its text and every file found is held to the archive's list.
 */
export async function installedEntry(files: Files, folder: string, pin: string): Promise<Installed> {
  const mark = await files.read(join(folder, INSTALLED_MARK));
  if (mark === undefined) {
    return (await files.list(folder)).length === 0 ? { state: 'none' } : { state: 'changed', reason: `its mark ${INSTALLED_MARK} is missing` };
  }
  const read = readArchive(new TextEncoder().encode(mark), pin);
  if (!read.ok) return { state: 'changed', reason: `its mark ${INSTALLED_MARK} is not the pinned archive: ${read.reason}` };

  const named = new Set<string>([INSTALLED_MARK]);
  for (const file of read.archive.files) {
    named.add(file.path);
    const text = await files.read(pathIn(folder, file.path));
    if (text === undefined) return { state: 'changed', reason: `${file.path} is missing` };
    if (text !== file.text) return { state: 'changed', reason: `${file.path} was changed` };
  }
  const extra = (await filesUnder(files, folder)).find((path) => !named.has(path));
  if (extra !== undefined) return { state: 'changed', reason: `${extra} is not one of its files` };
  return { state: 'ok', entry: pathIn(folder, read.archive.entry) };
}

/**
 * Writes `archive`, read from the archive text `source`, into `staging`, the mark last, then moves the whole folder to
 * `folder` and answers its entry script. When any step fails, the files written to `staging` are removed and the
 * error is thrown: `folder` is never written in place, and a move never replaces a folder already there.
 */
export async function installArchive(files: Files, folder: string, staging: string, archive: UiArchive, source: string): Promise<string> {
  const written: string[] = [];
  try {
    for (const file of archive.files) {
      const path = pathIn(staging, file.path);
      written.push(path);
      await files.write(path, file.text);
    }
    const mark = join(staging, INSTALLED_MARK);
    written.push(mark);
    await files.write(mark, source);
    await files.move(staging, folder);
  } catch (error) {
    // A file that cannot be removed now stays in a staging folder nothing reads; the write's own error is the one to tell.
    for (const path of written) await files.remove(path).catch(() => false);
    throw error;
  }
  return pathIn(folder, archive.entry);
}
