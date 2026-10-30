import { errorMessage, isRecord } from "../core/guards.js";
import { CONFIG_MIGRATIONS, migrateConfig } from "./migrate.js";
import { parseConfig } from "./parse.js";
import { CONFIG_VERSION } from "./types.js";
/**
 * Parses, migrates in memory and validates the text of a config file, the way every teamrig command reads it; `above`
 * is the team above's budget keys of the account's week, for those the file leaves unset (`AccountBudget`).
 */
export function parseConfigText(text, migrations = CONFIG_MIGRATIONS, target = CONFIG_VERSION, above) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
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
            const { config, issues } = parseConfig(raw, above);
            return { status: 'loaded', config, issues, newerVersion: migration.version };
        }
        case 'current': {
            const { config, issues } = parseConfig(migration.config, above);
            return { status: 'loaded', config, issues };
        }
        case 'migrated': {
            const { config, issues } = parseConfig(migration.config, above);
            const pending = {
                fromVersion: migration.fromVersion,
                toVersion: migration.version,
                changes: migration.changes,
                firstRelease: migration.firstRelease,
                migrated: migration.config,
            };
            return { status: 'loaded', config, issues, pending };
        }
    }
}
