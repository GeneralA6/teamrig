import { CONFIG_VERSION } from "./types.js";
/** The shipped chain: empty until the format first changes (the first step will read version 1). */
export const CONFIG_MIGRATIONS = [];
/** A file without `configVersion` is the first format, so a minimal hand-written config works. */
export const FIRST_CONFIG_VERSION = 1;
export function migrateConfig(raw, target = CONFIG_VERSION, migrations = CONFIG_MIGRATIONS) {
    const declared = raw['configVersion'];
    const version = declared === undefined ? FIRST_CONFIG_VERSION : declared;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < FIRST_CONFIG_VERSION) {
        return { kind: 'invalid', message: `configVersion: expected a positive integer, got ${JSON.stringify(declared)}` };
    }
    if (version > target) {
        return { kind: 'newer', version };
    }
    let config = raw;
    const changes = [];
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
