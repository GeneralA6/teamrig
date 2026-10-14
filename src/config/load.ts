import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { errorMessage, isRecord, type JsonRecord } from '../core/guards.ts';
import type { Clock } from '../core/lock.ts';
import { formatUtcMinute } from '../core/time.ts';
import { CONFIG_MIGRATIONS, migrateConfig, type ConfigMigration } from './migrate.ts';
import { parseConfig } from './parse.ts';
import type { ConfigIssue } from './reader.ts';
import { CONFIG_VERSION, type KitConfig } from './types.ts';

export interface PendingMigration {
  readonly fromVersion: number;
  readonly changes: readonly string[];
  /** The migrated object, unknown keys included, ready to be written by `config migrate`. */
  readonly migrated: JsonRecord;
}

export type ConfigLoad =
  | { readonly status: 'missing'; readonly path: string }
  /** Not JSON, not an object, or an unusable `configVersion`: nothing can be read. */
  | { readonly status: 'unreadable'; readonly path: string; readonly issue: ConfigIssue }
  | {
      readonly status: 'loaded';
      readonly path: string;
      readonly config: KitConfig;
      /** Problems that block gated commands; read-only commands still run on the defaults. */
      readonly issues: readonly ConfigIssue[];
      /** Set when a newer release wrote the file: read it best-effort and refuse every write. */
      readonly newerVersion?: number;
      /** Set when the file is older than this code; it has been migrated in memory only. */
      readonly pending?: PendingMigration;
    };

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
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'unreadable', path, issue: { path: '', message: `not valid JSON: ${errorMessage(error)}` } };
  }
  if (!isRecord(raw)) {
    return { status: 'unreadable', path, issue: { path: '', message: 'expected a JSON object at the top level' } };
  }
  const migration = migrateConfig(raw, target, migrations);
  switch (migration.kind) {
    case 'invalid':
      return { status: 'unreadable', path, issue: { path: 'configVersion', message: migration.message } };
    case 'newer': {
      const { config, issues } = parseConfig(raw);
      return { status: 'loaded', path, config, issues, newerVersion: migration.version };
    }
    case 'current': {
      const { config, issues } = parseConfig(migration.config);
      return { status: 'loaded', path, config, issues };
    }
    case 'migrated': {
      const { config, issues } = parseConfig(migration.config);
      const pending = { fromVersion: migration.fromVersion, changes: migration.changes, migrated: migration.config };
      return { status: 'loaded', path, config, issues, pending };
    }
  }
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
