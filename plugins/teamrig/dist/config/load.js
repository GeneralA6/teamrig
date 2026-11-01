import { join } from 'node:path';
import { formatUtcMinute } from "../core/time.js";
import { CONFIG_MIGRATIONS } from "./migrate.js";
import { parseConfigText } from "./text.js";
import { CONFIG_VERSION } from "./types.js";
/**
 * Reads, migrates in memory and validates the config file, reading it again over `above`'s keys when it has a team
 * above. Never writes.
 */
export async function loadConfig(files, path, migrations = CONFIG_MIGRATIONS, target = CONFIG_VERSION, above) {
    const text = await files.read(path);
    if (text === undefined) {
        return { status: 'missing', path };
    }
    const own = parseConfigText(text, migrations, target);
    const inherited = own.status === 'loaded' && above !== undefined ? await above(own.config) : undefined;
    return { ...(inherited === undefined ? own : parseConfigText(text, migrations, target, inherited)), path };
}
/** The name a migration's backup starts with: `config.v<N>`, N the version it migrated from. */
export function migrationBackupName(pending) {
    return `config.v${pending.fromVersion}`;
}
/**
 * Replaces the config file with `config`: first a backup of the original (`<backupName>.json`, or with a
 * timestamp when that name is taken), then the new file, atomically. Returns the backup path. A team's config is
 * written only through its lock (`ConfigLock`, config-lock.ts); this is called directly for other JSON files only,
 * such as Claude Code's settings.
 */
export async function writeConfigWithBackup(files, target, config, clock) {
    const original = await files.read(target.configPath);
    if (original === undefined) {
        throw new Error(`${target.configPath} disappeared before the change could be written`);
    }
    const plain = join(target.backupsDir, `${target.backupName}.json`);
    const backup = (await files.createExclusive(plain, original)) ? plain : await backupWithStamp(files, target, original, clock);
    await files.write(target.configPath, formatConfig(config));
    return backup;
}
async function backupWithStamp(files, target, original, clock) {
    const stamp = formatUtcMinute(new Date(clock.now())).replace(/[-: ]/g, '');
    for (let attempt = 0;; attempt += 1) {
        const path = join(target.backupsDir, `${target.backupName}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`);
        if (await files.createExclusive(path, original)) {
            return path;
        }
    }
}
/** The kit's on-disk JSON style: two-space indent and a final newline. */
export function formatConfig(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
}
