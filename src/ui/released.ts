/**
 * The released UI on this machine (T4761): the archive a pin names, fetched once, held to the pin's sha256 before a
 * byte of it is parsed, installed under the kit home and held to that pin again at each start. Nothing it fetches is
 * run or written unless its hash is the pinned one, and an installed folder changed since is refused, never run.
 */
import type { Files } from '../core/files.ts';
import type { HttpClient } from '../core/http.ts';
import { readArchive } from './archive.ts';
import { fetchArchive } from './fetch.ts';
import { installArchive, installedEntry, stagingFolder, uiFolder } from './install.ts';

/**
 * One released UI: its version, the https address of its archive and the sha256 of that file's bytes. Only a
 * constant of teamrig's source names one (`RELEASED_UI` in pin.ts), never the team config a session can edit.
 */
export interface UiPin {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export interface ReleasedDeps {
  readonly files: Files;
  readonly http: HttpClient;
  /** A name no other start uses at the same time, for this start's staging folder. */
  readonly nonce: () => string;
}

/** The entry script to start, and whether this call fetched it; or why there is none, in words for the person. */
export type ReleasedUi = { readonly ok: true; readonly entry: string; readonly fetched: boolean } | { readonly ok: false; readonly reason: string };

function changed(folder: string, pin: UiPin, reason: string): ReleasedUi {
  return { ok: false, reason: `the installed UI ${pin.version} in ${folder} was changed after its install (${reason}); remove that folder to fetch it again` };
}

/**
 * The entry script of the UI `pin` names, under the kit home `home`. An installed one that still holds the pinned
 * files is answered with no request; one changed since is refused. Otherwise the archive is fetched, read against the
 * pin and installed. An archive of another version than the pin's is refused even when its hash is right: the folder
 * it is written into is named by the pin's version.
 */
export async function releasedEntry(deps: ReleasedDeps, home: string, pin: UiPin): Promise<ReleasedUi> {
  const folder = uiFolder(home, pin.version, pin.sha256);
  const installed = await installedEntry(deps.files, folder, pin.sha256);
  if (installed.state === 'ok') return { ok: true, entry: installed.entry, fetched: false };
  if (installed.state === 'changed') return changed(folder, pin, installed.reason);

  const fetched = await fetchArchive(deps.http, pin.url);
  if (!fetched.ok) return { ok: false, reason: `the UI ${pin.version} could not be fetched: ${fetched.reason}` };
  const read = readArchive(fetched.bytes, pin.sha256);
  if (!read.ok) return { ok: false, reason: `the fetched UI ${pin.version} was refused: ${read.reason}` };
  if (read.archive.version !== pin.version) {
    return { ok: false, reason: `the fetched UI was refused: it is version ${read.archive.version}, not the pinned ${pin.version}` };
  }
  // readArchive took these bytes as UTF-8, so this text writes back as the very bytes the pin names.
  const source = new TextDecoder().decode(fetched.bytes);
  try {
    return { ok: true, entry: await installArchive(deps.files, folder, stagingFolder(home, deps.nonce()), read.archive, source), fetched: true };
  } catch (error) {
    // Another start that moved its folder in first leaves the same pinned files: that one is used. Anything else fails.
    const now = await installedEntry(deps.files, folder, pin.sha256);
    if (now.state === 'ok') return { ok: true, entry: now.entry, fetched: true };
    throw error;
  }
}
