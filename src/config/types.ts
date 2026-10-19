import type { TaskStatus } from '../register/model.ts';
import type { CoreRuleKey } from '../rules/keys.ts';

/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 4;

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
   * Statuses (of verifying, done and dropped) that cannot be set without `--followups`: the tasks the work leaves,
   * such as a finding or a next step, or `none`. A finding written only in a notes file then cannot close unseen.
   */
  readonly requireFollowupsOn: readonly TaskStatus[];
  /**
   * Whether a write archives the task list's log by itself once it is long (register/rotate.ts), as it does
   * after the first `teamrig compact`. Off, only `teamrig compact` archives it.
   */
  readonly autoArchive: boolean;
  /**
   * Whether `set --status waiting` on the owner's decision or approval needs a decision card (`--question`,
   * `--options`, `--recommend`, `--default`; register/card.ts), so the owner decides from it alone.
   */
  readonly requireDecisionCard: boolean;
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

export interface PackageGuardConfig {
  /** What a Bash or PowerShell call that runs a package ad hoc does. */
  readonly adHocRunners: AdHocRunners;
}

/**
 * An ad-hoc package run, one that fetches a package outside the project's lockfile and runs it at once (`npx` of a
 * tool not in `node_modules/.bin`, `npm exec`, `npm create`/`init <x>`, `pnpm dlx`, `yarn dlx`, `bunx`): `deny`
 * refuses it, `ask` asks the human, `allow` lets it run.
 */
export type AdHocRunners = 'deny' | 'ask' | 'allow';

/**
 * The opt-in hook that lets a Bash or PowerShell line run without a permission prompt when every command in it
 * provably only reads (hook-readonly-allow.ts). It only ever allows: a line it cannot prove reads falls through to
 * Claude Code's own permission check.
 */
export interface ReadonlyShellConfig {
  readonly enabled: boolean;
  /**
   * Commands the team trusts with any arguments, each by its leading words (`npx tsc --noEmit`), such as the
   * project's type check or test runner. The hook cannot read what such a command does, so a prefix vouches for
   * every argument after it.
   */
  readonly allowPrefixes: readonly string[];
}

export const AD_HOC_RUNNERS: readonly AdHocRunners[] = ['deny', 'ask', 'allow'];

export function isAdHocRunners(value: unknown): value is AdHocRunners {
  return AD_HOC_RUNNERS.some((choice) => choice === value);
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
  /**
   * The day's start (`HH:MM` UTC, outside the budget's quiet hours): from then each session with work it can start,
   * of any priority, that has had no turn since gets one wake that day, and a burst wakes its sessions the same way
   * once it starts. Unset: no day-start wake, and a burst wakes no one.
   */
  readonly dayStartUtc?: string;
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
  /**
   * What a quiet minute counts on the pace line and in the daily budget, against 1 for any other minute (0..1).
   * Unset: 0, the team sleeps, so the line stays flat through the night.
   */
  readonly paceWeight?: number;
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
  /**
   * No deploy (`teamrig integrate`) starts from this many hours before the weekly token reset until the reset, so
   * nothing that may need a fix lands while the week has no budget left to fix it. Unset: no blackout.
   */
  readonly resetBlackoutHours?: number;
}

/** `teamrig heavy`: one heavy step on the host at a time, each under the host lock. */
export interface HeavyConfig {
  /**
   * The host lock file every heavy step takes; a relative path is in the team's folder. Unset: `<kit home>/host.lock`,
   * one lock for every team on the host.
   */
  readonly lockPath?: string;
  /** A taken host lock lasts this many minutes; past it, another step takes it over. */
  readonly lockTtlMinutes: number;
  /** A heavy step still running after this many minutes is killed with every process it started. */
  readonly maxRunMinutes: number;
  /** A heavy step waits this many minutes at most for the host lock, then is refused. */
  readonly waitMinutes: number;
}

/** How a coordinator step waits. */
export interface CoordinatorWaitConfig {
  /** A waiting step looks again after this many seconds. */
  readonly pollSeconds: number;
  /** A deploy step (`teamrig integrate`) waits this many minutes at most for quiet claims and the host lock, then is refused. */
  readonly maxMinutes: number;
}

/** A repository `teamrig integrate` lands branches of on its default branch. */
export interface CoordinatorRepoConfig {
  /** The repository's main checkout; a branch integrates from any worktree of it. A relative path is in the team's folder. */
  readonly mainCheckout: string;
  /**
   * The deploy targets a push to the default branch deploys by itself (a host that builds on push): quiet claims on
   * them hold the integrate, and the push is recorded as their deploy.
   */
  readonly deploysOnPush: readonly string[];
  /**
   * Refuse a branch whose package files need a dependency install, so pulling it into the main checkout never
   * changes, unreviewed, the node_modules its worktrees link to; `dependencyCheck` can clear one.
   */
  readonly dependencyGate: boolean;
  /**
   * With `dependencyGate`, what clears a dependency change for `teamrig integrate`: a program and its arguments, run
   * without a shell in the branch's checkout under the host lock, after the rebase and before the push, with the
   * default branch's package-lock.json in the file `TEAMRIG_BASELINE_LOCK` names (unset when that branch has none).
   * Exit 0 lands the change, anything else refuses it. Unset: the gate refuses every dependency change.
   */
  readonly dependencyCheck?: readonly string[];
  /** After the push, fast-forward the main checkout to it: only a fast-forward, only on the default branch with no tracked changes. */
  readonly followMainCheckout: boolean;
  /** How `teamrig roll` deploys what landed on the default branch; unset: the repository is not rolled. */
  readonly roll?: RollConfig;
}

