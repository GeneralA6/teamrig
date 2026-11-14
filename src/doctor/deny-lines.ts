import type { Files } from '../core/files.ts';
import { recordField } from '../core/guards.ts';
import { jsonObjectOf } from './settings-env.ts';

/**
 * The `permissions.deny` lines that keep a session's tools off the well-known credential homes. A deny line beats any
 * hook's allow and auto mode's classifier, so it holds where a read-only allow hook would approve `cat` of a secret
 * file. teamrig never writes permissions: doctor and `check` print the missing ones for the user to paste.
 *
 * Verified with canaries on Claude Code 2.1.303 (10-19, skill security-deny-verify): each of the first eleven refuses
 * its call; a Read deny also refuses Write and Edit of the path, and Grep skips the file. The rest are the same rule
 * forms on other paths. A rule ending in `:*` is the legacy prefix form, so `PowerShell(Get-ChildItem env:*)` misses
 * `Get-ChildItem env:X`; `env*` matches both. gh's line names its hosts file where gh keeps it on the platform
 * (`ghHostsDenyLine`); the space in `GitHub CLI` was proven on Claude Code 2.1.318 (11-05, T662).
 */
export function secretDenyLines(platform: NodeJS.Platform): readonly string[] {
  return [...SHARED_DENY_LINES, ghHostsDenyLine(platform), ...KEY_DENY_LINES];
}

/**
 * gh's hosts file, which names the account and can hold its token: under the roaming app data folder on Windows,
 * under `~/.config/gh` elsewhere. A team is told only its own platform's line (T2038: the Linux line alone guarded
 * nothing on Windows).
 */
export function ghHostsDenyLine(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Read(~/AppData/Roaming/GitHub CLI/hosts.yml)' : 'Read(~/.config/gh/hosts.yml)';
}

const SHARED_DENY_LINES: readonly string[] = [
  'Read(//**/secrets.yaml)',
  'Read(//**/.env)',
  'Read(~/.npmrc)',
  'Bash(kubectl *get*secret*)',
  'Bash(kubectl exec *printenv*)',
  'Bash(kubectl exec *-- env*)',
  'Bash(env)',
  'Bash(printenv*)',
  'PowerShell(Get-Content *secrets.yaml*)',
  'PowerShell(Get-Content *.env*)',
  'PowerShell(Get-ChildItem env*)',
  'Read(~/.ssh/id_*)',
  'Read(~/.aws/credentials)',
  'Read(~/.kube/config)',
  'Read(~/.docker/config.json)',
  'Read(~/.git-credentials)',
];

/** Claude Code's own login (T2007 found no line for it), then the key stores. */
const KEY_DENY_LINES: readonly string[] = ['Read(~/.claude/.credentials.json)', 'Read(//**/*.pem)', 'Read(//**/*.key)'];

/**
 * A Claude Code settings file, as `readSettingsDeny` finds it: `deny` holds the strings of its `permissions.deny` list
 * (empty when it has none), `unreadable` is a file that is not a JSON object, so its lines could not be read.
 */
export type SettingsDeny =
  | { readonly kind: 'deny'; readonly path: string; readonly deny: readonly string[] }
  | { readonly kind: 'unreadable'; readonly path: string };

async function readOne(files: Files, path: string): Promise<SettingsDeny | undefined> {
  const text = await files.read(path);
  if (text === undefined) {
    return undefined;
  }
  const settings = jsonObjectOf(text);
  if (settings === undefined) {
    return { kind: 'unreadable', path };
  }
  const list = recordField(settings, 'permissions')?.['deny'];
  const deny = Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string') : [];
  return { kind: 'deny', path, deny };
}

/** The `permissions.deny` lines of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsDeny(files: Files, paths: readonly string[]): Promise<SettingsDeny[]> {
  const read = await Promise.all(paths.map((path) => readOne(files, path)));
  return read.filter((settings): settings is SettingsDeny => settings !== undefined);
}

/**
 * The secret deny `lines` (the platform's `secretDenyLines`) no readable file holds, word for word (spaces at either end
 * aside), in their order. A deny line in any settings file a session reads applies to it, so the files count as one list.
 */
export function missingDenyLines(read: readonly SettingsDeny[], lines: readonly string[]): string[] {
  const held = new Set(read.flatMap((settings) => (settings.kind === 'deny' ? settings.deny.map((rule) => rule.trim()) : [])));
  return lines.filter((line) => !held.has(line));
}
