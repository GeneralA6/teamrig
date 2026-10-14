import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CONFIG_VERSION } from './types.ts';

export interface MigrationStep {
  readonly config: JsonRecord;
  /** One human-readable line per change, printed when the migration is written. */
  readonly changes: readonly string[];
}

/** One step of the chain. It must be pure and pass every key it does not own through unchanged. */
export interface ConfigMigration {
  /** The version this step reads; it produces `from + 1`. */
  readonly from: number;
  apply(config: JsonRecord): MigrationStep;
}

/** v1 to v2: the priority levels moved from `register.tiers` to `register.priorities`, same entries. */
export const RENAME_TIERS_TO_PRIORITIES: ConfigMigration = {
  from: 1,
  apply: (config) => {
    const register = config['register'];
    if (!isRecord(register) || !('tiers' in register)) {
      return { config, changes: [] };
    }
    const { tiers, ...rest } = register;
    return { config: { ...config, register: { ...rest, priorities: tiers } }, changes: ['register.tiers → register.priorities'] };
  },
};

/** The shipped chain, in order: each step reads `from` and produces `from + 1`. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [RENAME_TIERS_TO_PRIORITIES];

/** The config format a release reads and writes: its version and the migration chain that reaches it. */
export interface ConfigFormat {
  readonly version: number;
  readonly migrations: readonly ConfigMigration[];
}

/** This release's format. */
export const SHIPPED_CONFIG_FORMAT: ConfigFormat = { version: CONFIG_VERSION, migrations: CONFIG_MIGRATIONS };

export type MigrationResult =
  | { readonly kind: 'current'; readonly config: JsonRecord; readonly version: number }
  | {
      readonly kind: 'migrated';
      readonly config: JsonRecord;
      readonly fromVersion: number;
      readonly version: number;
      readonly changes: readonly string[];
    }
  /** Written by a newer release; this code may read it best-effort but must never write it. */
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'invalid'; readonly message: string };

/** A file without `configVersion` is the first format, so a minimal hand-written config works. */
export const FIRST_CONFIG_VERSION = 1;

export function migrateConfig(
  raw: JsonRecord,
  target: number = CONFIG_VERSION,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
): MigrationResult {
  const declared = raw['configVersion'];
  const version = declared === undefined ? FIRST_CONFIG_VERSION : declared;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < FIRST_CONFIG_VERSION) {
    return { kind: 'invalid', message: `configVersion: expected a positive integer, got ${JSON.stringify(declared)}` };
  }
  if (version > target) {
    return { kind: 'newer', version };
  }
  let config = raw;
  const changes: string[] = [];
  for (let from = version; from < target; from += 1) {
    const step = migrations.find((migration) => migration.from === from);
    if (step === undefined) {
      throw new Error(`no config migration from version ${from}; the shipped chain is incomplete`);
    }
    const result = step.apply(config);
    config = { ...result.config, configVersion: from + 1 };
    changes.push(...result.changes.map((change) => `v${from}→v${from + 1}: ${change}`));
  }
  return version === target
    ? { kind: 'current', config, version }
    : { kind: 'migrated', config, fromVersion: version, version: target, changes };
}
