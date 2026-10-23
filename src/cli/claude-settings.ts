import { join } from 'node:path';
import { formatConfig, writeConfigWithBackup } from '../config/load.ts';
import { errorMessage, isRecord, type JsonRecord } from '../core/guards.ts';
import { claudeConfigDir, resolveKitHome } from '../core/home.ts';
import type { Checked } from '../setup/team-create.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The person's own Claude Code user settings (`<Claude Code folder>/settings.json`), as the commands that change them
 * read and write them: a missing file reads as empty and one that is not a JSON object is refused before anything is
 * written; a write keeps the old file in the kit's backups folder first.
 */

/** The backup name of Claude Code's settings before a change. */
const SETTINGS_BACKUP_NAME = 'claude-settings';

/** Where the settings live on this machine, and where their old copy is kept. */
export interface SettingsTarget {
  readonly settingsPath: string;
  readonly backupsDir: string;
}

export interface ClaudeSettings {
  readonly json: JsonRecord;
  readonly exists: boolean;
}

export function settingsTargetOf(runtime: CliRuntime): SettingsTarget {
  return {
    settingsPath: join(claudeConfigDir(runtime.env, runtime.userHome), 'settings.json'),
    backupsDir: join(resolveKitHome(runtime.env, runtime.userHome), 'backups'),
  };
}

/** Claude Code's user settings; a missing file reads as empty, one that is not a JSON object is refused. */
export async function readClaudeSettings(runtime: CliRuntime, path: string): Promise<ClaudeSettings> {
  const text = await runtime.files.read(path);
  if (text === undefined) {
    return { json: {}, exists: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RefusedError(`${path} is not valid JSON (${errorMessage(error)}); nothing written`);
  }
  if (!isRecord(raw)) {
    throw new RefusedError(`${path} is not a JSON object; nothing written`);
  }
  return { json: raw, exists: true };
}

/** Writes the settings, keeping the old file first when there was one; returns where it was kept. */
export async function writeClaudeSettings(runtime: CliRuntime, target: SettingsTarget, settings: ClaudeSettings, next: JsonRecord): Promise<string | undefined> {
  if (!settings.exists) {
    await runtime.files.write(target.settingsPath, formatConfig(next));
    return undefined;
  }
  const config = { configPath: target.settingsPath, backupsDir: target.backupsDir, backupName: SETTINGS_BACKUP_NAME };
  return writeConfigWithBackup(runtime.files, config, next, runtime.clock);
}

/** A planned change's value, or the plan's problem as a refusal. */
export function checked<T>(result: Checked<T>): T {
  if (!result.ok) {
    throw new RefusedError(result.problem);
  }
  return result.value;
}
