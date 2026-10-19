import { deployTargetsOf } from "../coordinator/targets.js";
import { isRecord } from "../core/guards.js";
import { NAME_PATTERN, NAME_RULE } from "../core/ids.js";
import { isMinuteInSpan, utcMinuteOf } from "../core/time.js";
import { FOLLOWUP_STATUSES, isTaskStatus, LEGACY_WAITING_HINT, LEGACY_WAITING_STATUS, SESSION_NAME, TASK_STATUSES } from "../register/model.js";
import { PREFIX_PATTERN } from "../readonly-shell/rules.js";
import { CORE_RULE_KEYS, isCoreRuleKey } from "../rules/keys.js";
import { DEFAULT_ALERTS, DEFAULT_BUDGET, DEFAULT_BURST, DEFAULT_COMMITS, DEFAULT_CONTEXT_FILES, DEFAULT_CLAIMS, DEFAULT_COORDINATOR_WAIT, DEFAULT_GATE_TIMEOUT_SECONDS, DEFAULT_GITHUB, DEFAULT_HEAVY, DEFAULT_HIRING, DEFAULT_LOCK, DEFAULT_LEAD_BOUNDARY, DEFAULT_LOOPS, DEFAULT_MESSAGES, DEFAULT_OPEN, DEFAULT_OWNER_GATES, DEFAULT_PACKAGE_GUARD, DEFAULT_PUSH_GUARD, DEFAULT_READONLY_SHELL, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_SCALE_OUT, DEFAULT_SESSION_SHARE, DEFAULT_SKILLS, DEFAULT_STATUS_LINE, DEFAULT_TESTS, DEFAULT_WAKE, DEFAULT_WINDOWS, HEAVY_TTL_MARGIN_MINUTES, } from "./defaults.js";
import { isEffort, isModel } from "./launch.js";
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from "./limits.js";
import { ConfigReader, describe, isValidRegex, shortLine } from "./reader.js";
import { AD_HOC_RUNNERS, BURST_POLICIES, CONFLICT_WINNERS, ESCALATIONS, HIRING_POLICIES, isAdHocRunners, isBurstPolicy, isCommitGate, isConflictWinner, isEffortLevel, isEscalation, isHiringPolicy, isOverAction, isPushToProtected, isTerminalChoice, isVerifyGate, isWeekday, OVER_ACTIONS, PUSH_TO_PROTECTED, TERMINALS, VERIFY_GATES, WEEKDAYS, } from "./types.js";
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
    const alerts = read.section(raw, 'alerts', '');
    const lock = read.section(raw, 'lock', '');
    const tabStatus = read.section(raw, 'tabStatus', '');
    const budget = parseBudget(read, read.section(raw, 'budget', ''), sessions);
    const config = {
        configVersion: read.integer(raw, 'configVersion', '', 1, { min: 1 }),
        ...(team === undefined ? {} : { team }),
        sessions,
        names,
        roles: coordinatorOwner === undefined ? { lead } : { lead, coordinatorOwner },
        ownerGates: read.stringList(raw, 'ownerGates', '', DEFAULT_OWNER_GATES, shortLine(CONFIG_LIMITS.ownerGates.maxLength), CONFIG_LIMITS.ownerGates.maxItems),
        ruleConflicts: read.list(raw, 'ruleConflicts', '', [], (value, itemPath) => parseRuleConflict(read, value, itemPath), CONFIG_LIMITS.ruleConflicts.maxItems),
        messages: {
            maxLines: read.integer(messages, 'maxLines', 'messages', DEFAULT_MESSAGES.maxLines, CONFIG_LIMITS.maxLines),
            coldAfterMinutes: read.integer(messages, 'coldAfterMinutes', 'messages', DEFAULT_MESSAGES.coldAfterMinutes, CONFIG_LIMITS.coldAfterMinutes),
        },
        register: parseRegister(read, read.section(raw, 'register', '')),
        skills: parseSkills(read, read.section(raw, 'skills', '')),
        contextFiles: parseContextFiles(read, read.section(raw, 'contextFiles', '')),
        lock: {
            ttlMs: read.integer(lock, 'ttlMs', 'lock', DEFAULT_LOCK.ttlMs, { min: 1_000 }),
            pollMs: read.integer(lock, 'pollMs', 'lock', DEFAULT_LOCK.pollMs, { min: 10 }),
            waitMs: read.integer(lock, 'waitMs', 'lock', DEFAULT_LOCK.waitMs, { min: 0 }),
        },
        pushGuard: {
            protectedBranches: read.stringList(pushGuard, 'protectedBranches', 'pushGuard', DEFAULT_PUSH_GUARD.protectedBranches, shortLine(CONFIG_LIMITS.protectedBranches.maxLength, BRANCH_NAME), CONFIG_LIMITS.protectedBranches.maxItems),
            pushToProtected: parsePushToProtected(read, pushGuard),
        },
        packageGuard: { adHocRunners: parseAdHocRunners(read, read.section(raw, 'packageGuard', '')) },
        commits: parseCommits(read, read.section(raw, 'commits', '')),
        coordinator: parseCoordinator(read, read.section(raw, 'coordinator', '')),
        budget,
        leadBoundary: parseLeadBoundary(read, read.section(raw, 'leadBoundary', '')),
        loops: {
            chainNudgeAt: read.integer(read.section(raw, 'loops', ''), 'chainNudgeAt', 'loops', DEFAULT_LOOPS.chainNudgeAt, CONFIG_LIMITS.chainNudgeAt),
        },
        wake: parseWake(read, read.section(raw, 'wake', ''), budget.quietHours),
        tests: {
            maxFailureChars: read.integer(read.section(raw, 'tests', ''), 'maxFailureChars', 'tests', DEFAULT_TESTS.maxFailureChars, CONFIG_LIMITS.maxFailureChars),
        },
        github: parseGithub(read, read.section(raw, 'github', ''), sessions),
        alerts: {
            persistentFailureHours: read.integer(alerts, 'persistentFailureHours', 'alerts', DEFAULT_ALERTS.persistentFailureHours, CONFIG_LIMITS.persistentFailureHours),
        },
        tabStatus: { enabled: read.boolean(tabStatus, 'enabled', 'tabStatus', false) },
        readonlyShell: parseReadonlyShell(read, read.section(raw, 'readonlyShell', '')),
        refresh: parseRefresh(read, read.section(raw, 'refresh', '')),
        hiring: parseHiring(read, read.section(raw, 'hiring', '')),
        burst: parseBurst(read, read.section(raw, 'burst', '')),
        open: parseOpen(read, read.section(raw, 'open', '')),
        statusLine: parseStatusLine(read, read.section(raw, 'statusLine', '')),
        launch,
        paths: parsePaths(read, read.section(raw, 'paths', '')),
    };
    return { config, issues: read.issues };
}
/** `leadBoundary`: the lead's own paths are single lines; the search threshold is bounded like the chain nudge. */
function parseLeadBoundary(read, raw) {
    return {
        enabled: read.boolean(raw, 'enabled', 'leadBoundary', DEFAULT_LEAD_BOUNDARY.enabled),
        ownPaths: read.stringList(raw, 'ownPaths', 'leadBoundary', DEFAULT_LEAD_BOUNDARY.ownPaths, shortLine(CONFIG_LIMITS.leadOwnPaths.maxLength), CONFIG_LIMITS.leadOwnPaths.maxItems),
        searchNudgeAt: read.integer(raw, 'searchNudgeAt', 'leadBoundary', DEFAULT_LEAD_BOUNDARY.searchNudgeAt, CONFIG_LIMITS.searchNudgeAt),
    };
}
/** True when an `HH:MM` falls in the quiet hours, which may cross midnight. */
function isInQuietHours(time, quiet) {
    const minute = utcMinuteOf(time);
    const start = utcMinuteOf(quiet.startUtc);
    const end = utcMinuteOf(quiet.endUtc);
    return minute !== undefined && start !== undefined && end !== undefined && isMinuteInSpan(minute, start, end);
}
/**
 * `wake`: a priority as the register numbers them, both waits bounded to a day at most, and a day start outside
 * the budget's quiet hours, where it would wake no one.
 */
