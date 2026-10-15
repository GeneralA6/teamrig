import { isRecord } from "../core/guards.js";
import { NAME_PATTERN, NAME_RULE } from "../core/ids.js";
import { isTaskStatus, LEGACY_WAITING_HINT, LEGACY_WAITING_STATUS, SESSION_NAME, TASK_STATUSES } from "../register/model.js";
import { DEFAULT_ALERTS, DEFAULT_BUDGET, DEFAULT_COMMITS, DEFAULT_GITHUB, DEFAULT_LOCK, DEFAULT_LOOPS, DEFAULT_MESSAGES, DEFAULT_OPEN, DEFAULT_OWNER_GATES, DEFAULT_PUSH_GUARD, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_SESSION_SHARE, DEFAULT_SKILLS, DEFAULT_TESTS, } from "./defaults.js";
import { isEffort, isModel } from "./launch.js";
import { CONFIG_LIMITS } from "./limits.js";
import { ConfigReader, describe, isValidRegex, shortLine } from "./reader.js";
import { ESCALATIONS, isCommitGate, isEffortLevel, isEscalation, isOverAction, isPushToProtected, isTerminalChoice, isVerifyGate, isWeekday, OVER_ACTIONS, PUSH_TO_PROTECTED, TERMINALS, VERIFY_GATES, WEEKDAYS, } from "./types.js";
const isSessionName = (name) => SESSION_NAME.test(name) ? undefined : 'expected a lowercase name: a letter, then letters, digits or -, at most 32';
const isUtcTime = (time) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? undefined : 'expected a UTC time as HH:MM');
/** A repository as GitHub names it: an owner login, a slash, then letters, digits, `.`, `_` or `-`. */
const isRepoName = (repo) => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i.test(repo) ? undefined : 'expected a GitHub repository as owner/name';
/** A GitHub login: letters, digits or -, starting with a letter or digit, at most 39 characters. */
const GITHUB_LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/i;
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
/**
 * `launch`: a model and an effort for sessions on the team. A wrong field is reported and left out,
 * so the session starts on Claude Code's own choice (or, for the lead, the lead's default) for it.
 */
function readLaunch(read, raw, sessions) {
    const launch = {};
    for (const [id, value] of Object.entries(raw)) {
        const path = `launch.${id}`;
        const entry = read.objectItem(value, path);
        if (entry === undefined) {
            continue;
        }
        if (!sessions.includes(id)) {
            read.report(path, 'is not one of the sessions');
            continue;
        }
        const model = read.optionalString(entry, 'model', path, isModel);
        const effort = read.optionalString(entry, 'effort', path, isEffort);
        launch[id] = { ...(model === undefined ? {} : { model }), ...(isEffortLevel(effort) ? { effort } : {}) };
    }
    return launch;
}
/**
 * `team`: the team's id and its parent's, both ids. Only the shape is checked here; whether the id
 * matches the team's folder and the parent exists is the tree's to judge, as it sees every team.
 */
