import type { Files } from '../core/files.ts';
import { isRecord, recordField } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import type { HostPaths } from '../ports/host/index.ts';

/**
 * A Claude Code settings file, as `readSettingsEnv` finds it: `env` holds its `env` block (empty when it has
 * none), `unreadable` is a file that is not a JSON object, so its block could not be read.
 */
export type SettingsEnv =
  | { readonly kind: 'env'; readonly path: string; readonly env: Env }
  | { readonly kind: 'unreadable'; readonly path: string };

/** Where the host keeps the settings one person's session reads: its paths, and the home folder of that person. */
export interface SessionSettingsHost {
  readonly paths: Pick<HostPaths, 'userSettings' | 'folderSettings'>;
  readonly userHome: string;
}

/**
 * The settings files a session started in `project` reads, in the order the host reads them: the person's own, then
 * the project folder's. A project folder whose file is the person's own lists that file once.
 */
export function sessionSettingsFiles({ paths, userHome }: SessionSettingsHost, project: string): string[] {
  return [...new Set([paths.userSettings(userHome), ...paths.folderSettings(project).map((file) => file.path)])];
}

/** The text as a JSON object, or undefined when it is not one; a leading byte order mark is skipped. */
export function jsonObjectOf(text: string): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A variable's value as text: a string as it is, a number or a true/false as written; anything else is no value. */
function envValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

async function readOne(files: Files, path: string): Promise<SettingsEnv | undefined> {
  const text = await files.read(path);
  if (text === undefined) {
    return undefined;
  }
  const settings = jsonObjectOf(text);
  if (settings === undefined) {
    return { kind: 'unreadable', path };
  }
  const block = Object.entries(recordField(settings, 'env') ?? {}).flatMap(([name, value]): [string, string][] => {
    const written = envValue(value);
    return written === undefined ? [] : [[name, written]];
  });
  return { kind: 'env', path, env: Object.fromEntries(block) };
}

/** The `env` block of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsEnv(files: Files, paths: readonly string[]): Promise<SettingsEnv[]> {
  const read = await Promise.all(paths.map((path) => readOne(files, path)));
  return read.filter((settings): settings is SettingsEnv => settings !== undefined);
}
