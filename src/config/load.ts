import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Clock } from '../core/lock.ts';
import { formatUtcMinute } from '../core/time.ts';
import { CONFIG_MIGRATIONS, type ConfigMigration } from './migrate.ts';
import { parseConfigText, type ConfigRead, type PendingMigration } from './text.ts';
import { CONFIG_VERSION, type AccountBudget, type KitConfig } from './types.ts';

/** What reading the config file gave: `missing`, or its parse (`parseConfigText`) with the path it was read from. */
export type ConfigLoad = { readonly status: 'missing'; readonly path: string } | (ConfigRead & { readonly path: string });

/**
 * The budget keys of the account's week a team's config takes from the team above (`AccountBudget`), given the config
 * as it reads alone; undefined for a team with none above it.
 */
export type BudgetAbove = (own: KitConfig) => Promise<AccountBudget | undefined>;

/**
 * Reads, migrates in memory and validates the config file, reading it again over `above`'s keys when it has a team
 * above. Never writes.
 */
export async function loadConfig(
  files: Files,
  path: string,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
  target: number = CONFIG_VERSION,
  above?: BudgetAbove,
): Promise<ConfigLoad> {
  const text = await files.read(path);
  if (text === undefined) {
    return { status: 'missing', path };
  }
  const own = parseConfigText(text, migrations, target);
  const inherited = own.status === 'loaded' && above !== undefined ? await above(own.config) : undefined;
  return { ...(inherited === undefined ? own : parseConfigText(text, migrations, target, inherited)), path };
}

/** The name a migration's backup starts with: `config.v<N>`, N the version it migrated from. */
export function migrationBackupName(pending: PendingMigration): string {
  return `config.v${pending.fromVersion}`;
}

/** Where a config change is written, and the name its backup starts with (`config.v1` keeps `config.v1.json`). */
export interface ConfigTarget {
  readonly configPath: string;
  readonly backupsDir: string;
  readonly backupName: string;
}

/**
 * Replaces the config file with `config`: first a backup of the original (`<backupName>.json`, or with a
 * timestamp when that name is taken), then the new file, atomically. Returns the backup path. A team's config is
 * written only through its lock (`ConfigLock`, config-lock.ts); this is called directly for other JSON files only,
 * such as Claude Code's settings.
 */
export async function writeConfigWithBackup(files: Files, target: ConfigTarget, config: JsonRecord, clock: Clock): Promise<string> {
  const original = await files.read(target.configPath);
  if (original === undefined) {
    throw new Error(`${target.configPath} disappeared before the change could be written`);
  }
  const plain = join(target.backupsDir, `${target.backupName}.json`);
  const backup = (await files.createExclusive(plain, original)) ? plain : await backupWithStamp(files, target, original, clock);
  await files.write(target.configPath, formatConfig(config));
  return backup;
}

async function backupWithStamp(files: Files, target: ConfigTarget, original: string, clock: Clock): Promise<string> {
  const stamp = formatUtcMinute(new Date(clock.now())).replace(/[-: ]/g, '');
  for (let attempt = 0; ; attempt += 1) {
    const path = join(target.backupsDir, `${target.backupName}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`);
    if (await files.createExclusive(path, original)) {
      return path;
    }
  }
}

/** The kit's on-disk JSON style: two-space indent and a final newline. */
export function formatConfig(config: JsonRecord): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
