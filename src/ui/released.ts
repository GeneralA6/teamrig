/**
 * The released UI on this machine (T4761): the archive a pin names, fetched once, held to the pin's sha256 before a
 * byte of it is parsed, written under the kit home and found there from then on. Nothing it fetches is run or
 * written unless its hash is the pinned one.
 */
import type { Files } from '../core/files.ts';
import type { HttpClient } from '../core/http.ts';
import { readArchive } from './archive.ts';
import { fetchArchive } from './fetch.ts';
import { installArchive, installedEntry, uiFolder } from './install.ts';

/** One released UI: its version, the https address of its archive and the sha256 of that file's bytes. */
export interface UiPin {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export interface ReleasedDeps {
  readonly files: Files;
  readonly http: HttpClient;
}

/** The entry script to start, and whether this call fetched it; or why there is none, in words for the person. */
export type ReleasedUi = { readonly ok: true; readonly entry: string; readonly fetched: boolean } | { readonly ok: false; readonly reason: string };

/**
 * The entry script of the UI `pin` names, under the kit home `home`. An installed one is answered with no request;
 * otherwise the archive is fetched, read against the pin and written. An archive of another version than the pin's
 * is refused even when its hash is right: the folder it is written into is the pin's version.
 */
export async function releasedEntry(deps: ReleasedDeps, home: string, pin: UiPin): Promise<ReleasedUi> {
  const folder = uiFolder(home, pin.version);
  const installed = await installedEntry(deps.files, folder, pin.sha256);
  if (installed !== undefined) return { ok: true, entry: installed, fetched: false };

  const fetched = await fetchArchive(deps.http, pin.url);
  if (!fetched.ok) return { ok: false, reason: `the UI ${pin.version} could not be fetched: ${fetched.reason}` };
  const read = readArchive(fetched.bytes, pin.sha256);
  if (!read.ok) return { ok: false, reason: `the fetched UI ${pin.version} was refused: ${read.reason}` };
  if (read.archive.version !== pin.version) {
    return { ok: false, reason: `the fetched UI was refused: it is version ${read.archive.version}, not the pinned ${pin.version}` };
  }
  return { ok: true, entry: await installArchive(deps.files, folder, read.archive, pin.sha256), fetched: true };
}
