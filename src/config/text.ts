import { errorMessage, isRecord, type JsonRecord } from '../core/guards.ts';
import { CONFIG_MIGRATIONS, migrateConfig, type ConfigMigration } from './migrate.ts';
import { parseConfig } from './parse.ts';
import type { ConfigIssue } from './reader.ts';
import { CONFIG_VERSION, type KitConfig } from './types.ts';

export interface PendingMigration {
  readonly fromVersion: number;
  /** The version `migrated` is in. */
  readonly toVersion: number;
  readonly changes: readonly string[];
  /** The migrated object, unknown keys included, ready to be written by `config migrate`. */
  readonly migrated: JsonRecord;
}

export type ConfigRead =
  /** Not JSON, not an object, or an unusable `configVersion`: nothing can be read. */
  | { readonly status: 'unreadable'; readonly issue: ConfigIssue }
  | {
      readonly status: 'loaded';
      readonly config: KitConfig;
      /** Problems that block gated commands; read-only commands still run on the defaults. */
      readonly issues: readonly ConfigIssue[];
      /** Set when a newer release wrote the file: read it best-effort and refuse every write. */
      readonly newerVersion?: number;
      /** Set when the file is older than this code; it has been migrated in memory only. */
      readonly pending?: PendingMigration;
    };

/** Parses, migrates in memory and validates the text of a config file, the way every teamrig command reads it. */
export function parseConfigText(
  text: string,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
  target: number = CONFIG_VERSION,
): ConfigRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'unreadable', issue: { path: '', message: `not valid JSON: ${errorMessage(error)}` } };
  }
  if (!isRecord(raw)) {
    return { status: 'unreadable', issue: { path: '', message: 'expected a JSON object at the top level' } };
  }
  const migration = migrateConfig(raw, target, migrations);
  switch (migration.kind) {
    case 'invalid':
      return { status: 'unreadable', issue: { path: 'configVersion', message: migration.message } };
    case 'newer': {
      const { config, issues } = parseConfig(raw);
      return { status: 'loaded', config, issues, newerVersion: migration.version };
    }
    case 'current': {
      const { config, issues } = parseConfig(migration.config);
      return { status: 'loaded', config, issues };
    }
    case 'migrated': {
      const { config, issues } = parseConfig(migration.config);
      const pending = { fromVersion: migration.fromVersion, toVersion: migration.version, changes: migration.changes, migrated: migration.config };
      return { status: 'loaded', config, issues, pending };
    }
  }
}
