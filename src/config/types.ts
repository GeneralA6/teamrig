import type { TaskStatus } from '../register/model.ts';

/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 1;

export interface RolesConfig {
  /** Owns priorities, team rules and the owner's decision queue; may re-tier and reassign tasks. */
  readonly lead: string;
  /** Owns deploy coordination and fleet health, when the team has that role. */
  readonly coordinatorOwner?: string;
}

export interface TierConfig {
  readonly id: number;
  readonly name: string;
}

export interface RegisterCheckConfig {
  /** An active task untouched this long is STALE. */
  readonly staleAfterHours: number;
  /** An open task its owner has not touched this long after assignment is NOT-PICKED-UP. */
  readonly notPickedUpAfterHours: number;
  readonly weekLengthDays: number;
}

export interface RegisterConfig {
  /** The `--source` that marks a task as ordered by the human owner. */
  readonly ownerSource: string;
  readonly tiers: readonly TierConfig[];
  /** When set, every goal tag on a new task must match this regular expression. */
  readonly goalPattern?: string;
  readonly maxTitle: number;
  readonly maxText: number;
  /** Extra regular expressions that refuse secret-looking text, on top of the built-in ones. */
  readonly secretPatterns: readonly string[];
  readonly requireEvidenceOnDone: boolean;
  readonly requireSkillOnDone: boolean;
  /** Statuses that cannot be set without a note. */
  readonly requireNoteOn: readonly TaskStatus[];
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
  /** Branches a push to which needs the human's confirmation; force-push and deletion are refused. */
  readonly protectedBranches: readonly string[];
}

export const COMMIT_GATES = ['off', 'warn', 'refuse'] as const;
/** What a push to a protected branch does about commits over the size rule: nothing, list them, or refuse the push. */
export type CommitGate = (typeof COMMIT_GATES)[number];

export function isCommitGate(value: unknown): value is CommitGate {
  return COMMIT_GATES.some((gate) => gate === value);
}

/** The small-commits rule: one logical change per commit, and a reason line on any commit over the bounds. */
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

export interface BudgetConfig {
  /** Off by default: pacing needs a usage source that not every plan provides. */
  readonly enabled: boolean;
  /** Use the week up to this share of the weekly limit. */
  readonly targetPct: number;
  /** Kept back for incidents until shortly before the reset. */
  readonly reservePct: number;
}

export interface ScheduleConfig {
  /** No heavy step starts on the host after this UTC time (HH:MM) until midnight. */
  readonly heavyCutoffUtc?: string;
}

/** The deploy coordinator's settings; M1 reads only what the rule pack states. */
export interface CoordinatorConfig {
  readonly schedule: ScheduleConfig;
  readonly budget: BudgetConfig;
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
  /** Mark the tab `↻ <name>` once the session's handover is written and it waits for /clear. */
  readonly tabTitle: boolean;
  /** The handover folder; a relative one is resolved against the team's folder. Unset: `<team folder>/handover`. */
  readonly handoverDir?: string;
}

export interface PathsConfig {
  readonly state?: string;
  readonly inbox?: string;
  readonly skills?: string;
}

export interface KitConfig {
  readonly configVersion: number;
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
  readonly messages: { readonly maxLines: number };
  readonly register: RegisterConfig;
  readonly skills: SkillsConfig;
  readonly lock: LockConfig;
  readonly pushGuard: PushGuardConfig;
  readonly commits: CommitsConfig;
  readonly coordinator: CoordinatorConfig;
  readonly alerts: AlertsConfig;
  readonly tabStatus: { readonly enabled: boolean };
  readonly refresh: RefreshConfig;
  readonly paths: PathsConfig;
}
