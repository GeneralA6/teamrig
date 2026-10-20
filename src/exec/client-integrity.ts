import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, recordField } from '../core/guards.ts';
import { sha256Hex } from './digest.ts';

/**
 * The client pin (T755, spec §2.2, phase 1): the build lists a hash of every file of the plugin's client, and the exec
 * guard checks the installed plugin against that list before a `teamrig exec` call runs, so a session that edited the
 * installed client by hand (a hot patch) runs no request through it. The list sits beside the code it lists, so it
 * stops a slip, not a session set on getting around it: phase 2 makes the install read-only to agent accounts.
 */

/** The plugin folders whose files make the client: its launchers, its compiled code and the hooks that guard it. */
export const CLIENT_FOLDERS: readonly string[] = ['bin', 'dist', 'hooks'];

/** Where the build writes the list, relative to the plugin root; the list never lists itself. */
export const CLIENT_MANIFEST = 'dist/integrity.json';

/** Each client file by its path from the plugin root (with `/`), to its hash. */
export type ClientManifest = ReadonlyMap<string, string>;

/** How the installed client compares with its list. */
export type ClientCheck =
  | { readonly kind: 'intact' }
  | { readonly kind: 'no-manifest'; readonly why: string }
  /** The files whose text is not the text the build hashed, missing ones too, by path. */
  | { readonly kind: 'changed'; readonly paths: readonly string[] };

/** The hash of one client file's text, with CRLF read as LF: a checkout's line endings never count as a change. */
export function clientFileHash(text: string): string {
  return sha256Hex(text.replace(/\r\n/g, '\n'));
}

/** The list as the build writes it: one key per file, sorted, so a rebuild of unchanged code writes the same text. */
export function clientManifestText(manifest: ClientManifest): string {
  const files = Object.fromEntries([...manifest].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

/** The list a manifest text holds, or undefined when it is not one. */
export function parseClientManifest(text: string): ClientManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const files = isRecord(value) ? recordField(value, 'files') : undefined;
  if (files === undefined) {
    return undefined;
  }
  const entries = Object.entries(files);
  if (entries.length === 0) {
    return undefined;
  }
  const manifest = new Map<string, string>();
  for (const [path, hash] of entries) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      return undefined;
    }
    manifest.set(path, hash);
  }
  return manifest;
}

/** Checks the client installed at `pluginRoot` against the list the build wrote there. It never throws. */
export async function checkClient(pluginRoot: string, files: Pick<Files, 'read'>): Promise<ClientCheck> {
  const text = await files.read(join(pluginRoot, CLIENT_MANIFEST)).catch(() => undefined);
  if (text === undefined) {
    return { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is missing` };
  }
  const manifest = parseClientManifest(text);
  if (manifest === undefined) {
    return { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is not a list of file hashes` };
  }
  const changed: string[] = [];
  for (const [path, hash] of manifest) {
    const current = await files.read(join(pluginRoot, path)).catch(() => undefined);
    if (current === undefined || clientFileHash(current) !== hash) {
      changed.push(path);
    }
  }
  return changed.length === 0 ? { kind: 'intact' } : { kind: 'changed', paths: changed };
}