function parseWake(read, raw, quietHours) {
    const wake = {
        enabled: read.boolean(raw, 'enabled', 'wake', DEFAULT_WAKE.enabled),
        priority: read.integer(raw, 'priority', 'wake', DEFAULT_WAKE.priority, CONFIG_LIMITS.wakePriority),
        batchSeconds: read.integer(raw, 'batchSeconds', 'wake', DEFAULT_WAKE.batchSeconds, CONFIG_LIMITS.wakeBatchSeconds),
        minGapMinutes: read.integer(raw, 'minGapMinutes', 'wake', DEFAULT_WAKE.minGapMinutes, CONFIG_LIMITS.wakeMinGapMinutes),
    };
    const dayStartUtc = read.optionalString(raw, 'dayStartUtc', 'wake', isUtcTime);
    if (dayStartUtc === undefined) {
        return wake;
    }
    if (quietHours !== undefined && isInQuietHours(dayStartUtc, quietHours)) {
        read.report('wake.dayStartUtc', `is in the budget's quiet hours (${quietHours.startUtc} to ${quietHours.endUtc} UTC), where no session wakes`);
        return wake;
    }
    return { ...wake, dayStartUtc };
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
        sessions: readGithubSessions(read, read.section(raw, 'sessions', 'github'), repos, sessions),
        closedDays: read.integer(raw, 'closedDays', 'github', DEFAULT_GITHUB.closedDays, CONFIG_LIMITS.closedDays),
        everyMinutes: read.integer(raw, 'everyMinutes', 'github', DEFAULT_GITHUB.everyMinutes, CONFIG_LIMITS.githubEveryMinutes),
    };
}
/**
 * `github.sessions`: the session each repository's issues go to; a repository not in `github.repos` or a
 * session not on the team is reported and left out. Keys are kept in lowercase, as `repos` are.
 */
