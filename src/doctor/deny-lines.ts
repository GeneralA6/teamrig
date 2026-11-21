import type { Files } from '../core/files.ts';
import type { HostPermissions } from '../ports/host/index.ts';
import { jsonObjectOf } from './settings-env.ts';

/**
 * The deny lines that keep a session's tools off the well-known credential homes come from the host
 * (`HostPermissions.denyLines`). A deny line beats any hook's allow and the host's automatic approval, so it holds where
 * a read-only allow hook would approve `cat` of a secret file. teamrig never writes permissions: doctor and `check`
 * print the missing ones for the user to paste.
 */

/**
 * A host settings file, as `readSettingsDeny` finds it: `deny` holds the texts of its deny list (empty when it has
 * none), `unreadable` is a file that is not a JSON object, so its lines could not be read.
 */
export type SettingsDeny =
  | { readonly kind: 'deny'; readonly path: string; readonly deny: readonly string[] }
  | { readonly kind: 'unreadable'; readonly path: string };

async function readOne(permissions: HostPermissions, files: Files, path: string): Promise<SettingsDeny | undefined> {
  const text = await files.read(path);
  if (text === undefined) {
    return undefined;
  }
  const settings = jsonObjectOf(text);
  if (settings === undefined) {
    return { kind: 'unreadable', path };
  }
  return { kind: 'deny', path, deny: permissions.read(settings).deny };
}

/** The deny lines of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsDeny(permissions: HostPermissions, files: Files, paths: readonly string[]): Promise<SettingsDeny[]> {
  const read = await Promise.all(paths.map((path) => readOne(permissions, files, path)));
  return read.filter((settings): settings is SettingsDeny => settings !== undefined);
}

/**
 * The secret deny `lines` (the host's lines for the platform) no readable file holds, word for word (spaces at either
 * end aside), in their order. A deny line in any settings file a session reads applies to it, so the files count as
 * one list.
 */
export function missingDenyLines(read: readonly SettingsDeny[], lines: readonly string[]): string[] {
  const held = new Set(read.flatMap((settings) => (settings.kind === 'deny' ? settings.deny.map((rule) => rule.trim()) : [])));
  return lines.filter((line) => !held.has(line));
}
