import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Clock } from '../core/lock.ts';
import { formatUtcMinute } from '../core/time.ts';
import { CONFIG_MIGRATIONS, type ConfigMigration } from './migrate.ts';
import { parseConfigText, type ConfigRead, type PendingMigration } from './text.ts';
import { CONFIG_VERSION } from './types.ts';

/** What reading the config file gave: `missing`, or its parse (`parseConfigText`) with the path it was read from. */
export type ConfigLoad = { readonly status: 'missing'; readonly path: string } | (ConfigRead & { readonly path: string });

/** Reads, migrates in memory and validates the config file. Never writes. */
export async function loadConfig(
  files: Files,
  path: string,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
  target: number = CONFIG_VERSION,
): Promise<ConfigLoad> {
  const text = await files.read(path);
  if (text === undefined) {
    return { status: 'missing', path };
  }
  return { ...parseConfigText(text, migrations, target), path };
}

/**
 * Writes a pending migration: first a backup of the original file (`config.v<N>.json`, or with a
 * timestamp when that name is taken), then the migrated config, atomically. Returns the backup path.
 */
export async function writeMigration(
  files: Files,
  configPath: string,
  backupsDir: string,
  pending: PendingMigration,
  clock: Clock,
): Promise<string> {
  const original = await files.read(configPath);
  if (original === undefined) {
    throw new Error(`${configPath} disappeared before the migration could be written`);
  }
  const plain = join(backupsDir, `config.v${pending.fromVersion}.json`);
  const backup = (await files.createExclusive(plain, original))
    ? plain
    : await backupWithStamp(files, backupsDir, pending.fromVersion, original, clock);
  await files.write(configPath, formatConfig(pending.migrated));
  return backup;
}

async function backupWithStamp(
  files: Files,
  backupsDir: string,
  version: number,
  original: string,
  clock: Clock,
): Promise<string> {
  const stamp = formatUtcMinute(new Date(clock.now())).replace(/[-: ]/g, '');
  for (let attempt = 0; ; attempt += 1) {
    const path = join(backupsDir, `config.v${version}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`);
    if (await files.createExclusive(path, original)) {
      return path;
    }
  }
}

/** The kit's on-disk JSON style: two-space indent and a final newline. */
export function formatConfig(config: JsonRecord): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
