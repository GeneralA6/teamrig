import { isRecord, type JsonRecord } from '../core/guards.ts';
import { NAME_PATTERN, NAME_RULE } from '../core/ids.ts';
import { isTaskStatus, SESSION_NAME, type TaskStatus } from '../register/model.ts';
import {
  DEFAULT_ALERTS,
  DEFAULT_BUDGET,
  DEFAULT_COMMITS,
  DEFAULT_LOCK,
  DEFAULT_MESSAGES,
  DEFAULT_OPEN,
  DEFAULT_OWNER_GATES,
  DEFAULT_PUSH_GUARD,
  DEFAULT_REFRESH,
  DEFAULT_REGISTER,
  DEFAULT_SKILLS,
} from './defaults.ts';
import { isEffort, isModel } from './launch.ts';
import { CONFIG_LIMITS } from './limits.ts';
import { ConfigReader, describe, isValidRegex, shortLine, type Check, type ConfigIssue } from './reader.ts';
import {
  isCommitGate,
  isEffortLevel,
  isTerminalChoice,
  TERMINALS,
  type CommitsConfig,
  type KitConfig,
  type LaunchConfig,
  type OpenConfig,
  type PathsConfig,
  type RefreshConfig,
  type RegisterConfig,
  type SkillsConfig,
  type PriorityConfig,
  type TeamLink,
} from './types.ts';

export interface ConfigParse {
  /** Always filled: invalid fields take their defaults so read-only commands keep working. */
  readonly config: KitConfig;
  readonly issues: readonly ConfigIssue[];
}

const isSessionName: Check<string> = (name) =>
  SESSION_NAME.test(name) ? undefined : 'expected a lowercase name: a letter, then letters, digits or -, at most 32';

const isUtcTime: Check<string> = (time) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? undefined : 'expected a UTC time as HH:MM');

const BRANCH_NAME: Check<string> = (name) => (/^[^\s~^:?*[\\]+$/.test(name) ? undefined : 'not a valid branch name');

/** The key shape the skills lint recognises in frontmatter. */
const isFrontmatterKey: Check<string> = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? undefined : 'expected a frontmatter key: letters, digits, _ or -');

/** A git trailer key, such as `Large-commit`. */
const isTrailerKey: Check<string> = (key) =>
  /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(key) ? undefined : 'expected a trailer key: a letter, then at most 39 letters, digits or -';

const isDisplayName: Check<string> = (name) => (NAME_PATTERN.test(name) ? undefined : `expected a name: ${NAME_RULE}`);

/**
 * `names`: only sessions on the team, and each name unique and never another session's id, so a
 * command given a name finds exactly one session.
 */
