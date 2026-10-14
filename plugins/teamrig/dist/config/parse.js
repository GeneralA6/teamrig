import { NAME_PATTERN, NAME_RULE } from "../core/ids.js";
import { isTaskStatus, SESSION_NAME } from "../register/model.js";
import { DEFAULT_ALERTS, DEFAULT_BUDGET, DEFAULT_COMMITS, DEFAULT_LOCK, DEFAULT_MESSAGES, DEFAULT_OWNER_GATES, DEFAULT_PUSH_GUARD, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_SKILLS, } from "./defaults.js";
import { CONFIG_LIMITS } from "./limits.js";
import { ConfigReader, describe, isValidRegex, shortLine } from "./reader.js";
import { isCommitGate, } from "./types.js";
const isSessionName = (name) => SESSION_NAME.test(name) ? undefined : 'expected a lowercase name: a letter, then letters, digits or -, at most 32';
const isUtcTime = (time) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? undefined : 'expected a UTC time as HH:MM');
const BRANCH_NAME = (name) => (/^[^\s~^:?*[\\]+$/.test(name) ? undefined : 'not a valid branch name');
/** The key shape the skills lint recognises in frontmatter. */
const isFrontmatterKey = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? undefined : 'expected a frontmatter key: letters, digits, _ or -');
/** A git trailer key, such as `Large-commit`. */
const isTrailerKey = (key) => /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(key) ? undefined : 'expected a trailer key: a letter, then at most 39 letters, digits or -';
const isDisplayName = (name) => (NAME_PATTERN.test(name) ? undefined : `expected a name: ${NAME_RULE}`);
/**
 * `names`: only sessions on the team, and each name unique and never another session's id, so a
 * command given a name finds exactly one session.
 */
