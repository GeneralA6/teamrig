import type { TaskStatus } from '../register/model.ts';
import type { CoreRuleKey } from '../rules/keys.ts';

/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 3;

export interface RolesConfig {
  /** Owns priorities, team rules and the owner's decision queue; may re-prioritize and reassign tasks; hands the work itself to others (`leadBoundary`). */
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
  /**
   * The files `check` scans for `stopgap T<id>` tags besides every skill: paths relative to the team's project
   * folder, or absolute; a path ending in `.md` is one file, any other a folder whose `.md` files are read.
   */
  readonly stopgapFiles: readonly string[];
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
  /** Whether `add` needs `--description`, what the task is and why in plain words, and `update` refuses to clear one. */
  readonly requireDescription: boolean;
  readonly requireEvidenceOnDone: boolean;
  readonly requireSkillOnDone: boolean;
  /** Statuses that cannot be set without a note. */
  readonly requireNoteOn: readonly TaskStatus[];
  /**
   * Whether a write archives the task list's log by itself once it is long (register/rotate.ts), as it does
   * after the first `teamrig compact`. Off, only `teamrig compact` archives it.
   */
  readonly autoArchive: boolean;
  /** Whether `set --status verifying` needs `--proof`, what will prove the shipped change works. */
  readonly requireProofOnVerifying: boolean;
  /** What `set --status in-progress` does while a task it needs is still verifying. */
  readonly verifyGate: VerifyGate;
  /** A session holding more verifying tasks than this is a PILE-UP in `check`; 0 turns the flag off. */
  readonly maxVerifying: number;
  readonly check: RegisterCheckConfig;
}

export const VERIFY_GATES = ['refuse', 'warn'] as const;
/**
 * Starting a task while one it needs (`--after`, or `--waits task:`) is verifying: `refuse` it, or `warn` and
 * start it. Either way the verifying task's owner gets one inbox line a day about it.
 */
export type VerifyGate = (typeof VERIFY_GATES)[number];

export function isVerifyGate(value: unknown): value is VerifyGate {
  return VERIFY_GATES.some((gate) => gate === value);
}

export const CONFLICT_WINNERS = ['local', 'teamrig'] as const;
/** Which side of a recorded conflict wins: the local rule over the core rule, or the core rule over the local text kept. */
export type ConflictWinner = (typeof CONFLICT_WINNERS)[number];

export function isConflictWinner(value: unknown): value is ConflictWinner {
  return CONFLICT_WINNERS.some((winner) => winner === value);
}

/**
 * A local rule (a line of a CLAUDE.md, rules file, skill, memory file, hook or settings file) that conflicts with a
 * core rule and that the user chose to keep, recorded by `rules keep`. The core pack lists it, naming the side that wins.
 */
