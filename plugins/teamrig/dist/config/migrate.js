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
/** The fixed daily budget keys v4 dropped, by section. */
const FIXED_DAILY_KEYS = ['dailyPct', 'maxDailyPct'];
/** `record` without `keys`, and one change line for each key it had. */
function withoutKeys(record, keys, path, why) {
    const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
    const changes = keys.filter((key) => key in record).map((key) => `${path}.${key} removed: ${why}`);
    return { config: kept, changes };
}
/** `budget.sessions` without a fixed `dailyPct` on any entry; an entry left empty goes, and so does a map left empty. */
function withoutSessionDailyPct(budget) {
    const sessions = budget['sessions'];
    if (!isRecord(sessions)) {
        return { config: budget, changes: [] };
    }
    const kept = {};
    const changes = [];
    for (const [id, entry] of Object.entries(sessions)) {
        if (!isRecord(entry)) {
            kept[id] = entry;
            continue;
        }
        const step = withoutKeys(entry, ['dailyPct'], `budget.sessions.${id}`, "the session's part of the team's daily budget is recomputed from its share and queued work");
        changes.push(...step.changes);
        if (Object.keys(step.config).length > 0 || step.changes.length === 0) {
            kept[id] = step.config;
        }
    }
    if (changes.length === 0) {
        return { config: budget, changes };
    }
    const config = Object.keys(kept).length === 0 ? Object.fromEntries(Object.entries(budget).filter(([key]) => key !== 'sessions')) : { ...budget, sessions: kept };
    return { config, changes };
}
/**
 * v3 to v4: daily budgets are no longer fixed. The team's daily budget is recomputed at every reading from what is left
 * of the week and the active time to the reset, and each session's is its part of that, so `budget.dailyPct`,
 * `budget.maxDailyPct`, `budget.sessions.<id>.dailyPct` and the hiring caps `hiring.dailyPct` and `hiring.maxDailyPct`
 * go; `hiring.maxSessions` alone bounds hiring.
 */
export const DROP_FIXED_DAILY_BUDGETS = {
    from: 3,
    apply: (config) => {
        let next = config;
        const changes = [];
        const budget = config['budget'];
        if (isRecord(budget)) {
            const fixed = withoutKeys(budget, FIXED_DAILY_KEYS, 'budget', 'the daily budget is recomputed from what is left of the week');
            const sessions = withoutSessionDailyPct(fixed.config);
            changes.push(...fixed.changes, ...sessions.changes);
            next = { ...next, budget: sessions.config };
        }
        const hiring = config['hiring'];
        if (isRecord(hiring)) {
            const fixed = withoutKeys(hiring, FIXED_DAILY_KEYS, 'hiring', "a hire's daily budget is its part of the team's; hiring.maxSessions bounds hiring");
            changes.push(...fixed.changes);
            next = { ...next, hiring: fixed.config };
        }
        return { config: changes.length === 0 ? config : next, changes };
    },
};
/** The shipped chain, in order: each step reads `from` and produces `from + 1`. */
export const CONFIG_MIGRATIONS = [RENAME_TIERS_TO_PRIORITIES, RENAME_BLOCKED_TO_WAITING, DROP_FIXED_DAILY_BUDGETS];
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