function readNames(read, raw, sessions) {
    const names = {};
    const holders = new Map();
    for (const id of Object.keys(raw)) {
        const name = read.optionalString(raw, id, 'names', isDisplayName);
        if (name === undefined) {
            continue;
        }
        if (!sessions.includes(id)) {
            read.report(`names.${id}`, 'is not one of the sessions');
            continue;
        }
        const holder = holders.get(name);
        if (holder !== undefined || (name !== id && sessions.includes(name))) {
            read.report(`names.${id}`, `${describe(name)} is already ${holder === undefined ? 'a session id' : `the name of ${holder}`}`);
            continue;
        }
        holders.set(name, id);
        names[id] = name;
    }
    return names;
}
/** Validates a migrated config object against the current format. */
export function parseConfig(raw) {
    const read = new ConfigReader();
    const sessions = read.list(raw, 'sessions', '', [], (value, path) => read.stringItem(value, path, isSessionName));
    if (raw['sessions'] === undefined) {
        read.report('sessions', 'is required: list every session id on the team');
    }
    const rolesRaw = read.section(raw, 'roles', '');
    const lead = read.requiredString(rolesRaw, 'lead', 'roles', isSessionName);
    const coordinatorOwner = read.optionalString(rolesRaw, 'coordinatorOwner', 'roles', isSessionName);
    for (const [key, name] of [
        ['lead', lead],
        ['coordinatorOwner', coordinatorOwner],
    ]) {
        if (name !== undefined && name !== '' && sessions.length > 0 && !sessions.includes(name)) {
            read.report(`roles.${key}`, `${describe(name)} is not one of the sessions`);
        }
    }
    if (new Set(sessions).size !== sessions.length) {
        read.report('sessions', 'lists a session more than once');
    }
    const names = readNames(read, read.section(raw, 'names', ''), sessions);
    const messages = read.section(raw, 'messages', '');
    const pushGuard = read.section(raw, 'pushGuard', '');
    const coordinator = read.section(raw, 'coordinator', '');
    const schedule = read.section(coordinator, 'schedule', 'coordinator');
    const budget = read.section(coordinator, 'budget', 'coordinator');
    const heavyCutoffUtc = read.optionalString(schedule, 'heavyCutoffUtc', 'coordinator.schedule', isUtcTime);
    const alerts = read.section(raw, 'alerts', '');
    const lock = read.section(raw, 'lock', '');
    const tabStatus = read.section(raw, 'tabStatus', '');
    const config = {
        configVersion: read.integer(raw, 'configVersion', '', 1, { min: 1 }),
        sessions,
        names,
        roles: coordinatorOwner === undefined ? { lead } : { lead, coordinatorOwner },
        ownerGates: read.stringList(raw, 'ownerGates', '', DEFAULT_OWNER_GATES, shortLine(CONFIG_LIMITS.ownerGates.maxLength), CONFIG_LIMITS.ownerGates.maxItems),
        messages: { maxLines: read.integer(messages, 'maxLines', 'messages', DEFAULT_MESSAGES.maxLines, CONFIG_LIMITS.maxLines) },
        register: parseRegister(read, read.section(raw, 'register', '')),
        skills: parseSkills(read, read.section(raw, 'skills', '')),
        lock: {
            ttlMs: read.integer(lock, 'ttlMs', 'lock', DEFAULT_LOCK.ttlMs, { min: 1_000 }),
            pollMs: read.integer(lock, 'pollMs', 'lock', DEFAULT_LOCK.pollMs, { min: 10 }),
            waitMs: read.integer(lock, 'waitMs', 'lock', DEFAULT_LOCK.waitMs, { min: 0 }),
        },
        pushGuard: {
            protectedBranches: read.stringList(pushGuard, 'protectedBranches', 'pushGuard', DEFAULT_PUSH_GUARD.protectedBranches, shortLine(CONFIG_LIMITS.protectedBranches.maxLength, BRANCH_NAME), CONFIG_LIMITS.protectedBranches.maxItems),
        },
        commits: parseCommits(read, read.section(raw, 'commits', '')),
        coordinator: {
            schedule: heavyCutoffUtc === undefined ? {} : { heavyCutoffUtc },
            budget: {
                enabled: read.boolean(budget, 'enabled', 'coordinator.budget', DEFAULT_BUDGET.enabled),
                targetPct: read.number(budget, 'targetPct', 'coordinator.budget', DEFAULT_BUDGET.targetPct, { min: 1, max: 100 }),
                reservePct: read.number(budget, 'reservePct', 'coordinator.budget', DEFAULT_BUDGET.reservePct, { min: 0, max: 50 }),
            },
        },
        alerts: {
            persistentFailureHours: read.integer(alerts, 'persistentFailureHours', 'alerts', DEFAULT_ALERTS.persistentFailureHours, CONFIG_LIMITS.persistentFailureHours),
        },
        tabStatus: { enabled: read.boolean(tabStatus, 'enabled', 'tabStatus', false) },
        refresh: parseRefresh(read, read.section(raw, 'refresh', '')),
        paths: parsePaths(read, read.section(raw, 'paths', '')),
    };
    return { config, issues: read.issues };
}
function parseRegister(read, raw) {
    const path = 'register';
    const defaults = DEFAULT_REGISTER;
    const check = read.section(raw, 'check', path);
    const tiers = read.list(raw, 'tiers', path, defaults.tiers, (value, itemPath) => parseTier(read, value, itemPath));
    if (tiers.length === 0) {
        read.report(`${path}.tiers`, 'needs at least one tier');
    }
    if (new Set(tiers.map((tier) => tier.id)).size !== tiers.length) {
        read.report(`${path}.tiers`, 'uses a tier id more than once');
    }
    const goalPattern = read.optionalString(raw, 'goalPattern', path, isValidRegex);
    const register = {
        ownerSource: read.string(raw, 'ownerSource', path, defaults.ownerSource, isSessionName),
        tiers: tiers.length === 0 ? defaults.tiers : tiers,
        maxTitle: read.integer(raw, 'maxTitle', path, defaults.maxTitle, { min: 20, max: 1_000 }),
        maxText: read.integer(raw, 'maxText', path, defaults.maxText, { min: 20, max: 5_000 }),
        secretPatterns: read.stringList(raw, 'secretPatterns', path, defaults.secretPatterns, isValidRegex),
        requireEvidenceOnDone: read.boolean(raw, 'requireEvidenceOnDone', path, defaults.requireEvidenceOnDone),
        requireSkillOnDone: read.boolean(raw, 'requireSkillOnDone', path, defaults.requireSkillOnDone),
        requireNoteOn: read.list(raw, 'requireNoteOn', path, defaults.requireNoteOn, (value, itemPath) => parseStatus(read, value, itemPath), CONFIG_LIMITS.requireNoteOn.maxItems),
        check: {
            staleAfterHours: read.integer(check, 'staleAfterHours', `${path}.check`, defaults.check.staleAfterHours, { min: 1 }),
            notPickedUpAfterHours: read.integer(check, 'notPickedUpAfterHours', `${path}.check`, defaults.check.notPickedUpAfterHours, { min: 1 }),
            weekLengthDays: read.integer(check, 'weekLengthDays', `${path}.check`, defaults.check.weekLengthDays, { min: 1, max: 31 }),
        },
    };
    return goalPattern === undefined ? register : { ...register, goalPattern };
}
function parseTier(read, value, path) {
    const tier = read.objectItem(value, path);
    if (tier === undefined) {
        return undefined;
    }
    const before = read.issues.length;
    const id = read.integer(tier, 'id', path, 0, { min: 1, max: 99 });
    const name = read.requiredString(tier, 'name', path);
    if (tier['id'] === undefined) {
        read.report(`${path}.id`, 'is required');
    }
    return read.issues.length === before ? { id, name } : undefined;
}
function parseStatus(read, value, path) {
    if (isTaskStatus(value)) {
        return value;
    }
    read.report(path, `expected one of open, in-progress, blocked, done, dropped, got ${describe(value)}`);
    return undefined;
}
function parseSkills(read, raw) {
    const path = 'skills';
    const defaults = DEFAULT_SKILLS;
    return {
        sharedPrefix: read.string(raw, 'sharedPrefix', path, defaults.sharedPrefix, isSessionName),
        maxDescriptionWords: read.integer(raw, 'maxDescriptionWords', path, defaults.maxDescriptionWords, CONFIG_LIMITS.maxDescriptionWords),
        maxPerArea: read.integer(raw, 'maxPerArea', path, defaults.maxPerArea, CONFIG_LIMITS.maxPerArea),
        maxVerifiedAgeDays: read.integer(raw, 'maxVerifiedAgeDays', path, defaults.maxVerifiedAgeDays, CONFIG_LIMITS.maxVerifiedAgeDays),
        forbidFrontmatter: read.stringList(raw, 'forbidFrontmatter', path, defaults.forbidFrontmatter, shortLine(CONFIG_LIMITS.forbidFrontmatter.maxLength, isFrontmatterKey), CONFIG_LIMITS.forbidFrontmatter.maxItems),
    };
}
function parseCommits(read, raw) {
    const path = 'commits';
    const defaults = DEFAULT_COMMITS;
    const gate = read.string(raw, 'gate', path, defaults.gate, (value) => (isCommitGate(value) ? undefined : 'expected off, warn or refuse'));
    return {
        maxLines: read.integer(raw, 'maxLines', path, defaults.maxLines, CONFIG_LIMITS.commitMaxLines),
        maxFiles: read.integer(raw, 'maxFiles', path, defaults.maxFiles, CONFIG_LIMITS.commitMaxFiles),
        largeCommitTrailer: read.string(raw, 'largeCommitTrailer', path, defaults.largeCommitTrailer, isTrailerKey),
        testPatterns: read.stringList(raw, 'testPatterns', path, defaults.testPatterns, shortLine(CONFIG_LIMITS.testPatterns.maxLength, isValidRegex), CONFIG_LIMITS.testPatterns.maxItems),
        gate: isCommitGate(gate) ? gate : defaults.gate,
    };
}
/** From a 200k window's compaction point up to far past any window today. */
const REFRESH_TOKENS = { min: 10_000, max: 10_000_000 };
function parseRefresh(read, raw) {
    const path = 'refresh';
    const defaults = DEFAULT_REFRESH;
    const handoverDir = read.optionalString(raw, 'handoverDir', path);
    return {
        enabled: read.boolean(raw, 'enabled', path, defaults.enabled),
        contextTokens: read.integer(raw, 'contextTokens', path, defaults.contextTokens, REFRESH_TOKENS),
        tabTitle: read.boolean(raw, 'tabTitle', path, defaults.tabTitle),
        ...(handoverDir === undefined ? {} : { handoverDir }),
    };
}
function parsePaths(read, raw) {
    const state = read.optionalString(raw, 'state', 'paths');
    const inbox = read.optionalString(raw, 'inbox', 'paths');
    const skills = read.optionalString(raw, 'skills', 'paths');
    return {
        ...(state === undefined ? {} : { state }),
        ...(inbox === undefined ? {} : { inbox }),
        ...(skills === undefined ? {} : { skills }),
    };
}