/** A check `teamrig roll` asks before it rolls: a program and its arguments, run without a shell from the main checkout. */
export interface RollGateConfig {
  /** Names the gate in a wait or refusal, such as `flow`. */
  readonly name: string;
  /** Exit 0 lets the roll go, 75 makes it wait, 2 refuses it; anything else, or no answer in time, makes it wait. */
  readonly command: readonly string[];
}

/** How `teamrig roll` deploys a repository's default branch from its main checkout, each command run without a shell. */
export interface RollConfig {
  /** The deploy targets the roll deploys: quiet claims on them hold it. */
  readonly targets: readonly string[];
  /** Asked in order before the host lock and again under it; the first that does not pass holds the roll. */
  readonly gates: readonly RollGateConfig[];
  /** Run in order after the pull, before `command`; one that fails ends the roll before it deploys. */
  readonly afterPull: readonly (readonly string[])[];
  /** Deploys what the pull brought: exit 0 rolled (a stdout line `no-roll`: nothing needed rolling), else failed. */
  readonly command: readonly string[];
}

/** `teamrig claim`: quiet claims, which hold deploys of their targets while a session measures them. */
export interface ClaimsConfig {
  /** A claim lasts at most this many minutes. */
  readonly maxMinutes: number;
}

/** `teamrig windows`: when a measurement of a deploy target is clean, between the deploys and heavy steps that disturb it. */
export interface WindowsConfig {
  /** A target measures cleanly this many minutes after a deploy rolled it. */
  readonly settleMinutes: number;
  /** Per deploy target, its own settle minutes in place of `settleMinutes`. */
  readonly targetSettleMinutes: Readonly<Record<string, number>>;
  /** How long a deploy is taken to have rolled before its ledger.md line when the ledger has no record of its start. */
  readonly assumedRollMinutes: number;
  /** The shortest clean window worth listing. */
  readonly minMinutes: number;
}

/**
 * The deploy coordinator: its folder, the heavy-step cutoff and the reset blackout, the host lock, how a step waits,
 * quiet claims, clean measurement windows, and the repositories `teamrig integrate` lands branches of and `teamrig roll` deploys.
 */
export interface CoordinatorConfig {
  /** The coordinator's folder, which holds its ledger; a relative path is in the team's folder. Unset: `<state>/deploys`. */
  readonly dir?: string;
  readonly schedule: ScheduleConfig;
  readonly heavy: HeavyConfig;
  readonly wait: CoordinatorWaitConfig;
  /** A roll's gate still running after this many seconds is stopped, and the roll waits. */
  readonly gateTimeoutSeconds: number;
  readonly claims: ClaimsConfig;
  readonly windows: WindowsConfig;
  /** By name, such as `api`. */
  readonly repos: Readonly<Record<string, CoordinatorRepoConfig>>;
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

/** How `check` measures an area against its dated work for a SCALE-OUT flag (src/hiring/scale-out.ts). */
export interface ScaleOutConfig {
  /** Days back over which the tasks an area finished give its pace; at most the 8 days a register keeps finished tasks. */
  readonly windowDays: number;
  /** The fewest tasks an area must have finished in that window for its pace to count; below it the area is not measured. */
  readonly minDone: number;
  /** How many of the top priorities count: their dated tasks are the work an area must finish in time. */
  readonly topPriorities: number;
}

/**
 * Hiring temporary sessions: who decides, the cap every hire stays within, and when an area needs one. A hire has
 * no fixed daily budget: its part of the team's follows its share and queued work, like any session's.
 */
export interface HiringConfig {
  readonly policy: HiringPolicy;
  /** Hired sessions on the team at once. */
  readonly maxSessions: number;
  /** Hours a hired session may hold no open task before it is due to retire. */
  readonly idleHours: number;
  /** Days from a hire to its review date, unless the hire names one. */
  readonly reviewDays: number;
  /** The most context tokens a rehired session's last Claude Code session may hold for `open --resume` to resume it. */
  readonly resumeMaxTokens: number;
  /** The most days that session may have been idle (its transcript unwritten) for `open --resume` to resume it. */
  readonly resumeMaxIdleDays: number;
  readonly scaleOut: ScaleOutConfig;
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

/** What `teamrig statusline` shows beside the model and the plan's use of the week. */
export interface StatusLineConfig {
  /** The name of the session's folder. */
  readonly folder: boolean;
  /** The branch checked out there, or the commit of a detached HEAD. */
  readonly branch: boolean;
  /** The command that resumes the session: `claude --resume <session id>`. */
  readonly resume: boolean;
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
  readonly packageGuard: PackageGuardConfig;
  readonly commits: CommitsConfig;
  readonly coordinator: CoordinatorConfig;
  readonly budget: BudgetConfig;
  readonly leadBoundary: LeadBoundaryConfig;
  readonly loops: LoopsConfig;
  readonly wake: WakeConfig;
  readonly tests: TestsConfig;
  readonly github: GithubConfig;
  readonly alerts: AlertsConfig;
  /**
   * A colored circle before each tab's title for what its session is doing (hook-tab-status.ts). It also
   * needs Claude Code's own title off (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`), else Claude Code writes over it.
   */
  readonly tabStatus: { readonly enabled: boolean };
  /** Lets a shell line that only reads run without a permission prompt; off by default. */
  readonly readonlyShell: ReadonlyShellConfig;
  readonly refresh: RefreshConfig;
  readonly hiring: HiringConfig;
  readonly burst: BurstConfig;
  /** How `teamrig open` starts a session in a new terminal tab. */
  readonly open: OpenConfig;
  /** What `teamrig statusline` shows. */
  readonly statusLine: StatusLineConfig;
  /** Each session's Claude Code model and effort, by id; the lead's unset keys take `DEFAULT_LEAD_LAUNCH`. */
  readonly launch: Readonly<Record<string, LaunchConfig>>;
  readonly paths: PathsConfig;
}