export interface RuleConflict {
  /** The file, `~/`-relative under the user's home folder, else absolute. */
  readonly file: string;
  /** The start of the line's text, which finds the line again when the lines above it move. */
  readonly text: string;
  readonly rule: CoreRuleKey;
  readonly wins: ConflictWinner;
  /** Why the user kept it, in their words. */
  readonly reason?: string;
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

/** How teamrig keeps the lead leading (T320): its own edits, tests and code searches are nudged and shown, never blocked. */
export interface LeadBoundaryConfig {
  /** Off: the lead's own work is neither nudged nor shown. */
  readonly enabled: boolean;
  /**
   * The lead's own files and folders beyond the team's teamrig folder and Claude Code's memory folders, which
   * always count: editing or searching them is its job. `~` is the user's home, `*` one folder name.
   */
  readonly ownPaths: readonly string[];
  /** The turn's code search that brings the lead one nudge, and from which the owner's turn-end line counts searches; 0 never. */
  readonly searchNudgeAt: number;
}

/** Loop discipline inside a turn. */
export interface LoopsConfig {
  /**
   * After this many single-tool calls in a row in one turn, the session gets one line asking it to batch
   * independent steps into one message; 0 never asks.
   */
  readonly chainNudgeAt: number;
}

/**
 * Waking a session idle at its prompt when work is handed to it (src/wake/), instead of at its next prompt. A
 * wake is a model turn, so only urgent work that can start now wakes, tasks handed together wake once, and each
 * wake says what it costs.
 */
export interface WakeConfig {
  /** Off: a session sees new work only at its next prompt. */
  readonly enabled: boolean;
  /**
   * The least urgent priority that wakes a session: 1 wakes for p1 only. A session past its daily budget, or in
   * the budget's quiet hours, wakes for p1 only whatever this says.
   */
  readonly priority: number;
  /** How long a wake waits after the first new task it is for, so tasks handed together wake the session once. */
  readonly batchSeconds: number;
  /** The least time between two wakes of one session; work handed meanwhile waits and wakes it once. */
  readonly minGapMinutes: number;
}

/** What `teamrig test` prints of a failed run. */
export interface TestsConfig {
  /** The most characters of failing tests it prints, all of them together; the rest stays in the log. */
  readonly maxFailureChars: number;
}

/** Which GitHub issues `teamrig gh sync` reads into the register. It only reads GitHub, never writes to it. */
export interface GithubConfig {
  /** The repositories it reads, as `owner/name` in lowercase; empty turns the import off. */
  readonly repos: readonly string[];
  /** The session each GitHub login (lowercase) owns imported issues as; an issue with no listed assignee goes to its repository's session. */
  readonly owners: Readonly<Record<string, string>>;
  /** The session each repository's (lowercase) issues go to when none of their assignees is in `owners`; else the lead. */
  readonly sessions: Readonly<Record<string, string>>;
  /** How many days back closed issues are read, to finish the tasks they were imported as. */
  readonly closedDays: number;
  /** How often the hooks start a sync on their own, in minutes, once for the whole team; 0 leaves it to `gh sync --yes`. */
  readonly everyMinutes: number;
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
  /**
   * What one W of a subagent's transcript costs against the weekly limit, in W of a main session. The meter
   * multiplies each subagent call's W by it, so every W (and `weeklyLimitW`) is in main-session W. 1: alike.
   */
  readonly subagentWeight: number;
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
 * Context refresh: at any turn end with the session's context at or over `contextTokens`, at a task end
 * (`set <id> --status done`) with `everyTasks` tasks finished since its context was last fresh, or after the lead
 * asked for it, the session writes a handover; then the user types /clear, or teamrig starts it fresh on its own
 * (`autoRestart`).
 */
export interface RefreshConfig {
  readonly enabled: boolean;
  /** The context size, in tokens, that asks for a refresh. Absolute, since a hook cannot see the window size. */
  readonly contextTokens: number;
  /**
   * Also refresh once this many tasks were finished since the context was last fresh (a /clear, a new
   * process or a compaction), when the context is at least `everyTasksMinTokens`; 0 turns it off.
   */
  readonly everyTasks: number;
  /** The smallest context the task count refreshes at: under it a fresh start saves little. */
  readonly everyTasksMinTokens: number;
  /** Title the tab once the session's handover is written: `<name>: restarting`, or `<name>: type /clear`. */
  readonly tabTitle: boolean;
  /**
   * Once the handover is written and the turn has ended, start the session fresh, which reads the handover:
   * the plugin's mod runs /clear in its tab; where no mod claims the ask, end its Claude Code process and start
   * it again, in the same tab when `teamrig open` started it, else in a new tab. A prompt typed before then
   * keeps the context. Off (the default): the user types /clear once done with the screen, which a /clear wipes.
   */
  readonly autoRestart: boolean;
  /** How long after the turn's end the automatic restart waits, so the user can still type to keep the context. */
  readonly restartDelaySeconds: number;
  /**
   * A program (its path, then its arguments) run after an automatic restart ended a session, given Claude
   * Code's SessionEnd hook input (reason `clear`) on stdin: for a SessionEnd hook the end skipped, since on
   * Windows a process is ended without running them. Empty: none.
   */
  readonly endCommand: readonly string[];
  /** The handover folder; a relative one is resolved against the team's folder. Unset: `<team folder>/handover`. */
  readonly handoverDir?: string;
}

/**
 * Who may hire a session onto the team (`teamrig hire`): `off` nobody; `owner` the lead, once the owner
 * approved (`--approved-by`, kept with the hire); `lead` the lead, within the caps; `automatic` as `lead`,
 * and a hired session whose tasks are all closed may also retire itself (`teamrig retire`).
 */
export const HIRING_POLICIES = ['off', 'owner', 'lead', 'automatic'] as const;
export type HiringPolicy = (typeof HIRING_POLICIES)[number];

export function isHiringPolicy(value: unknown): value is HiringPolicy {
  return HIRING_POLICIES.some((policy) => policy === value);
}

/** Hiring temporary sessions: who decides, and the caps every hire stays within. */
export interface HiringConfig {
  readonly policy: HiringPolicy;
  /** Hired sessions on the team at once. */
  readonly maxSessions: number;
  /** A hire's daily budget, in % of the week, unless the hire names its own. */
  readonly dailyPct: number;
  /** The most all hired sessions' daily budgets may add up to. */
  readonly maxDailyPct: number;
  /** Hours a hired session may hold no open task before it is due to retire. */
  readonly idleHours: number;
  /** Days from a hire to its review date, unless the hire names one. */
  readonly reviewDays: number;
  /** The most context tokens a rehired session's last Claude Code session may hold for `open --resume` to resume it. */
  readonly resumeMaxTokens: number;
  /** The most days that session may have been idle (its transcript unwritten) for `open --resume` to resume it. */
  readonly resumeMaxIdleDays: number;
}

/**
 * Who may start a burst (`teamrig burst start`), a time-boxed scale-out onto helpers and hired sessions
 * that spends more of the week: `off` nobody; `owner` the lead, once the owner approved (`--approved-by`,
 * kept with the burst); `lead` the lead, within the caps. No policy starts a burst on its own: it spends
 * more of the week, a decision the owner gates, so a person always starts it by command.
 */
export const BURST_POLICIES = ['off', 'owner', 'lead'] as const;
export type BurstPolicy = (typeof BURST_POLICIES)[number];

export function isBurstPolicy(value: unknown): value is BurstPolicy {
  return BURST_POLICIES.some((policy) => policy === value);
}

/** Bursts: who starts one, when the week's surplus is worth one, and the caps every burst stays within. */
export interface BurstConfig {
  readonly policy: BurstPolicy;
  /** A surplus burst starts at the earliest this many hours before the week's reset. */
  readonly surplusHours: number;
  /** The least share of the week, in %, projected unused at the pace end for a surplus burst. */
  readonly minSparePct: number;
  /** The most helpers each burst session runs at once. */
  readonly maxHelpers: number;
  /** The most sessions one burst may hire (`hire --burst`); `hiring`'s caps apply as well. */
  readonly maxHires: number;
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

/** Character budgets for the text Claude Code puts in every call's context; `doctor` flags a file over its budget. */
export interface ContextFilesConfig {
  /** The CLAUDE.md files a session loads: the user's, and the project folder's and each parent's. */
  readonly maxClaudeMdChars: number;
  /** The project's memory index (`MEMORY.md`). */
  readonly maxMemoryIndexChars: number;
  /** The skill listing: one `name: description` line per skill. */
  readonly maxSkillListingChars: number;
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
  /** The local rules kept although they conflict with a core rule, each with the side that wins (`rules keep`). */
  readonly ruleConflicts: readonly RuleConflict[];
  readonly messages: MessagesConfig;
  readonly register: RegisterConfig;
  readonly skills: SkillsConfig;
  readonly contextFiles: ContextFilesConfig;
  readonly lock: LockConfig;
  readonly pushGuard: PushGuardConfig;
  readonly commits: CommitsConfig;
  readonly coordinator: CoordinatorConfig;
  readonly budget: BudgetConfig;
  readonly leadBoundary: LeadBoundaryConfig;
  readonly loops: LoopsConfig;
  readonly wake: WakeConfig;
  readonly tests: TestsConfig;
  readonly github: GithubConfig;
  readonly alerts: AlertsConfig;
  readonly tabStatus: { readonly enabled: boolean };
  readonly refresh: RefreshConfig;
  readonly hiring: HiringConfig;
  readonly burst: BurstConfig;
  /** How `teamrig open` starts a session in a new terminal tab. */
  readonly open: OpenConfig;
  /** Each session's Claude Code model and effort, by id; the lead's unset keys take `DEFAULT_LEAD_LAUNCH`. */
  readonly launch: Readonly<Record<string, LaunchConfig>>;
  readonly paths: PathsConfig;
}
