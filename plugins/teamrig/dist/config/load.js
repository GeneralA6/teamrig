import { join } from 'node:path';
import { formatUtcMinute } from "../core/time.js";
import { CONFIG_MIGRATIONS } from "./migrate.js";
import { parseConfigText } from "./text.js";
import { CONFIG_VERSION } from "./types.js";
/** Reads, migrates in memory and validates the config file. Never writes. */
export async function loadConfig(files, path, migrations = CONFIG_MIGRATIONS, target = CONFIG_VERSION) {
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
