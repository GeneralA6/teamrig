import { isRecord } from "../core/guards.js";
import { LEGACY_WAITING_STATUS } from "../register/model.js";
import { CONFIG_VERSION } from "./types.js";
/** v1 to v2: the priority levels moved from `register.tiers` to `register.priorities`, same entries. */
export const RENAME_TIERS_TO_PRIORITIES = {
    from: 1,
    firstRelease: '0.1.1',
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
    firstRelease: '0.10.0',
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
 * go.
 */
export const DROP_FIXED_DAILY_BUDGETS = {
    from: 3,
    firstRelease: '0.83.0',
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
            const fixed = withoutKeys(hiring, FIXED_DAILY_KEYS, 'hiring', "a hire's daily budget is its part of the team's");
            changes.push(...fixed.changes);
            next = { ...next, hiring: fixed.config };
        }
        return { config: changes.length === 0 ? config : next, changes };
    },
};
/**
 * The keys v5 renamed into plain words (T1308): a repository's `roll` block became `deploy` and its `gates` its
 * `checks`, and the coordinator's `gateTimeoutSeconds` and `windows.assumedRollMinutes` followed. Applied in order, so a
 * rename inside a key comes before a later rename of the key itself; a later rename of the same release appends here.
 */
const PLAIN_WORD_RENAMES = [
    { at: ['coordinator', 'repos', '*'], from: 'roll', to: 'deploy' },
    { at: ['coordinator', 'repos', '*', 'deploy'], from: 'gates', to: 'checks' },
    { at: ['coordinator'], from: 'gateTimeoutSeconds', to: 'checkTimeoutSeconds' },
    { at: ['coordinator', 'windows'], from: 'assumedRollMinutes', to: 'assumedDeployMinutes' },
];
/**
 * `record` with `rename.from` renamed to `rename.to` in each record `at` reaches below `path`, each key kept in its place
 * so a written file's diff shows only the rename. Where both keys are set the old one's value wins, as the version that
 * wrote the file read only the old one; its change line says the new key's value was replaced.
 */
function renameKey(record, at, rename, path, fromVersion) {
    const [head, ...below] = at;
    if (head === undefined) {
        if (!Object.hasOwn(record, rename.from)) {
            return { config: record, changes: [] };
        }
        const [from, to] = [[...path, rename.from].join('.'), [...path, rename.to].join('.')];
        const replaced = Object.hasOwn(record, rename.to);
        const entries = Object.entries(record)
            .filter(([key]) => key !== rename.to)
            .map(([key, value]) => [key === rename.from ? rename.to : key, value]);
        return { config: Object.fromEntries(entries), changes: [replaced ? `${from} → ${to}, replacing the ${to} version ${fromVersion} did not read` : `${from} → ${to}`] };
    }
    let config = record;
    const changes = [];
    for (const key of head === '*' ? Object.keys(record) : [head]) {
        const child = record[key];
        if (!isRecord(child)) {
            continue;
        }
        const step = renameKey(child, below, rename, [...path, key], fromVersion);
        if (step.changes.length > 0) {
            config = { ...config, [key]: step.config };
            changes.push(...step.changes);
        }
    }
    return { config, changes };
}
/** `config` with each of `renames` applied in order, and one change line for each key renamed. */
function renameKeys(config, renames, fromVersion) {
    return renames.reduce((step, rename) => {
        const next = renameKey(step.config, rename.at, rename, [], fromVersion);
        return { config: next.config, changes: [...step.changes, ...next.changes] };
    }, { config, changes: [] });
}
/** v4 to v5: the deploy flow's keys in plain words, PLAIN_WORD_RENAMES; every value is kept as it was. */
export const RENAME_TO_PLAIN_WORDS = {
    from: 4,
    firstRelease: '0.214.0',
    apply: (config) => renameKeys(config, PLAIN_WORD_RENAMES, 4),
};
/** Why v6 reads no hire cap; the parser flags a hand-written one with the same words. */
export const HIRE_CAP_DROPPED = "the host's room bounds who is at the office, the leader decides who is hired";
/** v5 to v6: no cap counts hires (T1364), so `hiring.maxSessions` and `hiring.capRaisedBy`, who raised it, go. */
export const DROP_HIRE_CAP = {
    from: 5,
    firstRelease: '0.232.0',
    apply: (config) => {
        const hiring = config['hiring'];
        if (!isRecord(hiring)) {
            return { config, changes: [] };
        }
        const step = withoutKeys(hiring, ['maxSessions', 'capRaisedBy'], 'hiring', HIRE_CAP_DROPPED);
        return step.changes.length === 0 ? { config, changes: [] } : { config: { ...config, hiring: step.config }, changes: step.changes };
    },
};
/** Why v7 reads no idle hours; the parser flags a hand-written one with the same words. */
export const IDLE_RETIRE_DROPPED = 'a hire with no task stays hired, and the idle pass deactivates it';
/** v6 to v7: a hire is no longer due to retire for being idle (T1364), so `hiring.idleHours` goes. */
export const DROP_IDLE_RETIRE = {
    from: 6,
    firstRelease: '0.233.0',
    apply: (config) => {
        const hiring = config['hiring'];
        if (!isRecord(hiring)) {
            return { config, changes: [] };
        }
        const step = withoutKeys(hiring, ['idleHours'], 'hiring', IDLE_RETIRE_DROPPED);
        return step.changes.length === 0 ? { config, changes: [] } : { config: { ...config, hiring: step.config }, changes: step.changes };
    },
};
/** The shipped chain, in order: each step reads `from` and produces `from + 1`. */
export const CONFIG_MIGRATIONS = [
    RENAME_TIERS_TO_PRIORITIES,
    RENAME_BLOCKED_TO_WAITING,
    DROP_FIXED_DAILY_BUDGETS,
    RENAME_TO_PLAIN_WORDS,
    DROP_HIRE_CAP,
    DROP_IDLE_RETIRE,
];
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
    let firstRelease;
    const changes = [];
    for (let from = version; from < target; from += 1) {
        const step = migrations.find((migration) => migration.from === from);
        if (step === undefined) {
            throw new Error(`no config migration from version ${from}; the shipped chain is incomplete`);
        }
        const result = step.apply(config);
        config = { ...result.config, configVersion: from + 1 };
        changes.push(...result.changes.map((change) => `v${from}→v${from + 1}: ${change}`));
        firstRelease = step.firstRelease;
    }
    return firstRelease === undefined
        ? { kind: 'current', config, version }
        : { kind: 'migrated', config, fromVersion: version, version: target, changes, firstRelease };
}