function readGithubSessions(read, raw, repos, team) {
    const owned = {};
    for (const repo of Object.keys(raw)) {
        const path = `github.sessions.${repo}`;
        const key = repo.toLowerCase();
        if (!repos.includes(key)) {
            read.report(path, 'is not one of github.repos');
            continue;
        }
        const session = read.optionalString(raw, repo, 'github.sessions', isSessionName);
        if (session === undefined) {
            continue;
        }
        if (!team.includes(session)) {
            read.report(path, `${describe(session)} is not one of the sessions`);
        }
        else if (owned[key] !== undefined) {
            read.report(path, 'is listed twice');
        }
        else {
            owned[key] = session;
        }
    }
    return owned;
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
const isPathText = (text) => (text.trim() === '' ? 'expected a path' : undefined);
/** A repository's or a deploy target's name in the coordinator block. */
const isCoordinatorName = (name) => /^[a-z0-9][a-z0-9._-]*$/.test(name) ? undefined : 'expected a name: lowercase letters, digits, ., _ or -, from a letter or digit';
function parseCoordinator(read, raw) {
    const path = 'coordinator';
    if (raw[MOVED_BUDGET_KEY] !== undefined) {
        read.report(`${path}.${MOVED_BUDGET_KEY}`, 'was moved: use the top-level budget block');
    }
    const dir = read.optionalString(raw, 'dir', path, isPathText);
    const schedule = read.section(raw, 'schedule', path);
    const heavyCutoffUtc = read.optionalString(schedule, 'heavyCutoffUtc', `${path}.schedule`, isUtcTime);
    const resetBlackoutHours = read.optionalInteger(schedule, 'resetBlackoutHours', `${path}.schedule`, CONFIG_LIMITS.resetBlackoutHours);
    const wait = read.section(raw, 'wait', path);
    const claims = read.section(raw, 'claims', path);
    const repos = parseCoordinatorRepos(read, read.section(raw, 'repos', path));
    return {
        ...(dir === undefined ? {} : { dir }),
        schedule: { ...(heavyCutoffUtc === undefined ? {} : { heavyCutoffUtc }), ...(resetBlackoutHours === undefined ? {} : { resetBlackoutHours }) },
        heavy: parseHeavy(read, read.section(raw, 'heavy', path)),
        wait: {
            pollSeconds: read.integer(wait, 'pollSeconds', `${path}.wait`, DEFAULT_COORDINATOR_WAIT.pollSeconds, CONFIG_LIMITS.coordinatorPollSeconds),
            maxMinutes: read.integer(wait, 'maxMinutes', `${path}.wait`, DEFAULT_COORDINATOR_WAIT.maxMinutes, CONFIG_LIMITS.coordinatorWaitMaxMinutes),
        },
        gateTimeoutSeconds: read.integer(raw, 'gateTimeoutSeconds', path, DEFAULT_GATE_TIMEOUT_SECONDS, CONFIG_LIMITS.gateTimeoutSeconds),
        claims: { maxMinutes: read.integer(claims, 'maxMinutes', `${path}.claims`, DEFAULT_CLAIMS.maxMinutes, CONFIG_LIMITS.claimMaxMinutes) },
        windows: parseWindows(read, read.section(raw, 'windows', path), deployTargetsOf(repos)),
        repos,
    };
}
/** When a deploy target's measurement is clean; a settle time for a target no repository deploys, or out of bounds, is reported and left out. */
function parseWindows(read, raw, knownTargets) {
    const path = 'coordinator.windows';
    const targetSettleMinutes = {};
    for (const [target, value] of Object.entries(read.section(raw, 'targetSettleMinutes', path))) {
        const itemPath = `${path}.targetSettleMinutes.${target}`;
        const badName = isCoordinatorName(target);
        if (badName !== undefined) {
            read.report(itemPath, badName);
            continue;
        }
        if (!knownTargets.includes(target)) {
            read.report(itemPath, `is not a target any repository deploys (known: ${knownTargets.join(', ') || 'none'})`);
            continue;
        }
        const minutes = read.integerItem(value, itemPath, CONFIG_LIMITS.settleMinutes);
        if (minutes !== undefined) {
            targetSettleMinutes[target] = minutes;
        }
    }
    return {
        settleMinutes: read.integer(raw, 'settleMinutes', path, DEFAULT_WINDOWS.settleMinutes, CONFIG_LIMITS.settleMinutes),
        targetSettleMinutes,
        assumedRollMinutes: read.integer(raw, 'assumedRollMinutes', path, DEFAULT_WINDOWS.assumedRollMinutes, CONFIG_LIMITS.assumedRollMinutes),
        minMinutes: read.integer(raw, 'minMinutes', path, DEFAULT_WINDOWS.minMinutes, CONFIG_LIMITS.windowMinMinutes),
    };
}
/** The repositories `teamrig integrate` lands and `teamrig roll` deploys, by name; one with a bad name or no main checkout is reported and left out. */
function parseCoordinatorRepos(read, raw) {
    const repos = {};
    for (const [name, value] of Object.entries(raw)) {
        const path = `coordinator.repos.${name}`;
        const entry = read.objectItem(value, path);
        if (entry === undefined) {
            continue;
        }
        const badName = isCoordinatorName(name);
        if (badName !== undefined) {
            read.report(path, badName);
            continue;
        }
        const mainCheckout = read.requiredString(entry, 'mainCheckout', path, isPathText);
        if (mainCheckout === '') {
            continue;
        }
        const roll = entry['roll'] === undefined ? undefined : parseRoll(read, entry['roll'], `${path}.roll`);
        const dependencyGate = read.boolean(entry, 'dependencyGate', path, false);
        const dependencyCheck = entry['dependencyCheck'] === undefined ? undefined : read.stringListItem(entry['dependencyCheck'], `${path}.dependencyCheck`, ROLL_ARGV_MAX_ITEMS);
        if (dependencyCheck !== undefined && !dependencyGate) {
            read.report(`${path}.dependencyCheck`, 'runs only with dependencyGate true, so it never runs');
        }
        repos[name] = {
            mainCheckout,
            deploysOnPush: read.stringList(entry, 'deploysOnPush', path, [], isCoordinatorName),
            dependencyGate,
            ...(dependencyCheck === undefined ? {} : { dependencyCheck }),
            followMainCheckout: read.boolean(entry, 'followMainCheckout', path, false),
            ...(roll === undefined ? {} : { roll }),
        };
    }
    return repos;
}
/** A program's arguments in a roll hook, and the hooks of one kind, at most. */
const ROLL_ARGV_MAX_ITEMS = 64;
const ROLL_HOOKS_MAX_ITEMS = 16;
/** A repository's roll; one with no usable command is reported and left out, so the repository is not rolled. */
function parseRoll(read, raw, path) {
    const entry = read.objectItem(raw, path);
    if (entry === undefined) {
        return undefined;
    }
    const command = read.stringListItem(entry['command'], `${path}.command`, ROLL_ARGV_MAX_ITEMS);
    if (command === undefined) {
        return undefined;
    }
    return {
        targets: read.stringList(entry, 'targets', path, [], isCoordinatorName),
        gates: read.list(entry, 'gates', path, [], (value, itemPath) => parseRollGate(read, value, itemPath), ROLL_HOOKS_MAX_ITEMS),
        afterPull: read.list(entry, 'afterPull', path, [], (value, itemPath) => read.stringListItem(value, itemPath, ROLL_ARGV_MAX_ITEMS), ROLL_HOOKS_MAX_ITEMS),
        command,
    };
}
/** One roll gate; one with a bad name or no usable command is reported and left out. */
function parseRollGate(read, value, path) {
    const entry = read.objectItem(value, path);
    if (entry === undefined) {
        return undefined;
    }
    const name = read.stringItem(entry['name'], `${path}.name`, isCoordinatorName);
    const command = read.stringListItem(entry['command'], `${path}.command`, ROLL_ARGV_MAX_ITEMS);
    return name === undefined || command === undefined ? undefined : { name, command };
}
/** The host lock and a heavy step's limits; a step longer than the lock less its margin is cut to fit, so it never outlives its lock. */
function parseHeavy(read, raw) {
    const path = 'coordinator.heavy';
    const lockPath = read.optionalString(raw, 'lockPath', path, isPathText);
    const lockTtlMinutes = read.integer(raw, 'lockTtlMinutes', path, DEFAULT_HEAVY.lockTtlMinutes, CONFIG_LIMITS.heavyLockTtlMinutes);
    const longest = lockTtlMinutes - HEAVY_TTL_MARGIN_MINUTES;
    const maxRunMinutes = read.integer(raw, 'maxRunMinutes', path, Math.min(DEFAULT_HEAVY.maxRunMinutes, longest), CONFIG_LIMITS.heavyMaxRunMinutes);
    if (maxRunMinutes > longest) {
        read.report(`${path}.maxRunMinutes`, `must be at most lockTtlMinutes less ${HEAVY_TTL_MARGIN_MINUTES} (${longest})`);
    }
    return {
        ...(lockPath === undefined ? {} : { lockPath }),
        lockTtlMinutes,
        maxRunMinutes: Math.min(maxRunMinutes, longest),
        waitMinutes: read.integer(raw, 'waitMinutes', path, DEFAULT_HEAVY.waitMinutes, CONFIG_LIMITS.heavyWaitMinutes),
    };
}
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
    const why = "the team's daily budget is the pace, recomputed at every reading from what is left of the week";
    read.dropped(raw, 'dailyPct', path, why);
    read.dropped(raw, 'maxDailyPct', path, why);
    const overAction = read.string(raw, 'overAction', path, defaults.overAction, oneOf(OVER_ACTIONS));
    const escalate = read.string(raw, 'escalate', path, defaults.escalate, oneOf(ESCALATIONS));
    const quietHours = parseQuietHours(read, raw);
    const statusSnapshotDir = read.optionalString(raw, 'statusSnapshotDir', path);
    return {
        enabled: read.boolean(raw, 'enabled', path, defaults.enabled),
        ...(weeklyLimitW === undefined ? {} : { weeklyLimitW }),
        subagentWeight: read.number(raw, 'subagentWeight', path, defaults.subagentWeight, CONFIG_LIMITS.subagentWeight),
        ...(reset === undefined ? {} : { reset }),
        targetPct,
        reservePct,
        paceEndHoursBeforeReset: read.number(raw, 'paceEndHoursBeforeReset', path, defaults.paceEndHoursBeforeReset, CONFIG_LIMITS.paceEndHoursBeforeReset),
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
    const paceWeight = read.optionalNumber(section, 'paceWeight', path, CONFIG_LIMITS.quietPaceWeight);
    return { startUtc, endUtc, action, ...(paceWeight === undefined ? {} : { paceWeight }) };
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
/** `budget.sessions`: a share for sessions on the team. */
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
        read.dropped(entry, 'dailyPct', path, "a session's daily budget is its part of the team's, by its share and queued work");
        budgets[id] = { share: read.number(entry, 'share', path, DEFAULT_SESSION_SHARE, CONFIG_LIMITS.sessionShare) };
    }
    return budgets;
}
/** A check that takes only the listed words. */
function oneOf(words) {
    return (value) => (words.includes(value) ? undefined : `expected one of ${words.join(', ')}`);
}
/** One recorded rule conflict: each field one line within its bound, the rule a core rule's key. */
function parseRuleConflict(read, value, path) {
    const conflict = read.objectItem(value, path);
    if (conflict === undefined) {
        return undefined;
    }
    const before = read.issues.length;
    const file = read.requiredString(conflict, 'file', path, shortLine(RULE_CONFLICT_LIMITS.fileMaxLength));
    const text = read.requiredString(conflict, 'text', path, shortLine(RULE_CONFLICT_LIMITS.textMaxLength));
    const rule = read.requiredString(conflict, 'rule', path, oneOf(CORE_RULE_KEYS));
    const wins = read.requiredString(conflict, 'wins', path, oneOf(CONFLICT_WINNERS));
    const reason = read.optionalString(conflict, 'reason', path, shortLine(RULE_CONFLICT_LIMITS.reasonMaxLength));
    if (read.issues.length !== before || !isCoreRuleKey(rule) || !isConflictWinner(wins)) {
        return undefined;
    }
    return { file, text, rule, wins, ...(reason === undefined ? {} : { reason }) };
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
        requireDescription: read.boolean(raw, 'requireDescription', path, defaults.requireDescription),
        requireEvidenceOnDone: read.boolean(raw, 'requireEvidenceOnDone', path, defaults.requireEvidenceOnDone),
        requireSkillOnDone: read.boolean(raw, 'requireSkillOnDone', path, defaults.requireSkillOnDone),
        requireNoteOn: read.list(raw, 'requireNoteOn', path, defaults.requireNoteOn, (value, itemPath) => parseStatus(read, value, itemPath), CONFIG_LIMITS.requireNoteOn.maxItems),
        requireFollowupsOn: read.list(raw, 'requireFollowupsOn', path, defaults.requireFollowupsOn, (value, itemPath) => parseFollowupStatus(read, value, itemPath), CONFIG_LIMITS.requireFollowupsOn.maxItems),
        autoArchive: read.boolean(raw, 'autoArchive', path, defaults.autoArchive),
        requireProofOnVerifying: read.boolean(raw, 'requireProofOnVerifying', path, defaults.requireProofOnVerifying),
        requireDecisionCard: read.boolean(raw, 'requireDecisionCard', path, defaults.requireDecisionCard),
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
/** A status that may need `--followups`: one of FOLLOWUP_STATUSES. */
function parseFollowupStatus(read, value, path) {
    if (typeof value === 'string' && FOLLOWUP_STATUSES.some((status) => status === value)) {
        return parseStatus(read, value, path);
    }
    read.report(path, `expected one of ${FOLLOWUP_STATUSES.join(', ')}, got ${describe(value)}`);
    return undefined;
}
function parseContextFiles(read, raw) {
    const path = 'contextFiles';
    const defaults = DEFAULT_CONTEXT_FILES;
    return {
        maxClaudeMdChars: read.integer(raw, 'maxClaudeMdChars', path, defaults.maxClaudeMdChars, CONFIG_LIMITS.claudeMdChars),
        maxMemoryIndexChars: read.integer(raw, 'maxMemoryIndexChars', path, defaults.maxMemoryIndexChars, CONFIG_LIMITS.memoryIndexChars),
        maxSkillListingChars: read.integer(raw, 'maxSkillListingChars', path, defaults.maxSkillListingChars, CONFIG_LIMITS.skillListingChars),
    };
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
function parseStatusLine(read, raw) {
    const path = 'statusLine';
    return {
        folder: read.boolean(raw, 'folder', path, DEFAULT_STATUS_LINE.folder),
        branch: read.boolean(raw, 'branch', path, DEFAULT_STATUS_LINE.branch),
        resume: read.boolean(raw, 'resume', path, DEFAULT_STATUS_LINE.resume),
    };
}
function parsePushToProtected(read, raw) {
    const fallback = DEFAULT_PUSH_GUARD.pushToProtected;
    const value = read.string(raw, 'pushToProtected', 'pushGuard', fallback, oneOf(PUSH_TO_PROTECTED));
    return isPushToProtected(value) ? value : fallback;
}
function parseAdHocRunners(read, raw) {
    const fallback = DEFAULT_PACKAGE_GUARD.adHocRunners;
    const value = read.string(raw, 'adHocRunners', 'packageGuard', fallback, oneOf(AD_HOC_RUNNERS));
    return isAdHocRunners(value) ? value : fallback;
}
const isShellPrefix = (value) => PREFIX_PATTERN.test(value) ? undefined : 'expected words of letters, digits and _ @ . / : = + -, one space apart, the first naming a program';
function parseReadonlyShell(read, raw) {
    const { maxItems, maxLength } = CONFIG_LIMITS.readonlyShellPrefixes;
    return {
        enabled: read.boolean(raw, 'enabled', 'readonlyShell', DEFAULT_READONLY_SHELL.enabled),
        allowPrefixes: read.stringList(raw, 'allowPrefixes', 'readonlyShell', DEFAULT_READONLY_SHELL.allowPrefixes, shortLine(maxLength, isShellPrefix), maxItems),
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
/** 0 turns the task count off. */
const REFRESH_TASKS = { min: 0, max: 100 };
/** Long enough to read the notice and type, short enough that the fresh start is not missed. */
const RESTART_DELAY_SECONDS = { min: 5, max: 600 };
/** A program and its arguments. */
const END_COMMAND_MAX_ITEMS = 16;
function parseRefresh(read, raw) {
    const path = 'refresh';
    const defaults = DEFAULT_REFRESH;
    const handoverDir = read.optionalString(raw, 'handoverDir', path);
    return {
        enabled: read.boolean(raw, 'enabled', path, defaults.enabled),
        contextTokens: read.integer(raw, 'contextTokens', path, defaults.contextTokens, REFRESH_TOKENS),
        everyTasks: read.integer(raw, 'everyTasks', path, defaults.everyTasks, REFRESH_TASKS),
        everyTasksMinTokens: read.integer(raw, 'everyTasksMinTokens', path, defaults.everyTasksMinTokens, REFRESH_TOKENS),
        tabTitle: read.boolean(raw, 'tabTitle', path, defaults.tabTitle),
        autoRestart: read.boolean(raw, 'autoRestart', path, defaults.autoRestart),
        restartDelaySeconds: read.integer(raw, 'restartDelaySeconds', path, defaults.restartDelaySeconds, RESTART_DELAY_SECONDS),
        endCommand: read.stringList(raw, 'endCommand', path, defaults.endCommand, undefined, END_COMMAND_MAX_ITEMS),
        ...(handoverDir === undefined ? {} : { handoverDir }),
    };
}
/** `hiring`: who decides, the session cap, idle and review days, and when a rehire resumes. */
function parseHiring(read, raw) {
    const path = 'hiring';
    const defaults = DEFAULT_HIRING;
    const policy = read.string(raw, 'policy', path, defaults.policy, oneOf(HIRING_POLICIES));
    const why = "a hire's daily budget is its part of the team's, by its share and queued work; maxSessions bounds hiring";
    read.dropped(raw, 'dailyPct', path, why);
    read.dropped(raw, 'maxDailyPct', path, why);
    return {
        policy: isHiringPolicy(policy) ? policy : defaults.policy,
        maxSessions: read.integer(raw, 'maxSessions', path, defaults.maxSessions, CONFIG_LIMITS.hiringMaxSessions),
        idleHours: read.integer(raw, 'idleHours', path, defaults.idleHours, CONFIG_LIMITS.hiringIdleHours),
        reviewDays: read.integer(raw, 'reviewDays', path, defaults.reviewDays, CONFIG_LIMITS.hiringReviewDays),
        resumeMaxTokens: read.integer(raw, 'resumeMaxTokens', path, defaults.resumeMaxTokens, CONFIG_LIMITS.hiringResumeMaxTokens),
        resumeMaxIdleDays: read.integer(raw, 'resumeMaxIdleDays', path, defaults.resumeMaxIdleDays, CONFIG_LIMITS.hiringResumeMaxIdleDays),
        scaleOut: parseScaleOut(read, read.section(raw, 'scaleOut', path)),
    };
}
/** `hiring.scaleOut`: how `check` measures an area's pace against its dated work. */
function parseScaleOut(read, raw) {
    const path = 'hiring.scaleOut';
    const defaults = DEFAULT_SCALE_OUT;
    return {
        windowDays: read.integer(raw, 'windowDays', path, defaults.windowDays, CONFIG_LIMITS.scaleOutWindowDays),
        minDone: read.integer(raw, 'minDone', path, defaults.minDone, CONFIG_LIMITS.scaleOutMinDone),
        topPriorities: read.integer(raw, 'topPriorities', path, defaults.topPriorities, CONFIG_LIMITS.scaleOutTopPriorities),
    };
}
/** `burst`: who starts one, its surplus trigger and its caps. */
function parseBurst(read, raw) {
    const path = 'burst';
    const defaults = DEFAULT_BURST;
    const policy = read.string(raw, 'policy', path, defaults.policy, oneOf(BURST_POLICIES));
    return {
        policy: isBurstPolicy(policy) ? policy : defaults.policy,
        surplusHours: read.integer(raw, 'surplusHours', path, defaults.surplusHours, CONFIG_LIMITS.burstSurplusHours),
        minSparePct: read.number(raw, 'minSparePct', path, defaults.minSparePct, CONFIG_LIMITS.burstMinSparePct),
        maxHelpers: read.integer(raw, 'maxHelpers', path, defaults.maxHelpers, CONFIG_LIMITS.burstMaxHelpers),
        maxHires: read.integer(raw, 'maxHires', path, defaults.maxHires, CONFIG_LIMITS.burstMaxHires),
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