function readTeam(read, raw) {
    const value = raw['team'];
    const section = read.section(raw, 'team', '');
    if (!isRecord(value)) {
        return undefined;
    }
    const id = read.requiredString(section, 'id', 'team', isSessionName);
    const parent = read.optionalString(section, 'parent', 'team', isSessionName);
    if (id === '') {
        return undefined;
    }
    if (parent === id) {
        read.report('team.parent', 'is the team itself; a root team has no parent');
        return { id };
    }
    return parent === undefined ? { id } : { id, parent };
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
    const launch = readLaunch(read, read.section(raw, 'launch', ''), sessions);
    const team = readTeam(read, raw);
    const messages = read.section(raw, 'messages', '');
    const pushGuard = read.section(raw, 'pushGuard', '');
    const coordinator = read.section(raw, 'coordinator', '');
    const schedule = read.section(coordinator, 'schedule', 'coordinator');
    if (coordinator[MOVED_BUDGET_KEY] !== undefined) {
        read.report(`coordinator.${MOVED_BUDGET_KEY}`, 'was moved: use the top-level budget block');
    }
    const heavyCutoffUtc = read.optionalString(schedule, 'heavyCutoffUtc', 'coordinator.schedule', isUtcTime);
    const alerts = read.section(raw, 'alerts', '');
    const lock = read.section(raw, 'lock', '');
    const tabStatus = read.section(raw, 'tabStatus', '');
    const config = {
        configVersion: read.integer(raw, 'configVersion', '', 1, { min: 1 }),
        ...(team === undefined ? {} : { team }),
        sessions,
        names,
        roles: coordinatorOwner === undefined ? { lead } : { lead, coordinatorOwner },
        ownerGates: read.stringList(raw, 'ownerGates', '', DEFAULT_OWNER_GATES, shortLine(CONFIG_LIMITS.ownerGates.maxLength), CONFIG_LIMITS.ownerGates.maxItems),
        messages: {
            maxLines: read.integer(messages, 'maxLines', 'messages', DEFAULT_MESSAGES.maxLines, CONFIG_LIMITS.maxLines),
            coldAfterMinutes: read.integer(messages, 'coldAfterMinutes', 'messages', DEFAULT_MESSAGES.coldAfterMinutes, CONFIG_LIMITS.coldAfterMinutes),
        },
        register: parseRegister(read, read.section(raw, 'register', '')),
        skills: parseSkills(read, read.section(raw, 'skills', '')),
        lock: {
            ttlMs: read.integer(lock, 'ttlMs', 'lock', DEFAULT_LOCK.ttlMs, { min: 1_000 }),
            pollMs: read.integer(lock, 'pollMs', 'lock', DEFAULT_LOCK.pollMs, { min: 10 }),
            waitMs: read.integer(lock, 'waitMs', 'lock', DEFAULT_LOCK.waitMs, { min: 0 }),
        },
        pushGuard: {
            protectedBranches: read.stringList(pushGuard, 'protectedBranches', 'pushGuard', DEFAULT_PUSH_GUARD.protectedBranches, shortLine(CONFIG_LIMITS.protectedBranches.maxLength, BRANCH_NAME), CONFIG_LIMITS.protectedBranches.maxItems),
            pushToProtected: parsePushToProtected(read, pushGuard),
        },
        commits: parseCommits(read, read.section(raw, 'commits', '')),
        coordinator: {
            schedule: heavyCutoffUtc === undefined ? {} : { heavyCutoffUtc },
        },
        budget: parseBudget(read, read.section(raw, 'budget', ''), sessions),
        loops: {
            chainNudgeAt: read.integer(read.section(raw, 'loops', ''), 'chainNudgeAt', 'loops', DEFAULT_LOOPS.chainNudgeAt, CONFIG_LIMITS.chainNudgeAt),
        },
        tests: {
            maxFailureChars: read.integer(read.section(raw, 'tests', ''), 'maxFailureChars', 'tests', DEFAULT_TESTS.maxFailureChars, CONFIG_LIMITS.maxFailureChars),
        },
        github: parseGithub(read, read.section(raw, 'github', ''), sessions),
        alerts: {
            persistentFailureHours: read.integer(alerts, 'persistentFailureHours', 'alerts', DEFAULT_ALERTS.persistentFailureHours, CONFIG_LIMITS.persistentFailureHours),
        },
        tabStatus: { enabled: read.boolean(tabStatus, 'enabled', 'tabStatus', false) },
        refresh: parseRefresh(read, read.section(raw, 'refresh', '')),
        open: parseOpen(read, read.section(raw, 'open', '')),
        launch,
        paths: parsePaths(read, read.section(raw, 'paths', '')),
    };
    return { config, issues: read.issues };
}
/**
 * `github`: the repositories `gh sync` reads and who owns their issues. Repositories and logins are
 * kept in lowercase, as GitHub matches them, so an imported task's ref stays the same however the
 * config spells them; a repository listed twice is reported and read once.
 */
