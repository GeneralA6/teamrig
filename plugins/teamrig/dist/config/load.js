import { join } from 'node:path';
import { errorMessage, isRecord } from "../core/guards.js";
import { formatUtcMinute } from "../core/time.js";
import { CONFIG_MIGRATIONS, migrateConfig } from "./migrate.js";
import { parseConfig } from "./parse.js";
import { CONFIG_VERSION } from "./types.js";
/** Reads, migrates in memory and validates the config file. Never writes. */
export async function loadConfig(files, path, migrations = CONFIG_MIGRATIONS, target = CONFIG_VERSION) {
    const text = await files.read(path);
    if (text === undefined) {
        return { status: 'missing', path };
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
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
            const pending = { fromVersion: migration.fromVersion, toVersion: migration.version, changes: migration.changes, migrated: migration.config };
            return { status: 'loaded', path, config, issues, pending };
        }
    }
}
/**
 * Writes a pending migration: first a backup of the original file (`config.v<N>.json`, or with a
 * timestamp when that name is taken), then the migrated config, atomically. Returns the backup path.
 */
export async function writeMigration(files, configPath, backupsDir, pending, clock) {
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
async function backupWithStamp(files, backupsDir, version, original, clock) {
    const stamp = formatUtcMinute(new Date(clock.now())).replace(/[-: ]/g, '');
    for (let attempt = 0;; attempt += 1) {
        const path = join(backupsDir, `config.v${version}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`);
        if (await files.createExclusive(path, original)) {
            return path;
        }
    }
}
/** The kit's on-disk JSON style: two-space indent and a final newline. */
export function formatConfig(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
}
