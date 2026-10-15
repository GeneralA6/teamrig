import type { TaskStatus } from '../register/model.ts';

/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 3;

export interface RolesConfig {
  /** Owns priorities, team rules and the owner's decision queue; may re-prioritize and reassign tasks. */
  readonly lead: string;
  /** Owns deploy coordination and fleet health, when the team has that role. */
  readonly coordinatorOwner?: string;
}

/** One priority level; tasks print it as `p<id>`, and p1 is the most urgent. */
export interface PriorityConfig {
  readonly id: number;
  readonly name: string;
}

export interface RegisterCheckConfig {
  /** An active task untouched this long is STALE. */
  readonly staleAfterHours: number;
  /** An open task its owner has not touched this long after assignment is NOT-PICKED-UP. */
  readonly notPickedUpAfterHours: number;
  /** A session's in-progress task below its own open top-priority task this long is a PRIORITY-SKIP. */
  readonly prioritySkipAfterHours: number;
  readonly weekLengthDays: number;
}

export interface RegisterConfig {
  /** The `--source` that marks a task as ordered by the human owner. */
  readonly ownerSource: string;
  /** The priority levels, most urgent first; config version 1 called them `tiers`. */
  readonly priorities: readonly PriorityConfig[];
  /** When set, every goal tag on a new task must match this regular expression. */
  readonly goalPattern?: string;
  readonly maxTitle: number;
  readonly maxText: number;
  /** Extra regular expressions, matched case-insensitively, that refuse secret-looking text on top of the built-in shapes in `core/secret-patterns.ts`. */
  readonly secretPatterns: readonly string[];
  readonly requireEvidenceOnDone: boolean;
  readonly requireSkillOnDone: boolean;
  /** Statuses that cannot be set without a note. */
  readonly requireNoteOn: readonly TaskStatus[];
  /**
   * Whether a write archives the task list's log by itself once it is long (register/rotate.ts), as it does
   * after the first `teamrig compact`. Off, only `teamrig compact` archives it.
   */
  readonly autoArchive: boolean;
  readonly check: RegisterCheckConfig;
}

export interface SkillsConfig {
  /** The area prefix of skills shared by the whole team, e.g. `team-...`. */
  readonly sharedPrefix: string;
  readonly maxDescriptionWords: number;
  readonly maxPerArea: number;
  readonly maxVerifiedAgeDays: number;
  /** Frontmatter keys a team skill may not set, e.g. `allowed-tools` (a skill is never a permission). */
  readonly forbidFrontmatter: readonly string[];
}

export interface LockConfig {
  readonly ttlMs: number;
  readonly pollMs: number;
  readonly waitMs: number;
}

export interface PushGuardConfig {
  /** Branches the push guard watches: a push to one goes as `pushToProtected` says; force-push, mirror and deletion are refused. */
  readonly protectedBranches: readonly string[];
  /** What a normal push to a protected branch does. */
  readonly pushToProtected: PushToProtected;
}

/**
 * A normal push to a protected branch: `ask` the human, or `allow` it with a note. Neither changes a refusal, a
 * `--force-with-lease` push, or a command the guard cannot read, which still asks.
 */
export type PushToProtected = 'ask' | 'allow';

export const PUSH_TO_PROTECTED: readonly PushToProtected[] = ['ask', 'allow'];

export function isPushToProtected(value: unknown): value is PushToProtected {
  return PUSH_TO_PROTECTED.some((choice) => choice === value);
}

export const COMMIT_GATES = ['off', 'warn', 'refuse'] as const;
/** What a push to a protected branch does about commits over the size rule: nothing, list them, or refuse the push. */
export type CommitGate = (typeof COMMIT_GATES)[number];

export function isCommitGate(value: unknown): value is CommitGate {
  return COMMIT_GATES.some((gate) => gate === value);
}

/** The small-commits rule: one logical change per commit, and a reason line on any commit over the bounds. */
export interface MessagesConfig {
  /** The longest message one session may send another. */
  readonly maxLines: number;
  /**
   * Minutes a session may sit idle before a message to it counts as a cold wake: its first call then
   * re-reads its whole context at full price. A send to a session idle this long is held once; 0 never holds.
   */
  readonly coldAfterMinutes: number;
}