function readNames(read: ConfigReader, raw: JsonRecord, sessions: readonly string[]): Record<string, string> {
  const names: Record<string, string> = {};
  const holders = new Map<string, string>();
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
function readLaunch(read: ConfigReader, raw: JsonRecord, sessions: readonly string[]): Record<string, LaunchConfig> {
  const launch: Record<string, LaunchConfig> = {};
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
function readTeam(read: ConfigReader, raw: JsonRecord): TeamLink | undefined {
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
export function parseConfig(raw: JsonRecord): ConfigParse {
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
  ] as const) {
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
  const budget = read.section(coordinator, 'budget', 'coordinator');
  const heavyCutoffUtc = read.optionalString(schedule, 'heavyCutoffUtc', 'coordinator.schedule', isUtcTime);
  const alerts = read.section(raw, 'alerts', '');
  const lock = read.section(raw, 'lock', '');
  const tabStatus = read.section(raw, 'tabStatus', '');

  const config: KitConfig = {
    configVersion: read.integer(raw, 'configVersion', '', 1, { min: 1 }),
    ...(team === undefined ? {} : { team }),
    sessions,
    names,
    roles: coordinatorOwner === undefined ? { lead } : { lead, coordinatorOwner },
    ownerGates: read.stringList(
      raw,
      'ownerGates',
      '',
      DEFAULT_OWNER_GATES,
      shortLine(CONFIG_LIMITS.ownerGates.maxLength),
      CONFIG_LIMITS.ownerGates.maxItems,
    ),
    messages: { maxLines: read.integer(messages, 'maxLines', 'messages', DEFAULT_MESSAGES.maxLines, CONFIG_LIMITS.maxLines) },
    register: parseRegister(read, read.section(raw, 'register', '')),
    skills: parseSkills(read, read.section(raw, 'skills', '')),
    lock: {
      ttlMs: read.integer(lock, 'ttlMs', 'lock', DEFAULT_LOCK.ttlMs, { min: 1_000 }),
      pollMs: read.integer(lock, 'pollMs', 'lock', DEFAULT_LOCK.pollMs, { min: 10 }),
      waitMs: read.integer(lock, 'waitMs', 'lock', DEFAULT_LOCK.waitMs, { min: 0 }),
    },
    pushGuard: {
      protectedBranches: read.stringList(
        pushGuard,
        'protectedBranches',
        'pushGuard',
        DEFAULT_PUSH_GUARD.protectedBranches,
        shortLine(CONFIG_LIMITS.protectedBranches.maxLength, BRANCH_NAME),
        CONFIG_LIMITS.protectedBranches.maxItems,
      ),
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
    open: parseOpen(read, read.section(raw, 'open', '')),
    launch,
    paths: parsePaths(read, read.section(raw, 'paths', '')),
  };
  return { config, issues: read.issues };
}

/** Config version 1's name for `register.priorities`; the v1-to-v2 migration renames it, so a current file never holds it. */
const RENAMED_PRIORITIES_KEY = 'tiers';

function parseRegister(read: ConfigReader, raw: JsonRecord): RegisterConfig {
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
  const register: RegisterConfig = {
    ownerSource: read.string(raw, 'ownerSource', path, defaults.ownerSource, isSessionName),
    priorities: priorities.length === 0 ? defaults.priorities : priorities,
    maxTitle: read.integer(raw, 'maxTitle', path, defaults.maxTitle, { min: 20, max: 1_000 }),
    maxText: read.integer(raw, 'maxText', path, defaults.maxText, { min: 20, max: 5_000 }),
    secretPatterns: read.stringList(raw, 'secretPatterns', path, defaults.secretPatterns, isValidRegex),
    requireEvidenceOnDone: read.boolean(raw, 'requireEvidenceOnDone', path, defaults.requireEvidenceOnDone),
    requireSkillOnDone: read.boolean(raw, 'requireSkillOnDone', path, defaults.requireSkillOnDone),
    requireNoteOn: read.list(
      raw,
      'requireNoteOn',
      path,
      defaults.requireNoteOn,
      (value, itemPath) => parseStatus(read, value, itemPath),
      CONFIG_LIMITS.requireNoteOn.maxItems,
    ),
    check: {
      staleAfterHours: read.integer(check, 'staleAfterHours', `${path}.check`, defaults.check.staleAfterHours, { min: 1 }),
      notPickedUpAfterHours: read.integer(check, 'notPickedUpAfterHours', `${path}.check`, defaults.check.notPickedUpAfterHours, { min: 1 }),
      prioritySkipAfterHours: read.integer(check, 'prioritySkipAfterHours', `${path}.check`, defaults.check.prioritySkipAfterHours, { min: 1 }),
      weekLengthDays: read.integer(check, 'weekLengthDays', `${path}.check`, defaults.check.weekLengthDays, { min: 1, max: 31 }),
    },
  };
  return goalPattern === undefined ? register : { ...register, goalPattern };
}

function parsePriority(read: ConfigReader, value: unknown, path: string): PriorityConfig | undefined {
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

function parseStatus(read: ConfigReader, value: unknown, path: string): TaskStatus | undefined {
  if (isTaskStatus(value)) {
    return value;
  }
  read.report(path, `expected one of open, in-progress, blocked, done, dropped, got ${describe(value)}`);
  return undefined;
}

function parseSkills(read: ConfigReader, raw: JsonRecord): SkillsConfig {
  const path = 'skills';
  const defaults = DEFAULT_SKILLS;
  return {
    sharedPrefix: read.string(raw, 'sharedPrefix', path, defaults.sharedPrefix, isSessionName),
    maxDescriptionWords: read.integer(raw, 'maxDescriptionWords', path, defaults.maxDescriptionWords, CONFIG_LIMITS.maxDescriptionWords),
    maxPerArea: read.integer(raw, 'maxPerArea', path, defaults.maxPerArea, CONFIG_LIMITS.maxPerArea),
    maxVerifiedAgeDays: read.integer(raw, 'maxVerifiedAgeDays', path, defaults.maxVerifiedAgeDays, CONFIG_LIMITS.maxVerifiedAgeDays),
    forbidFrontmatter: read.stringList(
      raw,
      'forbidFrontmatter',
      path,
      defaults.forbidFrontmatter,
      shortLine(CONFIG_LIMITS.forbidFrontmatter.maxLength, isFrontmatterKey),
      CONFIG_LIMITS.forbidFrontmatter.maxItems,
    ),
  };
}

function parseOpen(read: ConfigReader, raw: JsonRecord): OpenConfig {
  const terminal = read.string(raw, 'terminal', 'open', DEFAULT_OPEN.terminal, (value) =>
    isTerminalChoice(value) ? undefined : `expected one of ${TERMINALS.join(', ')}`,
  );
  return { terminal: isTerminalChoice(terminal) ? terminal : DEFAULT_OPEN.terminal };
}

function parseCommits(read: ConfigReader, raw: JsonRecord): CommitsConfig {
  const path = 'commits';
  const defaults = DEFAULT_COMMITS;
  const gate = read.string(raw, 'gate', path, defaults.gate, (value) => (isCommitGate(value) ? undefined : 'expected off, warn or refuse'));
  return {
    maxLines: read.integer(raw, 'maxLines', path, defaults.maxLines, CONFIG_LIMITS.commitMaxLines),
    maxFiles: read.integer(raw, 'maxFiles', path, defaults.maxFiles, CONFIG_LIMITS.commitMaxFiles),
    largeCommitTrailer: read.string(raw, 'largeCommitTrailer', path, defaults.largeCommitTrailer, isTrailerKey),
    testPatterns: read.stringList(
      raw,
      'testPatterns',
      path,
      defaults.testPatterns,
      shortLine(CONFIG_LIMITS.testPatterns.maxLength, isValidRegex),
      CONFIG_LIMITS.testPatterns.maxItems,
    ),
    gate: isCommitGate(gate) ? gate : defaults.gate,
  };
}

/** From a 200k window's compaction point up to far past any window today. */
const REFRESH_TOKENS = { min: 10_000, max: 10_000_000 } as const;

function parseRefresh(read: ConfigReader, raw: JsonRecord): RefreshConfig {
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

function parsePaths(read: ConfigReader, raw: JsonRecord): PathsConfig {
  const state = read.optionalString(raw, 'state', 'paths');
  const inbox = read.optionalString(raw, 'inbox', 'paths');
  const skills = read.optionalString(raw, 'skills', 'paths');
  return {
    ...(state === undefined ? {} : { state }),
    ...(inbox === undefined ? {} : { inbox }),
    ...(skills === undefined ? {} : { skills }),
  };
}
