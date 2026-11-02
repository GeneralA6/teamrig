import { deployTargetsOf } from "../delivery/targets.js";
import { ADDRESS_PATTERN, splitAddress } from "../core/address.js";
import { isRecord } from "../core/guards.js";
import { isReservedName, NAME_PATTERN, NAME_RULE, RESERVED_NAMES } from "../core/ids.js";
import { isMinuteInSpan, utcMinuteOf } from "../core/time.js";
import { TimeZone } from "../core/zone.js";
import { FOLLOWUP_STATUSES, isTaskStatus, LEGACY_WAITING_HINT, LEGACY_WAITING_STATUS, REVIEW_STATUSES, SESSION_NAME, TASK_STATUSES } from "../register/model.js";
import { KEEP_RULE_PATTERN } from "../permissions/allow-rules.js";
import { PREFIX_PATTERN } from "../readonly-shell/rules.js";
import { CORE_RULE_KEYS, isCoreRuleKey } from "../rules/keys.js";
import { DEFAULT_ALERTS, DEFAULT_BUDGET, DEFAULT_BURST, DEFAULT_COMMITS, DEFAULT_CONTEXT_FILES, DEFAULT_FREEZES, DEFAULT_DECISIONS, DEFAULT_DELIVERY_WAIT, DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_GITHUB, DEFAULT_QUEUE, DEFAULT_HIRING, DEFAULT_EXEC, DEFAULT_LOCK, DEFAULT_LEAD_BOUNDARY, DEFAULT_TURN_LOG, DEFAULT_LOOPS, DEFAULT_MERGE_REMOTE, DEFAULT_MESSAGES, DEFAULT_HEADROOM, DEFAULT_IDLE, DEFAULT_OPEN, DEFAULT_OWNER_GATES, DEFAULT_COMMIT_GUARD, DEFAULT_SECRET_GUARD, DEFAULT_PACKAGE_GUARD, DEFAULT_PERMISSIONS, DEFAULT_PROMPTS, DEFAULT_PUSH_GUARD, DEFAULT_READONLY_SHELL, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_SCALE_OUT, DEFAULT_SESSION_SHARE, DEFAULT_SKILLS, DEFAULT_STATUS_LINE, DEFAULT_TESTS, DEFAULT_WAKE, DEFAULT_STABLE_PERIODS, QUEUE_TTL_MARGIN_MINUTES, } from "./defaults.js";
import { isEffort, isModel } from "./launch.js";
import { BUDGET_ACCOUNT_MAX_LENGTH, CONFIG_LIMITS, GITHUB_LABEL_MAX_LENGTH, REVIEW_PATH_LIMITS, RULE_CONFLICT_LIMITS } from "./limits.js";
import { HIRE_CAP_DROPPED, IDLE_RETIRE_DROPPED } from "./migrate.js";
import { ConfigReader, describe, isValidRegex, shortLine } from "./reader.js";
import { AD_HOC_RUNNERS, ASK_WITH, PACKAGE_INSTALLS, BURST_POLICIES, CONFLICT_WINNERS, ESCALATIONS, GOALS_MODES, HIRING_POLICIES, isAdHocRunners, isAskWith, isPackageInstalls, isBurstPolicy, isCommitGate, isConflictWinner, isEffortLevel, isEscalation, isGoalsMode, isHiringPolicy, isOverAction, isHookAsks, isIdleMode, isOtherAreaListing, isPushToProtected, isReviewClass, isReviewPathMode, isSecretReads, isSecretWrites, isSkipHooks, isTerminalChoice, isReviewMode, isVerifyGate, isWeekday, HOOK_ASKS, IDLE_MODES, OTHER_AREA_LISTINGS, OVER_ACTIONS, PUSH_TO_PROTECTED, REVIEW_CLASSES, REVIEW_PATH_MODES, SECRET_READS, SECRET_WRITES, SKIP_HOOKS, TERMINALS, REVIEW_MODES, VERIFY_GATES, WEEKDAYS, } from "./types.js";
const isSessionName = (name) => SESSION_NAME.test(name) ? undefined : 'expected a lowercase name: a letter, then letters, digits or -, at most 32';
/** A role a team may leave to a team above it (ANCESTOR_ROLES): one of its sessions, or `<team>/<id>` (T1143). */
const isRoleHolder = (holder) => SESSION_NAME.test(holder) || ADDRESS_PATTERN.test(holder) ? undefined : 'expected a session id of the team, or <team>/<id> of a team above it';
const isTimeZone = (name) => (TimeZone.of(name) === undefined ? 'expected an IANA time zone name such as Asia/Jerusalem' : undefined);
const isUtcTime = (time) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? undefined : 'expected a UTC time as HH:MM');
/** A repository as GitHub names it: an owner login, a slash, then letters, digits, `.`, `_` or `-`. */
const isRepoName = (repo) => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i.test(repo) ? undefined : 'expected a GitHub repository as owner/name';
/** A GitHub login: letters, digits or -, starting with a letter or digit, at most 39 characters. */
const GITHUB_LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const BRANCH_NAME = (name) => (/^[^\s~^:?*[\\]+$/.test(name) ? undefined : 'not a valid branch name');
/**
 * A path absolute from a drive or the root (`C:/tools`, `C:\tools`, `/usr/bin`, `\srv\app`, `\\host\share`) on any
 * host, as Windows' `isAbsolute` takes it, without `node:path`: the read entry parses the config where Node's
 * built-ins are missing.
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?[\\/]/;
/**
 * An `exec.path` folder: absolute ({@link ABSOLUTE_PATH}), never against the cwd, and with no `;` or `:` past the
 * drive, so joining the list into one PATH cannot split a folder or add one.
 */
const EXEC_DIRECTORY = (folder) => {
    if (!ABSOLUTE_PATH.test(folder)) {
        return 'expected an absolute folder, such as C:/tools or /usr/bin';
    }
    return /^(?:[A-Za-z]:)?[^;:]*$/.test(folder) ? undefined : 'expected no ; or : past the drive';
};
/** An environment variable's name, such as `EXEC_WEBHOOK_URL`: what a config key names in place of a secret value. */
const ENV_VARIABLE = (name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? undefined : 'expected a variable name: a letter or _, then at most 63 letters, digits or _';
/** The key shape the skills lint recognises in frontmatter. */
const isFrontmatterKey = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? undefined : 'expected a frontmatter key: letters, digits, _ or -');
/** A git trailer key, such as `Large-commit`. */
const isTrailerKey = (key) => /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(key) ? undefined : 'expected a trailer key: a letter, then at most 39 letters, digits or -';
const isDisplayName = (name) => {
    if (!NAME_PATTERN.test(name)) {
        return `expected a name: ${NAME_RULE}`;
    }
    return isReservedName(name) ? `expected a name Claude Code does not keep for itself (${RESERVED_NAMES.join(', ')}): a message to one never reaches a session` : undefined;
};
/**
 * `names`: only sessions on the team, each name unique, never another session's id and never one Claude Code reserves,
 * so a command or a message given a name finds exactly one session.
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
/** Why a member cannot be listed under `subLead`, or undefined; `leaderOf` holds the members listed so far. */
function memberProblem(member, subLead, sessions, lead, leaderOf) {
    if (!sessions.includes(member)) {
        return `${describe(member)} is not one of the sessions`;
    }
    if (member === lead) {
        return `${describe(member)} is the lead, which no one leads`;
    }
    if (member === subLead) {
        return `${describe(member)} is the sub-lead itself`;
    }
    const leader = leaderOf.get(member);
    return leader === undefined ? undefined : `${describe(member)} is already led by ${leader}; a session has one leader`;
}
/** The sub-lead's leaders upward through `leaderOf`, stopping at the first repeat; it is a cycle when that is `subLead`. */
function leadsItself(subLead, leaderOf) {
    const seen = new Set();
    for (let leader = leaderOf.get(subLead); leader !== undefined && !seen.has(leader); leader = leaderOf.get(leader)) {
        if (leader === subLead) {
            return true;
        }
        seen.add(leader);
    }
    return false;
}
/**
 * `leads`: each sub-lead's members (T781). The tree stays whole: a sub-lead and its members are sessions, the lead is
 * neither, a session is listed once, and no sub-lead leads itself, even through others. A wrong member is reported and
 * left out, and so is a sub-lead left with none or caught in a cycle, so those sessions stay with the leader above.
 */
function readLeads(read, raw, sessions, lead) {
    const leads = new Map();
    const leaderOf = new Map();
    for (const subLead of Object.keys(raw)) {
        const path = `leads.${subLead}`;
        const listed = read.list(raw, subLead, 'leads', [], (value, itemPath) => read.stringItem(value, itemPath, isSessionName));
        if (!sessions.includes(subLead) || subLead === lead) {
            read.report(path, subLead === lead ? 'is the lead, which leads every session no sub-lead lists; list sub-leads only' : 'is not one of the sessions');
            continue;
        }
        const members = [];
        for (const member of listed) {
            const problem = memberProblem(member, subLead, sessions, lead, leaderOf);
            if (problem === undefined) {
                members.push(member);
                leaderOf.set(member, subLead);
            }
            else {
                read.report(path, problem);
            }
        }
        if (members.length === 0) {
            read.report(path, 'lists no member; a sub-lead leads at least one session');
            continue;
        }
        leads.set(subLead, members);
    }
    for (const [subLead, members] of [...leads]) {
        if (leadsItself(subLead, leaderOf)) {
            read.report(`leads.${subLead}`, 'leads itself through its members; a sub-lead cannot be under its own group');
            for (const member of members) {
                leaderOf.delete(member);
            }
            leads.delete(subLead);
        }
    }
    return Object.fromEntries(leads);
}
/** A folder named in full, on one line: a relative one would turn on whichever folder a command runs in. */
const isAbsoluteFolder = (text) => (/[\r\n]/.test(text) || !ABSOLUTE_PATH.test(text) ? 'expected an absolute folder path on one line' : undefined);
/** A file named in full, on one line: a hook reads it from whichever folder its session runs in. */
const isAbsoluteFile = (text) => (/[\r\n]/.test(text) || !ABSOLUTE_PATH.test(text) ? 'expected an absolute file path on one line' : undefined);
/**
 * `launch`: a model, an effort and a project folder for sessions on the team. A wrong field is reported and
 * left out, so the session starts on Claude Code's own choice (or, for the lead, the lead's default) for it,
 * and in the team's folder.
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
        const project = read.optionalString(entry, 'project', path, isAbsoluteFolder);
        launch[id] = {
            ...(model === undefined ? {} : { model }),
            ...(isEffortLevel(effort) ? { effort } : {}),
            ...(project === undefined ? {} : { project }),
        };
    }
    return launch;
}
/**
 * `team`: the team's id and its parent's, both ids, and its project folder. Only the shape is checked here;
 * whether the id matches the team's folder and the parent exists is the tree's to judge, as it sees every team,
 * and whether the project folder exists is `doctor`'s.
 */
function readTeam(read, raw) {
    const value = raw['team'];
    const section = read.section(raw, 'team', '');
    if (!isRecord(value)) {
        return undefined;
    }
    const id = read.requiredString(section, 'id', 'team', isSessionName);
    const parent = read.optionalString(section, 'parent', 'team', isSessionName);
    const project = read.optionalString(section, 'project', 'team', isAbsoluteFolder);
    if (id === '') {
        return undefined;
    }
    const where = project === undefined ? {} : { project };
    if (parent === id) {
        read.report('team.parent', 'is the team itself; a root team has no parent');
        return { id, ...where };
    }
    return { id, ...(parent === undefined ? {} : { parent }), ...where };
}
/**
 * Validates a migrated config object against the current format; `above` is the team above's budget keys of the
 * account's week, for those it leaves unset (`AccountBudget`).
 */
export function parseConfig(raw, above) {
    const read = new ConfigReader();
    const sessions = read.list(raw, 'sessions', '', [], (value, path) => read.stringItem(value, path, isSessionName));
    if (raw['sessions'] === undefined) {
        read.report('sessions', 'is required: list every session id on the team');
    }
    const rolesRaw = read.section(raw, 'roles', '');
    const lead = read.requiredString(rolesRaw, 'lead', 'roles', isSessionName);
    reportRenamedKey(read, rolesRaw, 'roles', 'coordinatorOwner', 'deliveryOwner');
    const deliveryOwner = read.optionalString(rolesRaw, 'deliveryOwner', 'roles', isRoleHolder);
    const securityReviewer = read.optionalString(rolesRaw, 'securityReviewer', 'roles', isRoleHolder);
    for (const [key, name] of [
        ['lead', lead],
        ['deliveryOwner', deliveryOwner],
        ['securityReviewer', securityReviewer],
    ]) {
        // A holder on a team above is the tree's to check (tree-role), as only the tree sees that team.
        if (name !== undefined && name !== '' && sessions.length > 0 && !ADDRESS_PATTERN.test(name) && !sessions.includes(name)) {
            read.report(`roles.${key}`, `${describe(name)} is not one of the sessions`);
        }
    }
    if (new Set(sessions).size !== sessions.length) {
        read.report('sessions', 'lists a session more than once');
    }
    const names = readNames(read, read.section(raw, 'names', ''), sessions);
    const leads = readLeads(read, read.section(raw, 'leads', ''), sessions, lead);
    const launch = readLaunch(read, read.section(raw, 'launch', ''), sessions);
    const team = readTeam(read, raw);
    for (const [key, holder] of [
        ['deliveryOwner', deliveryOwner],
        ['securityReviewer', securityReviewer],
    ]) {
        const at = holder === undefined ? undefined : splitAddress(holder)?.team;
        if (at !== undefined && at === team?.id) {
            read.report(`roles.${key}`, `names its own team ${at}: write the bare id`);
        }
    }
    const timeZone = read.optionalString(raw, 'timeZone', '', isTimeZone);
    const messages = read.section(raw, 'messages', '');
    const pushGuard = read.section(raw, 'pushGuard', '');
    const lock = read.section(raw, 'lock', '');
    const tabStatus = read.section(raw, 'tabStatus', '');
    const pickerGuard = read.section(raw, 'pickerGuard', '');
    const budget = parseBudget(read, read.section(raw, 'budget', ''), sessions, above);
    const decisions = read.section(raw, 'decisions', '');
    reportRenamedKey(read, raw, '', 'coordinator', 'delivery');
    const config = {
        configVersion: read.integer(raw, 'configVersion', '', 1, { min: 1 }),
        ...(team === undefined ? {} : { team }),
        ...(timeZone === undefined ? {} : { timeZone }),
        sessions,
        names,
        roles: {
            lead,
            ...(deliveryOwner === undefined ? {} : { deliveryOwner }),
            ...(securityReviewer === undefined ? {} : { securityReviewer }),
        },
        leads,
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
        exec: parseExec(read, read.section(raw, 'exec', '')),
        pushGuard: {
            protectedBranches: read.stringList(pushGuard, 'protectedBranches', 'pushGuard', DEFAULT_PUSH_GUARD.protectedBranches, shortLine(CONFIG_LIMITS.protectedBranches.maxLength, BRANCH_NAME), CONFIG_LIMITS.protectedBranches.maxItems),
            pushToProtected: parsePushToProtected(read, pushGuard),
            reviewPaths: read.list(pushGuard, 'reviewPaths', 'pushGuard', DEFAULT_PUSH_GUARD.reviewPaths, (value, itemPath) => parseReviewPath(read, value, itemPath), CONFIG_LIMITS.reviewPaths.maxItems),
        },
        packageGuard: parsePackageGuard(read, read.section(raw, 'packageGuard', '')),
        commitGuard: { skipHooks: parseSkipHooks(read, read.section(raw, 'commitGuard', '')) },
        prompts: { hookAsks: parseHookAsks(read, read.section(raw, 'prompts', '')) },
        secretGuard: parseSecretGuard(read, read.section(raw, 'secretGuard', '')),
        commits: parseCommits(read, read.section(raw, 'commits', '')),
        delivery: parseDelivery(read, read.section(raw, 'delivery', '')),
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
        alerts: parseAlerts(read, read.section(raw, 'alerts', '')),
        decisions: {
            batchTimesUtc: read.stringList(decisions, 'batchTimesUtc', 'decisions', DEFAULT_DECISIONS.batchTimesUtc, isUtcTime, CONFIG_LIMITS.decisionBatchTimes.maxItems),
            batchAt: read.integer(decisions, 'batchAt', 'decisions', DEFAULT_DECISIONS.batchAt, CONFIG_LIMITS.decisionBatchAt),
            askWith: parseAskWith(read, decisions),
        },
        tabStatus: { enabled: read.boolean(tabStatus, 'enabled', 'tabStatus', false) },
        pickerGuard: { enabled: read.boolean(pickerGuard, 'enabled', 'pickerGuard', false) },
        turnLog: parseTurnLog(read, read.section(raw, 'turnLog', '')),
        readonlyShell: parseReadonlyShell(read, read.section(raw, 'readonlyShell', '')),
        permissions: parsePermissions(read, read.section(raw, 'permissions', '')),
        refresh: parseRefresh(read, read.section(raw, 'refresh', '')),
        hiring: parseHiring(read, read.section(raw, 'hiring', '')),
        burst: parseBurst(read, read.section(raw, 'burst', '')),
        open: parseOpen(read, read.section(raw, 'open', ''), sessions),
        statusLine: parseStatusLine(read, read.section(raw, 'statusLine', '')),
        launch,
        paths: parsePaths(read, read.section(raw, 'paths', '')),
    };
    return { config, issues: read.issues };
}
/** `turnLog`: kept from an hour to a week. */
function parseTurnLog(read, raw) {
    return {
        enabled: read.boolean(raw, 'enabled', 'turnLog', DEFAULT_TURN_LOG.enabled),
        keepHours: read.integer(raw, 'keepHours', 'turnLog', DEFAULT_TURN_LOG.keepHours, CONFIG_LIMITS.turnLogKeepHours),
    };
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
        acceptLabel: read.string(raw, 'acceptLabel', 'github', DEFAULT_GITHUB.acceptLabel, shortLine(GITHUB_LABEL_MAX_LENGTH)),
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
/** The budget's old place, `coordinator.budget`, now `delivery.budget`; it moved to the top-level `budget` block, with no alias. */
const MOVED_BUDGET_KEY = 'budget';
/**
 * Reports `raw`'s `from`, below `path` ('' for the top level), as renamed to `to`. The v4-to-v5 and v7-to-v8
 * migrations rename each key they name (src/config/migrate.ts), so a current file holds one only when written so by
 * hand, and it is read as nothing, never as an alias.
 */
function reportRenamedKey(read, raw, path, from, to) {
    const at = (key) => (path === '' ? key : `${path}.${key}`);
    if (raw[from] !== undefined) {
        read.report(at(from), `was renamed: use ${at(to)}`);
    }
}
const isPathText = (text) => (text.trim() === '' ? 'expected a path' : undefined);
/** A repository's or a deploy target's name in the delivery block. */
const isDeliveryName = (name) => /^[a-z0-9][a-z0-9._-]*$/.test(name) ? undefined : 'expected a name: lowercase letters, digits, ., _ or -, from a letter or digit';
function parseDelivery(read, raw) {
    const path = 'delivery';
    if (raw[MOVED_BUDGET_KEY] !== undefined) {
        read.report(`${path}.${MOVED_BUDGET_KEY}`, 'was moved: use the top-level budget block');
    }
    reportRenamedKey(read, raw, path, 'gateTimeoutSeconds', 'checkTimeoutSeconds');
    reportRenamedKey(read, raw, path, 'heavy', 'queue');
    reportRenamedKey(read, raw, path, 'claims', 'freezes');
    reportRenamedKey(read, raw, path, 'windows', 'stablePeriods');
    const dir = read.optionalString(raw, 'dir', path, isPathText);
    const schedule = read.section(raw, 'schedule', path);
    reportRenamedKey(read, schedule, `${path}.schedule`, 'heavyCutoffUtc', 'queueCutoffUtc');
    const queueCutoffUtc = read.optionalString(schedule, 'queueCutoffUtc', `${path}.schedule`, isUtcTime);
    const resetBlackoutHours = read.optionalInteger(schedule, 'resetBlackoutHours', `${path}.schedule`, CONFIG_LIMITS.resetBlackoutHours);
    const wait = read.section(raw, 'wait', path);
    const freezes = read.section(raw, 'freezes', path);
    const repos = parseDeliveryRepos(read, read.section(raw, 'repos', path));
    return {
        ...(dir === undefined ? {} : { dir }),
        schedule: { ...(queueCutoffUtc === undefined ? {} : { queueCutoffUtc }), ...(resetBlackoutHours === undefined ? {} : { resetBlackoutHours }) },
        queue: parseQueue(read, read.section(raw, 'queue', path)),
        wait: {
            pollSeconds: read.integer(wait, 'pollSeconds', `${path}.wait`, DEFAULT_DELIVERY_WAIT.pollSeconds, CONFIG_LIMITS.deliveryPollSeconds),
            maxMinutes: read.integer(wait, 'maxMinutes', `${path}.wait`, DEFAULT_DELIVERY_WAIT.maxMinutes, CONFIG_LIMITS.deliveryWaitMaxMinutes),
        },
        checkTimeoutSeconds: read.integer(raw, 'checkTimeoutSeconds', path, DEFAULT_CHECK_TIMEOUT_SECONDS, CONFIG_LIMITS.checkTimeoutSeconds),
        freezes: { maxMinutes: read.integer(freezes, 'maxMinutes', `${path}.freezes`, DEFAULT_FREEZES.maxMinutes, CONFIG_LIMITS.freezeMaxMinutes) },
        stablePeriods: parseStablePeriods(read, read.section(raw, 'stablePeriods', path), deployTargetsOf(repos)),
        repos,
    };
}
/** When a deploy target's measurement is clean; a settle time for a target no repository deploys, or out of bounds, is reported and left out. */
function parseStablePeriods(read, raw, knownTargets) {
    const path = 'delivery.stablePeriods';
    reportRenamedKey(read, raw, path, 'assumedRollMinutes', 'assumedDeployMinutes');
    const targetSettleMinutes = {};
    for (const [target, value] of Object.entries(read.section(raw, 'targetSettleMinutes', path))) {
        const itemPath = `${path}.targetSettleMinutes.${target}`;
        const badName = isDeliveryName(target);
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
        settleMinutes: read.integer(raw, 'settleMinutes', path, DEFAULT_STABLE_PERIODS.settleMinutes, CONFIG_LIMITS.settleMinutes),
        targetSettleMinutes,
        assumedDeployMinutes: read.integer(raw, 'assumedDeployMinutes', path, DEFAULT_STABLE_PERIODS.assumedDeployMinutes, CONFIG_LIMITS.assumedDeployMinutes),
        minMinutes: read.integer(raw, 'minMinutes', path, DEFAULT_STABLE_PERIODS.minMinutes, CONFIG_LIMITS.stablePeriodMinMinutes),
    };
}
/** The repositories `teamrig merge` merges into and `teamrig deploy` deploys, by name; one with a bad name or no main checkout is reported and left out. */
function parseDeliveryRepos(read, raw) {
    const repos = {};
    for (const [name, value] of Object.entries(raw)) {
        const path = `delivery.repos.${name}`;
        const entry = read.objectItem(value, path);
        if (entry === undefined) {
            continue;
        }
        const badName = isDeliveryName(name);
        if (badName !== undefined) {
            read.report(path, badName);
            continue;
        }
        const mainCheckout = read.requiredString(entry, 'mainCheckout', path, isPathText);
        if (mainCheckout === '') {
            continue;
        }
        const merge = entry['merge'] === undefined ? undefined : parseMerge(read, entry['merge'], `${path}.merge`);
        reportRenamedKey(read, entry, path, 'roll', 'deploy');
        const deploy = entry['deploy'] === undefined ? undefined : parseDeploy(read, entry['deploy'], `${path}.deploy`);
        const dependencyGate = read.boolean(entry, 'dependencyGate', path, false);
        const dependencyCheck = entry['dependencyCheck'] === undefined ? undefined : read.stringListItem(entry['dependencyCheck'], `${path}.dependencyCheck`, HOOK_ARGV_MAX_ITEMS);
        if (dependencyCheck !== undefined && !dependencyGate) {
            read.report(`${path}.dependencyCheck`, 'runs only with dependencyGate true, so it never runs');
        }
        const reviewGate = read.boolean(entry, 'reviewGate', path, false);
        const reviewCheck = entry['reviewCheck'] === undefined ? undefined : read.stringListItem(entry['reviewCheck'], `${path}.reviewCheck`, HOOK_ARGV_MAX_ITEMS);
        if (reviewCheck !== undefined && !reviewGate) {
            read.report(`${path}.reviewCheck`, 'runs only with reviewGate true, so it never runs');
        }
        reportRenamedKey(read, entry, path, 'followMainCheckout', 'updateMainCheckout');
        const worktreeFolder = read.optionalString(entry, 'worktreeFolder', path, isPathText);
        const worktreeSetup = entry['worktreeSetup'] === undefined ? undefined : read.stringListItem(entry['worktreeSetup'], `${path}.worktreeSetup`, HOOK_ARGV_MAX_ITEMS);
        repos[name] = {
            mainCheckout,
            deploysOnPush: read.stringList(entry, 'deploysOnPush', path, [], isDeliveryName),
            dependencyGate,
            ...(dependencyCheck === undefined ? {} : { dependencyCheck }),
            reviewGate,
            ...(reviewCheck === undefined ? {} : { reviewCheck }),
            updateMainCheckout: read.boolean(entry, 'updateMainCheckout', path, false),
            ...(worktreeFolder === undefined ? {} : { worktreeFolder }),
            ...(worktreeSetup === undefined ? {} : { worktreeSetup }),
            ...(merge === undefined ? {} : { merge }),
            ...(deploy === undefined ? {} : { deploy }),
        };
    }
    return repos;
}
/** A repository's merge command; one with no usable command is reported and left out, so `teamrig merge` pushes the branch. */
function parseMerge(read, raw, path) {
    const entry = read.objectItem(raw, path);
    if (entry === undefined) {
        return undefined;
    }
    const command = read.stringListItem(entry['command'], `${path}.command`, HOOK_ARGV_MAX_ITEMS);
    const remote = read.string(entry, 'remote', path, DEFAULT_MERGE_REMOTE, isRemoteName);
    return command === undefined ? undefined : { command, remote };
}
/** A git remote's name, as `git remote add` takes it; it never starts with `-`, so git cannot read it as an option. */
const isRemoteName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') ? undefined : 'expected a git remote name: letters, digits, ., _ or -, from a letter or digit, without ..';
/** A program's arguments in a deploy or merge hook, and the deploy hooks of one kind, at most. */
const HOOK_ARGV_MAX_ITEMS = 64;
const DEPLOY_HOOKS_MAX_ITEMS = 16;
/** A repository's deploy block; one with no usable command is reported and left out, so the repository is not deployed. */
function parseDeploy(read, raw, path) {
    const entry = read.objectItem(raw, path);
    if (entry === undefined) {
        return undefined;
    }
    const command = read.stringListItem(entry['command'], `${path}.command`, HOOK_ARGV_MAX_ITEMS);
    if (command === undefined) {
        return undefined;
    }
    const dependencyInstall = entry['dependencyInstall'] === undefined ? undefined : read.stringListItem(entry['dependencyInstall'], `${path}.dependencyInstall`, HOOK_ARGV_MAX_ITEMS);
    reportRenamedKey(read, entry, path, 'gates', 'checks');
    return {
        targets: read.stringList(entry, 'targets', path, [], isDeliveryName),
        checks: read.list(entry, 'checks', path, [], (value, itemPath) => parseDeployCheck(read, value, itemPath), DEPLOY_HOOKS_MAX_ITEMS),
        ...(dependencyInstall === undefined ? {} : { dependencyInstall }),
        afterPull: read.list(entry, 'afterPull', path, [], (value, itemPath) => read.stringListItem(value, itemPath, HOOK_ARGV_MAX_ITEMS), DEPLOY_HOOKS_MAX_ITEMS),
        command,
    };
}
/** One check of a deploy; one with a bad name or no usable command is reported and left out. */
function parseDeployCheck(read, value, path) {
    const entry = read.objectItem(value, path);
    if (entry === undefined) {
        return undefined;
    }
    const name = read.stringItem(entry['name'], `${path}.name`, isDeliveryName);
    const command = read.stringListItem(entry['command'], `${path}.command`, HOOK_ARGV_MAX_ITEMS);
    return name === undefined || command === undefined ? undefined : { name, command };
}
/**
 * The host lock and a queued step's limits; a step longer than the lock less its margin is cut to fit, so it never
 * outlives its lock, and a small step's limit longer than a step's is cut to it.
 */
function parseQueue(read, raw) {
    const path = 'delivery.queue';
    const lockPath = read.optionalString(raw, 'lockPath', path, isPathText);
    const lockTtlMinutes = read.integer(raw, 'lockTtlMinutes', path, DEFAULT_QUEUE.lockTtlMinutes, CONFIG_LIMITS.queueLockTtlMinutes);
    const longest = lockTtlMinutes - QUEUE_TTL_MARGIN_MINUTES;
    const maxRunMinutes = read.integer(raw, 'maxRunMinutes', path, Math.min(DEFAULT_QUEUE.maxRunMinutes, longest), CONFIG_LIMITS.queueMaxRunMinutes);
    if (maxRunMinutes > longest) {
        read.report(`${path}.maxRunMinutes`, `must be at most lockTtlMinutes less ${QUEUE_TTL_MARGIN_MINUTES} (${longest})`);
    }
    const longestRun = Math.min(maxRunMinutes, longest);
    const smallMaxRunMinutes = read.integer(raw, 'smallMaxRunMinutes', path, Math.min(DEFAULT_QUEUE.smallMaxRunMinutes, longestRun), CONFIG_LIMITS.queueSmallMaxRunMinutes);
    if (smallMaxRunMinutes > longestRun) {
        read.report(`${path}.smallMaxRunMinutes`, `must be at most maxRunMinutes (${longestRun})`);
    }
    return {
        ...(lockPath === undefined ? {} : { lockPath }),
        lockTtlMinutes,
        maxRunMinutes: longestRun,
        smallMaxRunMinutes: Math.min(smallMaxRunMinutes, longestRun),
        waitMinutes: read.integer(raw, 'waitMinutes', path, DEFAULT_QUEUE.waitMinutes, CONFIG_LIMITS.queueWaitMinutes),
        memorySampleSeconds: read.integer(raw, 'memorySampleSeconds', path, DEFAULT_QUEUE.memorySampleSeconds, CONFIG_LIMITS.queueMemorySampleSeconds),
        memoryFloorMb: read.integer(raw, 'memoryFloorMb', path, DEFAULT_QUEUE.memoryFloorMb, CONFIG_LIMITS.queueMemoryFloorMb),
        smallReserveMb: read.integer(raw, 'smallReserveMb', path, DEFAULT_QUEUE.smallReserveMb, CONFIG_LIMITS.queueSmallReserveMb),
    };
}
/** The budget block; a key of the account's week it leaves unset is `above`'s, the team above's (`AccountBudget`). */
function parseBudget(read, raw, sessions, above) {
    const path = 'budget';
    const defaults = DEFAULT_BUDGET;
    const targetPct = read.number(raw, 'targetPct', path, defaults.targetPct, CONFIG_LIMITS.budgetTargetPct);
    const reservePct = read.number(raw, 'reservePct', path, defaults.reservePct, CONFIG_LIMITS.budgetReservePct);
    if (targetPct + reservePct > 100) {
        read.report(`${path}.reservePct`, `with targetPct it passes 100% of the week (${targetPct} + ${reservePct})`);
    }
    const stated = read.optionalString(raw, 'account', path, shortLine(BUDGET_ACCOUNT_MAX_LENGTH));
    // The team above's keys describe its account's week: a team that names another account takes none of them.
    const inherited = stated === undefined || stated === above?.account ? above : undefined;
    const account = stated ?? inherited?.account;
    const weeklyLimitW = read.optionalInteger(raw, 'weeklyLimitW', path, CONFIG_LIMITS.weeklyLimitW) ?? inherited?.weeklyLimitW;
    const extraWPerUsd = read.optionalInteger(raw, 'extraWPerUsd', path, CONFIG_LIMITS.extraWPerUsd) ?? inherited?.extraWPerUsd;
    const reset = parseBudgetReset(read, raw) ?? inherited?.reset;
    const why = "the team's daily budget is the pace, recomputed at every reading from what is left of the week";
    read.dropped(raw, 'dailyPct', path, why);
    read.dropped(raw, 'maxDailyPct', path, why);
    const overAction = read.string(raw, 'overAction', path, defaults.overAction, oneOf(OVER_ACTIONS));
    const escalate = read.string(raw, 'escalate', path, defaults.escalate, oneOf(ESCALATIONS));
    const quietHours = parseQuietHours(read, raw);
    const statusSnapshotDir = read.optionalString(raw, 'statusSnapshotDir', path);
    return {
        enabled: read.boolean(raw, 'enabled', path, inherited?.enabled ?? defaults.enabled),
        ...(account === undefined ? {} : { account }),
        ...(weeklyLimitW === undefined ? {} : { weeklyLimitW }),
        subagentWeight: read.number(raw, 'subagentWeight', path, inherited?.subagentWeight ?? defaults.subagentWeight, CONFIG_LIMITS.subagentWeight),
        ...(extraWPerUsd === undefined ? {} : { extraWPerUsd }),
        ...(reset === undefined ? {} : { reset }),
        targetPct,
        reservePct,
        paceEndHoursBeforeReset: read.number(raw, 'paceEndHoursBeforeReset', path, defaults.paceEndHoursBeforeReset, CONFIG_LIMITS.paceEndHoursBeforeReset),
        sessions: parseSessionBudgets(read, read.section(raw, 'sessions', path), sessions),
        pauseByPriority: read.boolean(raw, 'pauseByPriority', path, defaults.pauseByPriority),
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
    const review = read.section(raw, 'review', path);
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
    const goals = read.string(raw, 'goals', path, defaults.goals, oneOf(GOALS_MODES));
    const reviewMode = read.string(review, 'mode', `${path}.review`, defaults.review.mode, oneOf(REVIEW_MODES));
    const register = {
        ownerSource: read.string(raw, 'ownerSource', path, defaults.ownerSource, isSessionName),
        priorities: priorities.length === 0 ? defaults.priorities : priorities,
        goals: isGoalsMode(goals) ? goals : defaults.goals,
        maxTitle: read.integer(raw, 'maxTitle', path, defaults.maxTitle, { min: 20, max: 1_000 }),
        maxText: read.integer(raw, 'maxText', path, defaults.maxText, { min: 20, max: 5_000 }),
        secretPatterns: read.stringList(raw, 'secretPatterns', path, defaults.secretPatterns, isValidRegex),
        requireDescription: read.boolean(raw, 'requireDescription', path, defaults.requireDescription),
        requireEvidenceOnDone: read.boolean(raw, 'requireEvidenceOnDone', path, defaults.requireEvidenceOnDone),
        requireSkillOnDone: read.boolean(raw, 'requireSkillOnDone', path, defaults.requireSkillOnDone),
        requireNoteOn: read.list(raw, 'requireNoteOn', path, defaults.requireNoteOn, (value, itemPath) => parseStatus(read, value, itemPath), CONFIG_LIMITS.requireNoteOn.maxItems),
        requireFollowupsOn: read.list(raw, 'requireFollowupsOn', path, defaults.requireFollowupsOn, (value, itemPath) => parseStatusAmong(read, value, itemPath, FOLLOWUP_STATUSES), CONFIG_LIMITS.requireFollowupsOn.maxItems),
        autoArchive: read.boolean(raw, 'autoArchive', path, defaults.autoArchive),
        requireProofOnVerifying: read.boolean(raw, 'requireProofOnVerifying', path, defaults.requireProofOnVerifying),
        requireDecisionCard: read.boolean(raw, 'requireDecisionCard', path, defaults.requireDecisionCard),
        verifyGate: isVerifyGate(verifyGate) ? verifyGate : defaults.verifyGate,
        maxVerifying: read.integer(raw, 'maxVerifying', path, defaults.maxVerifying, CONFIG_LIMITS.maxVerifying),
        maxReparks: read.integer(raw, 'maxReparks', path, defaults.maxReparks, CONFIG_LIMITS.maxReparks),
        check: {
            staleAfterHours: read.integer(check, 'staleAfterHours', `${path}.check`, defaults.check.staleAfterHours, { min: 1 }),
            notPickedUpAfterHours: read.integer(check, 'notPickedUpAfterHours', `${path}.check`, defaults.check.notPickedUpAfterHours, { min: 1 }),
            prioritySkipAfterHours: read.integer(check, 'prioritySkipAfterHours', `${path}.check`, defaults.check.prioritySkipAfterHours, { min: 1 }),
            maxSelfMadePerDay: read.integer(check, 'maxSelfMadePerDay', `${path}.check`, defaults.check.maxSelfMadePerDay, CONFIG_LIMITS.maxSelfMadePerDay),
            goalProgressDays: read.integer(check, 'goalProgressDays', `${path}.check`, defaults.check.goalProgressDays, CONFIG_LIMITS.goalProgressDays),
            overSizeMultiple: read.number(check, 'overSizeMultiple', `${path}.check`, defaults.check.overSizeMultiple, CONFIG_LIMITS.overSizeMultiple),
            weekLengthDays: read.integer(check, 'weekLengthDays', `${path}.check`, defaults.check.weekLengthDays, { min: 1, max: 31 }),
            stopgapFiles: read.stringList(check, 'stopgapFiles', `${path}.check`, defaults.check.stopgapFiles, shortLine(CONFIG_LIMITS.stopgapFiles.maxLength, (value) => (value.trim() === '' ? 'expected a path' : undefined)), CONFIG_LIMITS.stopgapFiles.maxItems),
        },
        review: {
            mode: isReviewMode(reviewMode) ? reviewMode : defaults.review.mode,
            requireOn: read.list(review, 'requireOn', `${path}.review`, defaults.review.requireOn, (value, itemPath) => parseStatusAmong(read, value, itemPath, REVIEW_STATUSES), CONFIG_LIMITS.reviewRequireOn.maxItems),
            criticalOwners: read.stringList(review, 'criticalOwners', `${path}.review`, defaults.review.criticalOwners, isSessionName, CONFIG_LIMITS.criticalOwners.maxItems),
            hintPattern: read.string(review, 'hintPattern', `${path}.review`, defaults.review.hintPattern, isValidRegex),
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
/** A status a key accepts only some of, such as the statuses `--followups` may be given with. */
function parseStatusAmong(read, value, path, allowed) {
    if (typeof value === 'string' && allowed.some((status) => status === value)) {
        return parseStatus(read, value, path);
    }
    read.report(path, `expected one of ${allowed.join(', ')}, got ${describe(value)}`);
    return undefined;
}
function parseExec(read, raw) {
    const path = 'exec';
    const webhookEnv = read.optionalString(raw, 'webhookEnv', path, ENV_VARIABLE);
    return {
        path: read.stringList(raw, 'path', path, DEFAULT_EXEC.path, shortLine(CONFIG_LIMITS.execPath.maxLength, EXEC_DIRECTORY), CONFIG_LIMITS.execPath.maxItems),
        ...(webhookEnv === undefined ? {} : { webhookEnv }),
    };
}
function parseAlerts(read, raw) {
    const path = 'alerts';
    const pageWebhookEnv = read.optionalString(raw, 'pageWebhookEnv', path, ENV_VARIABLE);
    const pageWebhookFile = read.optionalString(raw, 'pageWebhookFile', path, isAbsoluteFile);
    return {
        persistentFailureHours: read.integer(raw, 'persistentFailureHours', path, DEFAULT_ALERTS.persistentFailureHours, CONFIG_LIMITS.persistentFailureHours),
        ...(pageWebhookEnv === undefined ? {} : { pageWebhookEnv }),
        ...(pageWebhookFile === undefined ? {} : { pageWebhookFile }),
    };
}
function parseContextFiles(read, raw) {
    const path = 'contextFiles';
    const defaults = DEFAULT_CONTEXT_FILES;
    return {
        maxClaudeMdChars: read.integer(raw, 'maxClaudeMdChars', path, defaults.maxClaudeMdChars, CONFIG_LIMITS.claudeMdChars),
        maxMemoryIndexChars: read.integer(raw, 'maxMemoryIndexChars', path, defaults.maxMemoryIndexChars, CONFIG_LIMITS.memoryIndexChars),
        maxSkillListingChars: read.integer(raw, 'maxSkillListingChars', path, defaults.maxSkillListingChars, CONFIG_LIMITS.skillListingChars),
        maxSessionListsChars: read.integer(raw, 'maxSessionListsChars', path, defaults.maxSessionListsChars, CONFIG_LIMITS.sessionListsChars),
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
        otherAreas: parseOtherAreas(read, raw, path),
    };
}
function parseOtherAreas(read, raw, path) {
    const listing = read.string(raw, 'otherAreas', path, DEFAULT_SKILLS.otherAreas, (value) => isOtherAreaListing(value) ? undefined : `expected one of ${OTHER_AREA_LISTINGS.join(', ')}`);
    return isOtherAreaListing(listing) ? listing : DEFAULT_SKILLS.otherAreas;
}
function parseOpen(read, raw, sessions) {
    const terminal = read.string(raw, 'terminal', 'open', DEFAULT_OPEN.terminal, (value) => isTerminalChoice(value) ? undefined : `expected one of ${TERMINALS.join(', ')}`);
    return {
        terminal: isTerminalChoice(terminal) ? terminal : DEFAULT_OPEN.terminal,
        teamWindow: read.boolean(raw, 'teamWindow', 'open', DEFAULT_OPEN.teamWindow),
        headroom: parseHeadroom(read, read.section(raw, 'headroom', 'open')),
        idle: parseIdle(read, read.section(raw, 'idle', 'open'), sessions),
    };
}
/** `open.idle`: whether the idle pass runs, and the sessions it keeps open; one not on the team is reported and left out. */
function parseIdle(read, raw, sessions) {
    const path = 'open.idle';
    const mode = read.string(raw, 'mode', path, DEFAULT_IDLE.mode, (value) => (isIdleMode(value) ? undefined : `expected one of ${IDLE_MODES.join(', ')}`));
    const keepOpen = read.list(raw, 'keepOpen', path, DEFAULT_IDLE.keepOpen, (value, itemPath) => {
        const id = read.stringItem(value, itemPath, isSessionName);
        if (id !== undefined && sessions.length > 0 && !sessions.includes(id)) {
            read.report(itemPath, `${describe(id)} is not one of the sessions`);
            return undefined;
        }
        return id;
    });
    return { mode: isIdleMode(mode) ? mode : DEFAULT_IDLE.mode, keepOpen };
}
/** `open.headroom`: the room a new session needs on the host. */
function parseHeadroom(read, raw) {
    const path = 'open.headroom';
    return {
        sessionMb: read.integer(raw, 'sessionMb', path, DEFAULT_HEADROOM.sessionMb, CONFIG_LIMITS.headroomSessionMb),
        commitMaxPct: read.integer(raw, 'commitMaxPct', path, DEFAULT_HEADROOM.commitMaxPct, CONFIG_LIMITS.headroomCommitMaxPct),
        closeIdleMinutes: read.integer(raw, 'closeIdleMinutes', path, DEFAULT_HEADROOM.closeIdleMinutes, CONFIG_LIMITS.headroomCloseIdleMinutes),
    };
}
function parseStatusLine(read, raw) {
    const path = 'statusLine';
    return {
        folder: read.boolean(raw, 'folder', path, DEFAULT_STATUS_LINE.folder),
        branch: read.boolean(raw, 'branch', path, DEFAULT_STATUS_LINE.branch),
        pace: read.boolean(raw, 'pace', path, DEFAULT_STATUS_LINE.pace),
    };
}
function parseAskWith(read, raw) {
    const fallback = DEFAULT_DECISIONS.askWith;
    const value = read.string(raw, 'askWith', 'decisions', fallback, oneOf(ASK_WITH));
    return isAskWith(value) ? value : fallback;
}
function parsePushToProtected(read, raw) {
    const fallback = DEFAULT_PUSH_GUARD.pushToProtected;
    const value = read.string(raw, 'pushToProtected', 'pushGuard', fallback, oneOf(PUSH_TO_PROTECTED));
    return isPushToProtected(value) ? value : fallback;
}
/**
 * One `pushGuard.reviewPaths` entry: one with no usable glob is reported and left out; a bad mode or class is reported
 * and read as the strictest, `always` and `security`, so a typo never weakens the gate.
 */
function parseReviewPath(read, value, path) {
    const entry = read.objectItem(value, path);
    if (entry === undefined) {
        return undefined;
    }
    const glob = read.requiredString(entry, 'glob', path, shortLine(REVIEW_PATH_LIMITS.globMaxLength));
    if (glob === '') {
        return undefined;
    }
    const mode = read.string(entry, 'mode', path, 'always', oneOf(REVIEW_PATH_MODES));
    const reviewer = read.string(entry, 'class', path, 'security', oneOf(REVIEW_CLASSES));
    return { glob, mode: isReviewPathMode(mode) ? mode : 'always', class: isReviewClass(reviewer) ? reviewer : 'security' };
}
function parsePackageGuard(read, raw) {
    const path = 'packageGuard';
    const defaults = DEFAULT_PACKAGE_GUARD;
    const adHocRunners = read.string(raw, 'adHocRunners', path, defaults.adHocRunners, oneOf(AD_HOC_RUNNERS));
    const installs = read.string(raw, 'installs', path, defaults.installs, oneOf(PACKAGE_INSTALLS));
    return {
        adHocRunners: isAdHocRunners(adHocRunners) ? adHocRunners : defaults.adHocRunners,
        installs: isPackageInstalls(installs) ? installs : defaults.installs,
        cooldownDays: read.integer(raw, 'cooldownDays', path, defaults.cooldownDays, CONFIG_LIMITS.packageCooldownDays),
    };
}
function parseSkipHooks(read, raw) {
    const fallback = DEFAULT_COMMIT_GUARD.skipHooks;
    const value = read.string(raw, 'skipHooks', 'commitGuard', fallback, oneOf(SKIP_HOOKS));
    return isSkipHooks(value) ? value : fallback;
}
function parseHookAsks(read, raw) {
    const fallback = DEFAULT_PROMPTS.hookAsks;
    const value = read.string(raw, 'hookAsks', 'prompts', fallback, oneOf(HOOK_ASKS));
    return isHookAsks(value) ? value : fallback;
}
const isShellPrefix = (value) => PREFIX_PATTERN.test(value) ? undefined : 'expected words of letters, digits and _ @ . / : = + -, one space apart, the first naming a program';
function parseSecretGuard(read, raw) {
    const path = 'secretGuard';
    const defaults = DEFAULT_SECRET_GUARD;
    const secretReads = read.string(raw, 'secretReads', path, defaults.secretReads, oneOf(SECRET_READS));
    const writes = read.string(raw, 'writes', path, defaults.writes, oneOf(SECRET_WRITES));
    const { secretPaths, secretEnvNames, secretCommands } = CONFIG_LIMITS;
    return {
        secretReads: isSecretReads(secretReads) ? secretReads : defaults.secretReads,
        writes: isSecretWrites(writes) ? writes : defaults.writes,
        paths: read.stringList(raw, 'paths', path, defaults.paths, shortLine(secretPaths.maxLength, isSecretGlob), secretPaths.maxItems),
        envNames: read.stringList(raw, 'envNames', path, defaults.envNames, shortLine(secretEnvNames.maxLength, keepablePattern('keep a variable printable')), secretEnvNames.maxItems),
        commands: read.stringList(raw, 'commands', path, defaults.commands, shortLine(secretCommands.maxLength, keepablePattern('let a command print')), secretCommands.maxItems),
        redact: read.boolean(raw, 'redact', path, defaults.redact),
    };
}
/** A glob with something to match after its `!`. */
const isSecretGlob = (value) => (value.replace(/^!/, '').trim() === '' ? 'expected a glob, with a leading ! to keep a path readable' : undefined);
/** A regular expression with something to match after its `!`, which does what `keeps` says. */
function keepablePattern(keeps) {
    return (value) => {
        const body = value.replace(/^!/, '');
        return body === '' ? `expected a regular expression, with a leading ! to ${keeps}` : isValidRegex(body);
    };
}
function parseReadonlyShell(read, raw) {
    const { maxItems, maxLength } = CONFIG_LIMITS.readonlyShellPrefixes;
    return {
        enabled: read.boolean(raw, 'enabled', 'readonlyShell', DEFAULT_READONLY_SHELL.enabled),
        allowPrefixes: read.stringList(raw, 'allowPrefixes', 'readonlyShell', DEFAULT_READONLY_SHELL.allowPrefixes, shortLine(maxLength, isShellPrefix), maxItems),
    };
}
const isKeepRule = (value) => KEEP_RULE_PATTERN.test(value) ? undefined : 'expected a tool, or a tool and a command with at most a trailing " *" or ":*": no other *, path, URL or parenthesis';
function parsePermissions(read, raw) {
    const { maxItems, maxLength } = CONFIG_LIMITS.keepAllow;
    return { keepAllow: read.stringList(raw, 'keepAllow', 'permissions', DEFAULT_PERMISSIONS.keepAllow, shortLine(maxLength, isKeepRule), maxItems) };
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
        sourcePatterns: read.stringList(raw, 'sourcePatterns', path, defaults.sourcePatterns, shortLine(CONFIG_LIMITS.sourcePatterns.maxLength, isValidRegex), CONFIG_LIMITS.sourcePatterns.maxItems),
        gate: isCommitGate(gate) ? gate : defaults.gate,
    };
}
/** From a 200k window's compaction point up to far past any window today. */
const REFRESH_TOKENS = { min: 10_000, max: 10_000_000 };
/** 0 turns the task count off. */
const REFRESH_TASKS = { min: 0, max: 100 };
/** Long enough to read the notice and type, short enough that the fresh start is not missed. */
const RESTART_DELAY_SECONDS = { min: 5, max: 600 };
/** 0: only a draft holds the /clear; an hour at most, since the restart gives up after one. */
const HOLD_AFTER_ACTIVITY_MINUTES = { min: 0, max: 60 };
/** 0: no count; long enough to read and press, short of the restart's give-up. */
const COUNTDOWN_SECONDS = { min: 0, max: 120 };
/** 0 turns the stop of Claude Code's compaction off. */
const COMPACT_CEILING_TOKENS = { min: 0, max: 10_000_000 };
/** 0 turns the cap off; a megabyte is far past any context window. */
const HANDOVER_MAX_BYTES = { min: 0, max: 1_000_000 };
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
        holdAfterActivityMinutes: read.integer(raw, 'holdAfterActivityMinutes', path, defaults.holdAfterActivityMinutes, HOLD_AFTER_ACTIVITY_MINUTES),
        countdownSeconds: read.integer(raw, 'countdownSeconds', path, defaults.countdownSeconds, COUNTDOWN_SECONDS),
        compactCeilingTokens: read.integer(raw, 'compactCeilingTokens', path, defaults.compactCeilingTokens, COMPACT_CEILING_TOKENS),
        handoverMaxBytes: read.integer(raw, 'handoverMaxBytes', path, defaults.handoverMaxBytes, HANDOVER_MAX_BYTES),
        endCommand: read.stringList(raw, 'endCommand', path, defaults.endCommand, undefined, END_COMMAND_MAX_ITEMS),
        ...(handoverDir === undefined ? {} : { handoverDir }),
    };
}
/** `hiring`: who decides, review days, and when a rehire resumes. */
function parseHiring(read, raw) {
    const path = 'hiring';
    const defaults = DEFAULT_HIRING;
    const policy = read.string(raw, 'policy', path, defaults.policy, oneOf(HIRING_POLICIES));
    const budgetWhy = "a hire's daily budget is its part of the team's, by its share and queued work";
    read.dropped(raw, 'dailyPct', path, budgetWhy);
    read.dropped(raw, 'maxDailyPct', path, budgetWhy);
    read.dropped(raw, 'maxSessions', path, HIRE_CAP_DROPPED);
    read.dropped(raw, 'capRaisedBy', path, HIRE_CAP_DROPPED);
    read.dropped(raw, 'idleHours', path, IDLE_RETIRE_DROPPED);
    return {
        policy: isHiringPolicy(policy) ? policy : defaults.policy,
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