function parseGithub(read, raw, sessions) {
    const { maxItems, maxLength } = CONFIG_LIMITS.githubRepos;
    const repos = [];
    for (const repo of read.stringList(raw, 'repos', 'github', DEFAULT_GITHUB.repos, shortLine(maxLength, isRepoName), maxItems)) {
        const key = repo.toLowerCase();
        if (repos.includes(key)) {
            read.report('github.repos', `${describe(repo)} is listed twice`);
            continue;
        }
        repos.push(key);
    }
    return {
        repos,
        owners: readGithubOwners(read, read.section(raw, 'owners', 'github'), sessions),
        closedDays: read.integer(raw, 'closedDays', 'github', DEFAULT_GITHUB.closedDays, CONFIG_LIMITS.closedDays),
    };
}
/** `github.owners`: a session for each GitHub login; a wrong login or a session not on the team is reported and left out. */
function readGithubOwners(read, raw, sessions) {
    const owners = {};
    for (const login of Object.keys(raw)) {
        const path = `github.owners.${login}`;
        if (!GITHUB_LOGIN.test(login)) {
            read.report(path, 'expected a GitHub login: letters, digits or -, at most 39 characters');
            continue;
        }
        const session = read.optionalString(raw, login, 'github.owners', isSessionName);
        const key = login.toLowerCase();
        if (session === undefined) {
            continue;
        }
        if (!sessions.includes(session)) {
            read.report(path, `${describe(session)} is not one of the sessions`);
        }
        else if (owners[key] !== undefined) {
            read.report(path, 'is listed twice');
        }
        else {
            owners[key] = session;
        }
    }
    return owners;
}
/** Config version 1's name for `register.priorities`; the v1-to-v2 migration renames it, so a current file never holds it. */
const RENAMED_PRIORITIES_KEY = 'tiers';
/** The budget's old place, `coordinator.budget`; it moved to the top-level `budget` block, with no alias. */
const MOVED_BUDGET_KEY = 'budget';
function parseBudget(read, raw, sessions) {
    const path = 'budget';
    const defaults = DEFAULT_BUDGET;
    const targetPct = read.number(raw, 'targetPct', path, defaults.targetPct, CONFIG_LIMITS.budgetTargetPct);
    const reservePct = read.number(raw, 'reservePct', path, defaults.reservePct, CONFIG_LIMITS.budgetReservePct);
    if (targetPct + reservePct > 100) {
        read.report(`${path}.reservePct`, `with targetPct it passes 100% of the week (${targetPct} + ${reservePct})`);
    }
    const weeklyLimitW = read.optionalInteger(raw, 'weeklyLimitW', path, CONFIG_LIMITS.weeklyLimitW);
    const reset = parseBudgetReset(read, raw);
    const dailyPct = read.optionalNumber(raw, 'dailyPct', path, CONFIG_LIMITS.dailyPct);
    const maxDailyPct = read.optionalNumber(raw, 'maxDailyPct', path, CONFIG_LIMITS.maxDailyPct);
    const overAction = read.string(raw, 'overAction', path, defaults.overAction, oneOf(OVER_ACTIONS));
    const escalate = read.string(raw, 'escalate', path, defaults.escalate, oneOf(ESCALATIONS));
    const quietHours = parseQuietHours(read, raw);
    const statusSnapshotDir = read.optionalString(raw, 'statusSnapshotDir', path);
    return {
        enabled: read.boolean(raw, 'enabled', path, defaults.enabled),
        ...(weeklyLimitW === undefined ? {} : { weeklyLimitW }),
        ...(reset === undefined ? {} : { reset }),
        targetPct,
        reservePct,
        paceEndHoursBeforeReset: read.number(raw, 'paceEndHoursBeforeReset', path, defaults.paceEndHoursBeforeReset, CONFIG_LIMITS.paceEndHoursBeforeReset),
        ...(dailyPct === undefined ? {} : { dailyPct }),
        ...(maxDailyPct === undefined ? {} : { maxDailyPct }),
        sessions: parseSessionBudgets(read, read.section(raw, 'sessions', path), sessions),
        warnAtPct: read.list(raw, 'warnAtPct', path, defaults.warnAtPct, (value, itemPath) => read.numberItem(value, itemPath, { min: CONFIG_LIMITS.warnAtPct.itemMin, max: CONFIG_LIMITS.warnAtPct.itemMax }), CONFIG_LIMITS.warnAtPct.maxItems),
        paceTolerancePct: read.number(raw, 'paceTolerancePct', path, defaults.paceTolerancePct, CONFIG_LIMITS.paceTolerancePct),
        overAction: isOverAction(overAction) ? overAction : defaults.overAction,
        escalate: isEscalation(escalate) ? escalate : defaults.escalate,
        ...(quietHours === undefined ? {} : { quietHours }),
        lift: parseBudgetLift(read, read.section(raw, 'lift', path)),
        ...(statusSnapshotDir === undefined ? {} : { statusSnapshotDir }),
        maxBytesPerHook: read.integer(raw, 'maxBytesPerHook', path, defaults.maxBytesPerHook, CONFIG_LIMITS.maxBytesPerHook),
    };
}
/** `budget.reset`: both keys, or nothing (a reset read from the status line). */
function parseBudgetReset(read, raw) {
    const path = 'budget.reset';
    if (raw['reset'] === undefined) {
        return undefined;
    }
    const section = read.objectItem(raw['reset'], path);
    if (section === undefined) {
        return undefined;
    }
    const weekday = read.requiredString(section, 'weekday', path, oneOf(WEEKDAYS));
    const timeUtc = read.requiredString(section, 'timeUtc', path, isUtcTime);
    return isWeekday(weekday) && timeUtc !== '' ? { weekday, timeUtc } : undefined;
}
/** `budget.quietHours`: a start, an end and the action, or nothing. */
function parseQuietHours(read, raw) {
    const path = 'budget.quietHours';
    if (raw['quietHours'] === undefined) {
        return undefined;
    }
    const section = read.objectItem(raw['quietHours'], path);
    if (section === undefined) {
        return undefined;
    }
    const startUtc = read.requiredString(section, 'startUtc', path, isUtcTime);
    const endUtc = read.requiredString(section, 'endUtc', path, isUtcTime);
    const action = read.requiredString(section, 'action', path, oneOf(OVER_ACTIONS));
    if (startUtc === '' || endUtc === '' || !isOverAction(action)) {
        return undefined;
    }
    if (startUtc === endUtc) {
        read.report(`${path}.endUtc`, 'is the start time; quiet hours need a start and a different end');
        return undefined;
    }
    return { startUtc, endUtc, action };
}
/** `budget.lift`: the highest stop % of a lift, and of the reserve release; the reserve bound is never below the other. */
function parseBudgetLift(read, raw) {
    const path = 'budget.lift';
    const defaults = DEFAULT_BUDGET.lift;
    const maxStopPct = read.number(raw, 'maxStopPct', path, defaults.maxStopPct, CONFIG_LIMITS.liftMaxStopPct);
    const reserveStopPct = read.number(raw, 'reserveStopPct', path, defaults.reserveStopPct, CONFIG_LIMITS.liftReserveStopPct);
    if (reserveStopPct < maxStopPct) {
        read.report(`${path}.reserveStopPct`, `is below maxStopPct (${reserveStopPct} < ${maxStopPct})`);
        return { maxStopPct, reserveStopPct: maxStopPct };
    }
    return { maxStopPct, reserveStopPct };
}
/** `budget.sessions`: a share and an optional fixed daily % for sessions on the team. */
function parseSessionBudgets(read, raw, sessions) {
    const budgets = {};
    for (const [id, value] of Object.entries(raw)) {
        const path = `budget.sessions.${id}`;
        const entry = read.objectItem(value, path);
        if (entry === undefined) {
            continue;
        }
        if (!sessions.includes(id)) {
            read.report(path, 'is not one of the sessions');
            continue;
        }
        const dailyPct = read.optionalNumber(entry, 'dailyPct', path, CONFIG_LIMITS.sessionDailyPct);
        budgets[id] = {
            share: read.number(entry, 'share', path, DEFAULT_SESSION_SHARE, CONFIG_LIMITS.sessionShare),
            ...(dailyPct === undefined ? {} : { dailyPct }),
        };
    }
    return budgets;
}
/** A check that takes only the listed words. */
function oneOf(words) {
    return (value) => (words.includes(value) ? undefined : `expected one of ${words.join(', ')}`);
}
function parseRegister(read, raw) {
    const path = 'register';
    const defaults = DEFAULT_REGISTER;
    const check = read.section(raw, 'check', path);
    if (raw[RENAMED_PRIORITIES_KEY] !== undefined) {
        read.report(`${path}.${RENAMED_PRIORITIES_KEY}`, `was renamed: use ${path}.priorities`);
    }
    const priorities = read.list(raw, 'priorities', path, defaults.priorities, (value, itemPath) => parsePriority(read, value, itemPath));
    if (priorities.length === 0) {
        read.report(`${path}.priorities`, 'needs at least one priority');
    }
    if (new Set(priorities.map((priority) => priority.id)).size !== priorities.length) {
        read.report(`${path}.priorities`, 'uses a priority id more than once');
    }
    const goalPattern = read.optionalString(raw, 'goalPattern', path, isValidRegex);
    const verifyGate = read.string(raw, 'verifyGate', path, defaults.verifyGate, oneOf(VERIFY_GATES));
    const register = {
        ownerSource: read.string(raw, 'ownerSource', path, defaults.ownerSource, isSessionName),
        priorities: priorities.length === 0 ? defaults.priorities : priorities,
        maxTitle: read.integer(raw, 'maxTitle', path, defaults.maxTitle, { min: 20, max: 1_000 }),
        maxText: read.integer(raw, 'maxText', path, defaults.maxText, { min: 20, max: 5_000 }),
        secretPatterns: read.stringList(raw, 'secretPatterns', path, defaults.secretPatterns, isValidRegex),
        requireEvidenceOnDone: read.boolean(raw, 'requireEvidenceOnDone', path, defaults.requireEvidenceOnDone),
        requireSkillOnDone: read.boolean(raw, 'requireSkillOnDone', path, defaults.requireSkillOnDone),
        requireNoteOn: read.list(raw, 'requireNoteOn', path, defaults.requireNoteOn, (value, itemPath) => parseStatus(read, value, itemPath), CONFIG_LIMITS.requireNoteOn.maxItems),
        autoArchive: read.boolean(raw, 'autoArchive', path, defaults.autoArchive),
        requireProofOnVerifying: read.boolean(raw, 'requireProofOnVerifying', path, defaults.requireProofOnVerifying),
        verifyGate: isVerifyGate(verifyGate) ? verifyGate : defaults.verifyGate,
        maxVerifying: read.integer(raw, 'maxVerifying', path, defaults.maxVerifying, CONFIG_LIMITS.maxVerifying),
        check: {
            staleAfterHours: read.integer(check, 'staleAfterHours', `${path}.check`, defaults.check.staleAfterHours, { min: 1 }),
            notPickedUpAfterHours: read.integer(check, 'notPickedUpAfterHours', `${path}.check`, defaults.check.notPickedUpAfterHours, { min: 1 }),
            prioritySkipAfterHours: read.integer(check, 'prioritySkipAfterHours', `${path}.check`, defaults.check.prioritySkipAfterHours, { min: 1 }),
            weekLengthDays: read.integer(check, 'weekLengthDays', `${path}.check`, defaults.check.weekLengthDays, { min: 1, max: 31 }),
            stopgapFiles: read.stringList(check, 'stopgapFiles', `${path}.check`, defaults.check.stopgapFiles, shortLine(CONFIG_LIMITS.stopgapFiles.maxLength, (value) => (value.trim() === '' ? 'expected a path' : undefined)), CONFIG_LIMITS.stopgapFiles.maxItems),
        },
    };
    return goalPattern === undefined ? register : { ...register, goalPattern };
}
function parsePriority(read, value, path) {
    const priority = read.objectItem(value, path);
    if (priority === undefined) {
        return undefined;
    }
    const before = read.issues.length;
    const id = read.integer(priority, 'id', path, 0, { min: 1, max: 99 });
    const name = read.requiredString(priority, 'name', path);
    if (priority['id'] === undefined) {
        read.report(`${path}.id`, 'is required');
    }
    return read.issues.length === before ? { id, name } : undefined;
}
function parseStatus(read, value, path) {
    if (isTaskStatus(value)) {
        return value;
    }
    const hint = value === LEGACY_WAITING_STATUS ? ` (${LEGACY_WAITING_HINT})` : '';
    read.report(path, `expected one of ${TASK_STATUSES.join(', ')}, got ${describe(value)}${hint}`);
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
function parseOpen(read, raw) {
    const terminal = read.string(raw, 'terminal', 'open', DEFAULT_OPEN.terminal, (value) => isTerminalChoice(value) ? undefined : `expected one of ${TERMINALS.join(', ')}`);
    return { terminal: isTerminalChoice(terminal) ? terminal : DEFAULT_OPEN.terminal };
}
function parsePushToProtected(read, raw) {
    const fallback = DEFAULT_PUSH_GUARD.pushToProtected;
    const value = read.string(raw, 'pushToProtected', 'pushGuard', fallback, oneOf(PUSH_TO_PROTECTED));
    return isPushToProtected(value) ? value : fallback;
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