export interface CommitsConfig {
  /** Changed non-test lines (added + deleted) a commit may carry without a reason line. */
  readonly maxLines: number;
  /** Changed non-test files a commit may carry without a reason line. */
  readonly maxFiles: number;
  /** The key of the reason line, as in `Large-commit: <reason>`. */
  readonly largeCommitTrailer: string;
  /** Regular expressions over `/`-separated paths; a file that matches one is a test and never counts. */
  readonly testPatterns: readonly string[];
  readonly gate: CommitGate;
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** A UTC weekday, Sunday first so its index matches `Date.getUTCDay()`. */
export type Weekday = (typeof WEEKDAYS)[number];

export function isWeekday(value: unknown): value is Weekday {
  return WEEKDAYS.some((day) => day === value);
}

export const OVER_ACTIONS = ['warn', 'ask-lead', 'ask', 'block'] as const;
/**
 * What the live warning does past a session's daily budget: lines only; also an inbox line to the
 * lead; also asking the person before a helper launch; or refusing helper launches.
 */
export type OverAction = (typeof OVER_ACTIONS)[number];

export function isOverAction(value: unknown): value is OverAction {
  return OVER_ACTIONS.some((action) => action === value);
}

export const ESCALATIONS = ['session', 'session-and-fleet'] as const;
/** When an action beyond the warning lines applies: the session alone is over, or it is over and the team is ahead of its pace line. */
export type Escalation = (typeof ESCALATIONS)[number];

export function isEscalation(value: unknown): value is Escalation {
  return ESCALATIONS.some((escalation) => escalation === value);
}

/** The weekly limit's reset, for a team without a status line to read it from. */
export interface BudgetReset {
  readonly weekday: Weekday;
  /** HH:MM, UTC. */
  readonly timeUtc: string;
}

/** UTC hours in which the live warning applies `action` on its own, while the team sleeps. */
export interface QuietHours {
  readonly startUtc: string;
  readonly endUtc: string;
  readonly action: OverAction;
}

/** One session's part of the team's daily allowance. */
export interface SessionBudget {
  /** Its weight: the session gets allowance × share / the sum of every session's share. */
  readonly share: number;
  /** A fixed daily budget, in % of the week, in place of its share. */
  readonly dailyPct?: number;
}

/**
 * The bounds on a lead's lift of a session's daily budget. Every lift carries a stop %, the share of
 * the week at which it ends; the reserve stop % is only for the one reserve release shortly before the reset.
 */
export interface BudgetLiftConfig {
  /** The highest stop % a lift may carry. */
  readonly maxStopPct: number;
  /** The highest stop % of a `--reserve` lift, given only in the last hour before the reset. */
  readonly reserveStopPct: number;
}

/**
 * The weekly token budget: the pace line the team is measured against and each session's daily part
 * of it. Off by default, and the defaults only measure and show: nothing blocks or acts.
 */
export interface BudgetConfig {
  /** Turns on the live warning and the core rules' pacing sentence; `teamrig budget` shows usage either way. */
  readonly enabled: boolean;
  /** The weekly limit in weighted tokens (W). Unset: derived from the status line's weekly %. */
  readonly weeklyLimitW?: number;
  /** Unset: the reset time the status line reports. */
  readonly reset?: BudgetReset;
  /** Use the week up to this share of the weekly limit. */
  readonly targetPct: number;
  /** Kept back for incidents until shortly before the reset. */
  readonly reservePct: number;
  /** The pace line reaches `targetPct` this many hours before the reset. */
  readonly paceEndHoursBeforeReset: number;
  /** The team's allowance per UTC day, in % of the week. Unset: what is left to the target, spread over the days left. */
  readonly dailyPct?: number;
  /** A ceiling on the team's daily allowance. Unset: none. */
  readonly maxDailyPct?: number;
  /** Each session's part, by id; a session not listed has a share of 1. */
  readonly sessions: Readonly<Record<string, SessionBudget>>;
  /** The live warning shows a line as a session passes each of these % of its daily budget. */
  readonly warnAtPct: readonly number[];
  /** The team is ahead of its pace line once its used % is more than this many points above it. */
  readonly paceTolerancePct: number;
  readonly overAction: OverAction;
  readonly escalate: Escalation;
  readonly quietHours?: QuietHours;
  readonly lift: BudgetLiftConfig;
  /** The folder of status line snapshots, `<Claude session id>.json` each. Unset: `<kit home>/usage/live`. */
  readonly statusSnapshotDir?: string;
  /** The most transcript bytes one hook run reads; the rest waits for the next run. */
  readonly maxBytesPerHook: number;
}

export interface ScheduleConfig {
  /** No heavy step starts on the host after this UTC time (HH:MM) until midnight. */
  readonly heavyCutoffUtc?: string;
}

/** The deploy coordinator's settings; M1 reads only what the rule pack states. */
export interface CoordinatorConfig {
  readonly schedule: ScheduleConfig;
}

export interface AlertsConfig {
  /** The same external failure for this long must page a human. */
  readonly persistentFailureHours: number;
}

/**
 * Context refresh: when a session finishes a task (`set <id> --status done`) with its context at or over
 * `contextTokens`, or after the lead asked for it, the session writes a handover and the user types /clear.
 */
export interface RefreshConfig {
  readonly enabled: boolean;
  /** The context size, in tokens, that asks for a refresh. Absolute, since a hook cannot see the window size. */
  readonly contextTokens: number;
  /** Title the tab `<name>: type /clear` once the session's handover is written and it waits for /clear. */
  readonly tabTitle: boolean;
  /** The handover folder; a relative one is resolved against the team's folder. Unset: `<team folder>/handover`. */
  readonly handoverDir?: string;
}

/**
 * Where `teamrig open` opens a session's tab: `auto` picks tmux inside tmux, else the platform's
 * terminal; `print` opens nothing and prints the command to run.
 */
export const TERMINALS = ['auto', 'tmux', 'windows-terminal', 'macos-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator', 'print'] as const;
export type TerminalChoice = (typeof TERMINALS)[number];

export function isTerminalChoice(value: unknown): value is TerminalChoice {
  return TERMINALS.some((terminal) => terminal === value);
}

export interface OpenConfig {
  readonly terminal: TerminalChoice;
}

/** Claude Code's effort levels, lowest first: what `claude --effort` and `/effort` take. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === value);
}

/**
 * The Claude Code model and effort a session starts on (`claude --model`, `claude --effort`); an unset
 * key leaves Claude Code's own choice. The lead takes `DEFAULT_LEAD_LAUNCH` for each key it leaves unset.
 */
export interface LaunchConfig {
  /** A Claude Code model alias, such as `best` or `opus`, or a full model id starting `claude-`. */
  readonly model?: string;
  readonly effort?: EffortLevel;
}

export interface PathsConfig {
  readonly state?: string;
  readonly inbox?: string;
  readonly skills?: string;
}

/** Where a team sits in a tree of teams, read from its own config; no registry file mirrors it. */
export interface TeamLink {
  /** The team's id: the name of its folder under `<kit home>/teams/`. */
  readonly id: string;
  /** The team whose lead this team's lead reports to; a team with none is the root of its own tree. */
  readonly parent?: string;
}

export interface KitConfig {
  readonly configVersion: number;
  /** Unset in a config written before team trees: the team is then the root of its own tree. */
  readonly team?: TeamLink;
  /**
   * Every session id on the team, the lead included. Ids key every file and record (inboxes, read
   * marks, task owners), so they never change; a rename only appends to the team's rename log.
   */
  readonly sessions: readonly string[];
  /**
   * Each session's first display and Claude Code session name, by id; an id not listed is named
   * `<team>-<id>`. A rename in the team's rename log wins over it, and it keeps finding the session.
   */
  readonly names: Readonly<Record<string, string>>;
  /** Each role's session, by id. */
  readonly roles: RolesConfig;
  /** Decision areas only the human owner can approve; silence never counts as consent for them. */
  readonly ownerGates: readonly string[];
  readonly messages: MessagesConfig;
  readonly register: RegisterConfig;
  readonly skills: SkillsConfig;
  readonly lock: LockConfig;
  readonly pushGuard: PushGuardConfig;
  readonly commits: CommitsConfig;
  readonly coordinator: CoordinatorConfig;
  readonly budget: BudgetConfig;
  readonly alerts: AlertsConfig;
  readonly tabStatus: { readonly enabled: boolean };
  readonly refresh: RefreshConfig;
  /** How `teamrig open` starts a session in a new terminal tab. */
  readonly open: OpenConfig;
  /** Each session's Claude Code model and effort, by id; the lead's unset keys take `DEFAULT_LEAD_LAUNCH`. */
  readonly launch: Readonly<Record<string, LaunchConfig>>;
  readonly paths: PathsConfig;
}
