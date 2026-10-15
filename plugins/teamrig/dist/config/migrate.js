import { isRecord } from "../core/guards.js";
import { LEGACY_WAITING_STATUS } from "../register/model.js";
import { CONFIG_VERSION } from "./types.js";
/** v1 to v2: the priority levels moved from `register.tiers` to `register.priorities`, same entries. */
export const RENAME_TIERS_TO_PRIORITIES = {
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
/**
 * v2 to v3: the status `blocked` became `waiting` (teamrig 0.10.0), so `register.requireNoteOn` names `waiting`
 * where it named `blocked`, once, in the same place.
 */
export const RENAME_BLOCKED_TO_WAITING = {
    from: 2,
    apply: (config) => {
        const register = config['register'];
        const statuses = isRecord(register) ? register['requireNoteOn'] : undefined;
        if (!isRecord(register) || !Array.isArray(statuses) || !statuses.includes(LEGACY_WAITING_STATUS)) {
            return { config, changes: [] };
        }
        const renamed = statuses.map((status) => (status === LEGACY_WAITING_STATUS ? 'waiting' : status));
        const requireNoteOn = renamed.filter((status, index) => renamed.indexOf(status) === index);
        return {
            config: { ...config, register: { ...register, requireNoteOn } },
            changes: [`register.requireNoteOn: ${LEGACY_WAITING_STATUS} → waiting`],
        };
    },
};
/** The shipped chain, in order: each step reads `from` and produces `from + 1`. */
export const CONFIG_MIGRATIONS = [RENAME_TIERS_TO_PRIORITIES, RENAME_BLOCKED_TO_WAITING];
/** This release's format. */
export const SHIPPED_CONFIG_FORMAT = { version: CONFIG_VERSION, migrations: CONFIG_MIGRATIONS };
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
