import type { TaskStatus } from '../register/model.ts';
import type { CoreRuleKey } from '../rules/keys.ts';

/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 8;

export interface RolesConfig {
  /** Owns priorities, team rules and the owner's decision queue; may re-prioritize and reassign tasks; hands the work itself to others (`leadBoundary`). */
  readonly lead: string;
  /**
   * Owns the delivery flow and fleet health, when the team has that role: a session id of the team, or `<team>/<id>`,
   * the holder of the same role on a team above it (T1143), for a child team with no delivery owner of its own.
   */
  readonly deliveryOwner?: string;
  /**
   * Reviews the privileged commands sessions ask to run (`exec`), when the team has that role; the owner always may too.
   * A session id of the team, or `<team>/<id>`, the reviewer of a team above it (T1143).
   */
  readonly securityReviewer?: string;
}

/** One priority level; tasks print it as `p<id>`, and p1 is the most urgent. */
export interface PriorityConfig {
  readonly id: number;
  readonly name: string;
}

/** How a bug's review is asked (T916). */
export interface RegisterReviewConfig {
  /** What `set` does when a bug reaches a `requireOn` status with review parts missing. */
  readonly mode: ReviewMode;
  /** The statuses (of verifying and done) a bug cannot reach with review parts missing. */
  readonly requireOn: readonly TaskStatus[];
  /** Sessions whose every bug counts as critical and so is asked `--harden` too: a team's security or data areas. */
  readonly criticalOwners: readonly string[];
  /**
   * A regular expression, matched case-insensitively against the title and description of a task with no type: a match
   * prints a hint to mark the task `--type bug` (or `--type task`) when it is added and when it starts.
   */
  readonly hintPattern: string;
}

export interface RegisterCheckConfig {
  /** An active task untouched this long is STALE. */
  readonly staleAfterHours: number;
  /** An open task its owner has not touched this long after assignment is NOT-PICKED-UP. */
  readonly notPickedUpAfterHours: number;
  /** A session's in-progress task outranked this long by its own open task, on band and score, is a PRIORITY-SKIP. */
  readonly prioritySkipAfterHours: number;
  /**
   * A session that added more tasks for itself (created by it, asked by no one else) in the last 24 h than this is a
   * SELF-MADE; 0 turns the flag off.
   */
  readonly maxSelfMadePerDay: number;
  /**
   * The whole days (the team's day: `wake.dayStartUtc`, else UTC) that may end with no goal or week-plan task moved
   * while the week has usage left, before NO-PROGRESS; 0 turns the flag off.
   */
  readonly goalProgressDays: number;
  /**
   * An active sized task whose metered cost since it was last sized passed this many times its size (`--size`) is
   * OVER-SIZE; 0 turns the flag off.
   */
  readonly overSizeMultiple: number;
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
  /** How `add` and `update` hold a task's goal tags to the goal records (`teamrig goal`); see `GoalsMode`. */
  readonly goals: GoalsMode;
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
  /**
   * Whether `set --status verifying` needs `--proof`, what will prove the shipped change works, and `--waits` naming
   * when it runs: a time, or a task in progress or verifying.
   */
  readonly requireProofOnVerifying: boolean;
  /** What `set --status in-progress` does while a task it needs is still verifying, or, on a first start, while its owner's own verify steps are due. */
  readonly verifyGate: VerifyGate;
  /** A session holding more verifying tasks than this is a PILE-UP in `check`, and its oldest are due to verify before new work starts; 0 turns both off. */
  readonly maxVerifying: number;
  /**
   * How many times in a row a verifying task's proof may be put off to other waits; past it `set --status verifying`
   * with other waits is refused, and `check` flags REPARKED on the task. 0 turns both off.
   */
  readonly maxReparks: number;
  readonly check: RegisterCheckConfig;
  readonly review: RegisterReviewConfig;
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

export const GOALS_MODES = ['free', 'checked', 'required'] as const;
/**
 * A task's goal tags against the goal records of its team and every team above it: `free` (any tag), `checked`
 * (each tag named must be such a goal record), or `required` (checked, and an owner-asked or p0/p1 `add` names its
 * goal or `--goals none`).
 */
export type GoalsMode = (typeof GOALS_MODES)[number];

export function isGoalsMode(value: unknown): value is GoalsMode {
  return GOALS_MODES.some((mode) => mode === value);
}

export const REVIEW_MODES = ['refuse', 'warn', 'off'] as const;
/**
 * A bug reaching a `register.review.requireOn` status with review parts missing: `refuse` the change and
 * name the missing flags, `warn` (make it and print them), or `off` (ask nothing).
 */
export type ReviewMode = (typeof REVIEW_MODES)[number];

export function isReviewMode(value: unknown): value is ReviewMode {
  return REVIEW_MODES.some((mode) => mode === value);
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

/**
 * How a launched session's Claude Code lists a skill of another session's area, as its `skillOverrides` setting takes
 * it: `on` in full, `name-only` without its description, `user-invocable-only` only as a `/name` command the model is
 * not shown, `off` not at all.
 */
export const OTHER_AREA_LISTINGS = ['on', 'name-only', 'user-invocable-only', 'off'] as const;
export type OtherAreaListing = (typeof OTHER_AREA_LISTINGS)[number];

export function isOtherAreaListing(value: unknown): value is OtherAreaListing {
  return OTHER_AREA_LISTINGS.some((listing) => listing === value);
}

export interface SkillsConfig {
  /** The area prefix of skills shared by the whole team, e.g. `team-...`. */
  readonly sharedPrefix: string;
  readonly maxDescriptionWords: number;
  readonly maxPerArea: number;
  readonly maxVerifiedAgeDays: number;
  /** Frontmatter keys a team skill may not set, e.g. `allowed-tools` (a skill is never a permission). */
  readonly forbidFrontmatter: readonly string[];
  /** How a launched session lists a skill of another area whose `Used by:` line does not name it. */
  readonly otherAreas: OtherAreaListing;
}

export interface LockConfig {
  readonly ttlMs: number;
  readonly pollMs: number;
  readonly waitMs: number;
}

/** Privileged commands a reviewer approved, run by `teamrig exec` (src/exec/). */
export interface ExecConfig {
  /**
   * The directories a request's bare program name is looked up on, in order, and the only PATH its commands get; the
   * session's own PATH is never searched. Empty: a request names its program by absolute path.
   */
  readonly path: readonly string[];
  /**
   * The name of the environment variable that holds the webhook URL every approval, refusal and run is posted to
   * (spec §10), never the URL itself, which is a secret. Absent: nothing is posted.
   */
  readonly webhookEnv?: string;
}

export interface PushGuardConfig {
  /** Branches the push guard watches: a push to one goes as `pushToProtected` says; force-push, mirror and deletion are refused. */
  readonly protectedBranches: readonly string[];
  /** What a normal push to a protected branch does. */
  readonly pushToProtected: PushToProtected;
  /** The team's review gate entries, read on top of teamrig's generic list: adding one narrows, none removes a generic one. */
  readonly reviewPaths: readonly ReviewPath[];
}

/**
 * A normal push to a protected branch: `ask` the human, `allow` it with a note, or `lead`: the lead's own goes through
 * with a note, another session's only once the lead approved one of its waiting tasks (`teamrig approve`, T684), else
 * it is refused with how to ask, never asked of the human. `gated` (T800 §2.1, T858) clears a hand push as `lead` does,
 * and `teamrig merge` merges a change that holds the self-merge gates with no approval, logging it, and holds one
 * that misses a gate for its session's leader. None changes a refusal, a `--force-with-lease` push, or a command the
 * guard cannot read, which still asks.
 */
export type PushToProtected = 'ask' | 'allow' | 'lead' | 'gated';

export const PUSH_TO_PROTECTED: readonly PushToProtected[] = ['ask', 'allow', 'lead', 'gated'];

export function isPushToProtected(value: unknown): value is PushToProtected {
  return PUSH_TO_PROTECTED.some((choice) => choice === value);
}

/**
 * How the review gate treats a path a change touches (T800 §2.2): `always` waits on the entry's reviewer; `check` runs
 * the repo's review check, which clears the change or sends it to a reviewer.
 */
export type ReviewPathMode = 'always' | 'check';

export const REVIEW_PATH_MODES: readonly ReviewPathMode[] = ['always', 'check'];

export function isReviewPathMode(value: unknown): value is ReviewPathMode {
  return REVIEW_PATH_MODES.some((mode) => mode === value);
}

/** Who reviews a held change: security, or the session's leader (the lead or a sub-lead, T781). */
export type ReviewClass = 'security' | 'leader';

export const REVIEW_CLASSES: readonly ReviewClass[] = ['security', 'leader'];

export function isReviewClass(value: unknown): value is ReviewClass {
  return REVIEW_CLASSES.some((reviewer) => reviewer === value);
}

/** One review gate entry: the paths it covers (see `reviewPathMatcher`), how they are reviewed, and by whom. */
export interface ReviewPath {
  readonly glob: string;
  readonly mode: ReviewPathMode;
  readonly class: ReviewClass;
}

export interface PackageGuardConfig {
  /** What a Bash or PowerShell call that runs a package ad hoc does. */
  readonly adHocRunners: AdHocRunners;
  /** What a Bash or PowerShell call that installs a package version the guard cannot vet does. */
  readonly installs: PackageInstalls;
  /** A version published fewer days ago than this is not vetted: a fresh release is unproven. */
  readonly cooldownDays: number;
}

/**
 * An install the guard cannot vet (`npm install`, `pnpm add`, `yarn add`, `bun add` and their updates): a range or a
 * bare update rather than an exact version or tag, a git or URL source, or a version published fewer than
 * `cooldownDays` ago or with a known advisory: `deny` refuses it, `ask` asks the human, `allow` lets it run.
 */
export type PackageInstalls = 'deny' | 'ask' | 'allow';

/**
 * An ad-hoc package run, one that fetches a package outside the project's lockfile and runs it at once (`npx` of a
 * tool not in `node_modules/.bin`, `npm exec`, `npm create`/`init <x>`, `pnpm dlx`, `yarn dlx`, `bunx`): `deny`
 * refuses it, `ask` asks the human, `allow` lets it run.
 */
export type AdHocRunners = 'deny' | 'ask' | 'allow';

export interface CommitGuardConfig {
  /** What a Bash or PowerShell call that runs git without the repository's hooks does. */
  readonly skipHooks: SkipHooks;
}

/**
 * A git command run without the repository's hooks: `--no-verify` (or `-n` for `git commit` and `git am`), `HUSKY`
 * set for it, or a `core.hooksPath` that `-c`, a `GIT_CONFIG*` variable or `git config` sets or unsets: `deny`
 * refuses it, `ask` asks the human, `allow` lets it run.
 */
export type SkipHooks = 'deny' | 'ask' | 'allow';

/** The permission prompts teamrig's own hooks raise. */
export interface PromptsConfig {
  /** What a hook does with a call it would ask the human about. */
  readonly hookAsks: HookAsks;
  /** Whether a sanctioned route's line runs with no permission check at all while asks are refused. */
  readonly routeAllow: RouteAllow;
}

/**
 * Under `hookAsks: refuse`, `on` lets a Bash line that runs a sanctioned route marked for it (permissions/sanctioned.ts)
 * run before any permission check, once every teamrig guard passed it (hook-route-allow.ts); `off` takes that allow
 * away without a release. It only takes allows away: nothing in config widens the table (security ruling Q7.5). Inert
 * while `hookAsks` is `ask`.
 */
export type RouteAllow = 'on' | 'off';

/**
 * A call a teamrig hook would ask the human about (a push to a protected branch or one it cannot read, an ad-hoc
 * package run, an install it cannot vet, a git command without hooks, a call that would print a secret, a helper over
 * the budget, as their own keys set): `ask` raises the permission prompt; `refuse` refuses it instead, its reason telling the session to record the step as waiting for
 * the owner's approval and take its next task, so no prompt holds a session while nobody is there to answer it.
 * `refuse` also answers the prompts Claude Code raises on its own, per case (hooks/prompt-refuse.ts): a line that
 * provably only reads runs, a line teamrig's rules give a rerun form is refused quoting it, anything else is refused.
 */
export type HookAsks = 'ask' | 'refuse';

export interface SecretGuardConfig {
  /** What a Bash, PowerShell, Read or Grep call that would print a secret does. */
  readonly secretReads: SecretReads;
  /**
   * What a Bash or PowerShell call whose command line holds a secret as text does, and a file-writing call whose
   * written text holds one outside a secret file (T1369 R12).
   */
  readonly writes: SecretWrites;
  /**
   * The team's own secret files, globs read after the guard's defaults (`.env`, `~/.npmrc`, `~/.ssh/**`...): `~/`
   * starts at home, a glob without a leading `/` or drive matches at any depth, and the last glob that matches a path
   * decides, so `!glob` keeps a path readable.
   */
  readonly paths: readonly string[];
  /**
   * The team's own patterns for environment variables whose values are secrets, regular expressions over the name
   * (case ignored) read after the guard's defaults (`TOKEN`, `SECRET`, `PASSW`..., a store's URL by its kind: `DB_URL`,
   * `CACHE_URL`); a store named by its product is the team's to add. The last pattern that matches a name decides, so
   * `!pattern` keeps a variable printable.
   */
  readonly envNames: readonly string[];
  /**
   * The team's own commands whose output is a secret whatever they name, regular expressions over a run's line
   * (`<program> <args>`, case ignored) read after the guard's defaults (`kubectl config view --raw`). The last pattern
   * that matches a line decides, so `!pattern` lets a command print.
   */
  readonly commands: readonly string[];
  /**
   * Whether a Bash, PowerShell, Read or Grep result reaches the model and the transcript with each secret it holds
   * replaced (hooks/secret-redact.ts); turning it off is the owner's call (T1369).
   */
  readonly redact: boolean;
}

/**
 * A call that would print a secret: a secret file's content (`cat .env`, `Get-Content ~/.npmrc`, the Read tool), the
 * whole environment (`env`, `printenv`, `Get-ChildItem Env:`), a secret variable (`echo $GITHUB_TOKEN`), a
 * Kubernetes secret's data or a dump command's output (`kubectl config view --raw`): `deny` refuses it, `ask` asks the
 * human, `allow` lets it run.
 */
export type SecretReads = 'deny' | 'ask' | 'allow';

/**
 * A call that holds a secret as text: a Bash or PowerShell line with a token, credentials in a URL or an
 * `Authorization` header in it, or a Write, Edit, MultiEdit or NotebookEdit whose text holds one outside a secret file:
 * `deny` refuses it, `ask` asks the human, `allow` lets it run.
 */
export type SecretWrites = 'deny' | 'ask' | 'allow';

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

/**
 * The local allow rules a team keeps (src/permissions/allow-rules.ts). An allow rule in a Claude Code settings file
 * approves a call before auto mode's classifier sees it; `permissions trim` removes the rules off this list, and doctor
 * flags the ones that approve a whole tool or program or hold a credential.
 */
export interface PermissionsConfig {
  /**
   * Rules kept as they are (`Bash(kubectl get *)`, `WebSearch`); `:*` and ` *` read as the same, `Tool(x *)` keeps
   * `Tool(x)`, and a shell rule's leading `MSYS_NO_PATHCONV=1 ` reads as absent. A team's list replaces the default.
   */
  readonly keepAllow: readonly string[];
}

export const AD_HOC_RUNNERS: readonly AdHocRunners[] = ['deny', 'ask', 'allow'];

export function isAdHocRunners(value: unknown): value is AdHocRunners {
  return AD_HOC_RUNNERS.some((choice) => choice === value);
}

export const PACKAGE_INSTALLS: readonly PackageInstalls[] = ['deny', 'ask', 'allow'];

export function isPackageInstalls(value: unknown): value is PackageInstalls {
  return PACKAGE_INSTALLS.some((choice) => choice === value);
}

export const SKIP_HOOKS: readonly SkipHooks[] = ['deny', 'ask', 'allow'];

export function isSkipHooks(value: unknown): value is SkipHooks {
  return SKIP_HOOKS.some((choice) => choice === value);
}

export const HOOK_ASKS: readonly HookAsks[] = ['ask', 'refuse'];

export function isHookAsks(value: unknown): value is HookAsks {
  return HOOK_ASKS.some((choice) => choice === value);
}

export const ROUTE_ALLOWS: readonly RouteAllow[] = ['on', 'off'];

export function isRouteAllow(value: unknown): value is RouteAllow {
  return ROUTE_ALLOWS.some((choice) => choice === value);
}

export const SECRET_READS: readonly SecretReads[] = ['deny', 'ask', 'allow'];

export function isSecretReads(value: unknown): value is SecretReads {
  return SECRET_READS.some((choice) => choice === value);
}

export const SECRET_WRITES: readonly SecretWrites[] = ['deny', 'ask', 'allow'];

export function isSecretWrites(value: unknown): value is SecretWrites {
  return SECRET_WRITES.some((choice) => choice === value);
}

export const COMMIT_GATES = ['off', 'warn', 'refuse'] as const;
/** What a push to a protected branch does about commits over the size rule: nothing, list them, or refuse the push. */
export type CommitGate = (typeof COMMIT_GATES)[number];

export function isCommitGate(value: unknown): value is CommitGate {
  return COMMIT_GATES.some((gate) => gate === value);
}

/** How long a message between sessions may be, and when a send to an idle session is held as a cold wake. */
export interface MessagesConfig {
  /** The longest message one session may send another. */
  readonly maxLines: number;
  /**
   * Minutes a session may sit idle before a message to it counts as a cold wake: its first call then
   * re-reads its whole context at full price. A send to a session idle this long is held once; 0 never holds.
   */
  readonly coldAfterMinutes: number;
}

/**
 * Each session's prompts and replies, kept in a file the task pane shows (src/turn-log/), so a /clear or a
 * compaction never takes away what the person was reading in the tab.
 */
export interface TurnLogConfig {
  /** Off: nothing is written. */
  readonly enabled: boolean;
  /** How long each entry is kept, in hours; whole hours past it are removed at a session start. */
  readonly keepHours: number;
}

/** How teamrig keeps the lead leading (T320): its own edits, tests and code searches are nudged and shown, never blocked. */
export interface LeadBoundaryConfig {
  /** Off: the lead's own work is neither nudged nor shown. */
  readonly enabled: boolean;
  /**
   * The lead's own files and folders beyond the team's teamrig folder and Claude Code's memory folders and session
   * scratchpads, which always count: editing or searching them is its job. `~` is the user's home, `*` one folder name.
   */
  readonly ownPaths: readonly string[];
  /** The turn's code search that brings the lead one nudge, and from which the owner's turn-end line counts searches; 0 never. */
  readonly searchNudgeAt: number;
}

/** Loop discipline inside a turn. */
export interface LoopsConfig {
  /**
   * After this many single-tool calls in a row in one turn, the session gets one line asking it to send
   * independent steps as several tool calls in one message; 0 never asks.
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
   * The least urgent priority that wakes a session: 1 wakes for p0 and p1 only. A session its budget holds (past
   * its daily budget while the team has no room today, the wake's own turn counted for both) or a short day pauses
   * (`budget.pauseByPriority`) wakes for p0 only, and one in the budget's quiet hours for p0 and p1 only, whatever
   * this says.
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
  /**
   * The label that lets an issue by an author outside the repository (not its owner, an organization member or a
   * collaborator) become a task: it counts when someone other than the author added it last and the title and body
   * were not edited after that. Matched without case.
   */
  readonly acceptLabel: string;
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
  /**
   * Regular expressions over `/`-separated paths; a non-test file that matches one is source. A change of source with
   * no test changed misses the self-merge gate (`pushToProtected: gated`, T858).
   */
  readonly sourcePatterns: readonly string[];
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

/** One session's weight in the split of the team's daily budget (src/budget/parts.ts `dailyBudgetOf`). */
export interface SessionBudget {
  /** Times its top queued task's weight: the session gets the team's budget × that / the sum over the sessions. */
  readonly share: number;
}

/**
 * The bounds on a leader's lift of a session's or a sub-lead's group's daily budget. Every lift carries a stop %, the share of
 * the week at which it ends; the reserve stop % is only for the one reserve release shortly before the reset.
 */
export interface BudgetLiftConfig {
  /** The highest stop % a lift may carry. */
  readonly maxStopPct: number;
  /** The highest stop % of a `--reserve` lift, given only in the last hour before the reset. */
  readonly reserveStopPct: number;
}

/**
 * The budget keys of the account's week, and whether the budget is on: a team under another (`team.parent`) that
 * leaves one unset takes the team above's, unless it names another account (src/cli/kit.ts openKit), so the teams of
 * a tree read one week alike without a copy that drifts.
 */
export const ACCOUNT_BUDGET_KEYS = ['enabled', 'account', 'weeklyLimitW', 'subagentWeight', 'extraWPerUsd', 'reset'] as const satisfies readonly (keyof BudgetConfig)[];

/** The keys of ACCOUNT_BUDGET_KEYS as a team reads them, its own or the team above's. */
export type AccountBudget = Pick<BudgetConfig, (typeof ACCOUNT_BUDGET_KEYS)[number]>;

/**
 * The weekly token budget: the pace line the team is measured against and each session's daily part
 * of it. Off by default, and the defaults only measure and show: nothing blocks or acts.
 */
export interface BudgetConfig {
  /** Turns on the live warning and the core rules' pacing sentence; `teamrig budget` shows usage either way. */
  readonly enabled: boolean;
  /**
   * The Claude account the team's week is on: teams with the same account share one week and split its daily
   * budget. Unset: the team above's (`AccountBudget`), else the one account the teams on its Claude config dir name
   * (the dir its sessions last started in, budget/config-dir.ts), else that dir, since one config dir signs in one
   * account (budget/account.ts `accountsOf`).
   */
  readonly account?: string;
  /** The weekly limit in weighted tokens (W). Unset: the team above's (`AccountBudget`), else derived from the status line's weekly %. */
  readonly weeklyLimitW?: number;
  /**
   * What one W of a subagent's transcript costs against the weekly limit, in W of a main session. The meter
   * multiplies each subagent call's W by it, so every W (and `weeklyLimitW`) is in main-session W. 1: alike.
   */
  readonly subagentWeight: number;
  /**
   * W per US dollar of extra usage, standing in until two spent readings past 100% of the week teach the rate
   * (src/budget/extra.ts). Unset: the team above's (`AccountBudget`), else the extra-usage pool shows in dollars only
   * until then, with no allowance.
   */
  readonly extraWPerUsd?: number;
  /** Unset: the team above's (`AccountBudget`), else the reset time the status line reports. */
  readonly reset?: BudgetReset;
  /** Use the week up to this share of the weekly limit. */
  readonly targetPct: number;
  /** Kept back for incidents until shortly before the reset. */
  readonly reservePct: number;
  /** The pace line reaches `targetPct` this many hours before the reset. */
  readonly paceEndHoursBeforeReset: number;
  /** Each session's part, by id; a session not listed has a share of 1. */
  readonly sessions: Readonly<Record<string, SessionBudget>>;
  /**
   * On a short day (what is left of the week gives less than the pace line plans for the day), fund the team's
   * sessions in the priority order of their top queued task and pause the sessions none of it reaches. The lead, the delivery owner
   * held in the team and lifted sessions are never paused. Off: no session of the team is paused.
   */
  readonly pauseByPriority: boolean;
  /** The live warning shows a line as a session passes each of these % of its daily budget. */
  readonly warnAtPct: readonly number[];
  /**
   * The five-hour check warns the lead at this % of the account's five-hour window. Its forecast catches a wave early;
   * this mark is the backstop for a steady rise the forecast keeps under 100%.
   */
  readonly fiveHourWarnPct: number;
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
  /** No queued step starts on the host after this UTC time (HH:MM) until midnight. */
  readonly queueCutoffUtc?: string;
  /**
   * No deploy (`teamrig merge`) starts from this many hours before the weekly token reset until the reset, so
   * nothing that may need a fix lands while the week has no budget left to fix it. Unset: no blackout.
   */
  readonly resetBlackoutHours?: number;
}

/** `teamrig queue`: one queued step on the host at a time, each under the host lock. */
export interface QueueConfig {
  /**
   * The host lock file every queued step takes; a relative path is in the team's folder. Unset: `<kit home>/host.lock`,
   * one lock for every team on the host.
   */
  readonly lockPath?: string;
  /** A taken host lock lasts this many minutes; past it, another step takes it over. */
  readonly lockTtlMinutes: number;
  /** A queued step still running after this many minutes is killed with every process it started. */
  readonly maxRunMinutes: number;
  /**
   * A small step (`queue --small`) still running after this many minutes is killed the same way; at most
   * maxRunMinutes. A small step shares the host beside others and holds back any step waiting for the lock, so a hung
   * one is cut short; a longer step runs without --small.
   */
  readonly smallMaxRunMinutes: number;
  /** A queued step is refused once its line for the host lock has not moved for this many minutes: no step ahead of it, holding the lock or sharing the host ended meanwhile. */
  readonly waitMinutes: number;
  /**
   * While a queued step runs, its process tree's memory and the host's free memory are sampled this often, for its
   * ledger record's `peakTreeMb` and `lowFreeMb`; 0 samples nothing.
   */
  readonly memorySampleSeconds: number;
  /** A small step (`queue --small`) shares the host only while it keeps this many MB free besides those held for the small steps. */
  readonly memoryFloorMb: number;
  /** The MB held for a small step with no ledger record of its peak yet. */
  readonly smallReserveMb: number;
  /**
   * The least MB held for a heavy queued step, a merge or a deploy besides memoryFloorMb: it takes the host lock only
   * while free memory covers both (at most half the host's RAM). A heavy step whose ledger peak and a quarter is more
   * holds that instead.
   */
  readonly heavyReserveMb: number;
}

/** How a delivery step waits. */
export interface DeliveryWaitConfig {
  /** A waiting step looks again after this many seconds; the first in line for the host lock every 2 at most. */
  readonly pollSeconds: number;
  /** A deploy step (`teamrig merge`, `deploy`) waits this many minutes at most for deploy freezes and the host lock, then is refused; a wait in a line for the lock that keeps moving goes on past them. */
  readonly maxMinutes: number;
}

/** A repository whose branches `teamrig merge` merges into its default branch. */
export interface DeliveryRepoConfig {
  /** The repository's main checkout; a branch merges from any worktree of it. A relative path is in the team's folder. */
  readonly mainCheckout: string;
  /**
   * The deploy targets a push to the default branch deploys by itself (a host that builds on push): deploy freezes on
   * them hold the merge, and the push is recorded as their deploy.
   */
  readonly deploysOnPush: readonly string[];
  /**
   * Refuse a branch (merge) or a pushed range (deploy) whose package files need a dependency install, so the main
   * checkout's node_modules, which its worktrees link to, never changes unreviewed; `dependencyCheck` clears one for
   * merge, and with `deploy.dependencyInstall` for a deploy.
   */
  readonly dependencyGate: boolean;
  /**
   * With `dependencyGate`, what clears a dependency change: a program and its arguments, run without a shell under the
   * host lock with the base's package-lock.json in the file `TEAMRIG_BASELINE_LOCK` names (unset when the base has
   * none). `teamrig merge` runs it in the branch's checkout after the rebase and before the push, the default
   * branch its base; `teamrig deploy` in the main checkout after the pull, its old HEAD the base. Exit 0 lets the
   * change go, anything else refuses it. Unset: the gate refuses every dependency change.
   */
  readonly dependencyCheck?: readonly string[];
  /**
   * Hold a branch (merge) whose changed paths hit a review entry (teamrig's generic list and
   * `pushGuard.reviewPaths`) until its reviewer approves it, or `reviewCheck` clears its `check` hits (T800 §2.2).
   */
  readonly reviewGate: boolean;
  /**
   * With `reviewGate`, what a `check` hit runs: a program and its arguments, run without a shell under the host lock in
   * the branch's checkout after the rebase, with the base commit in `TEAMRIG_REVIEW_BASE`. Exit 0 clears the change, 3
   * holds it for the entry's reviewer with the findings it prints, anything else for that reviewer too, as a broken
   * check is no pass. Unset: a `check` hit is held like an `always` one.
   */
  readonly reviewCheck?: readonly string[];
  /**
   * The project's docs folder, where `decisionRecordGate` finds its `decisions` folder. A relative path is in the
   * repository; an absolute one may be outside it, such as a separate docs repository. Unset: `docs`.
   */
  readonly docsFolder?: string;
  /**
   * Refuse a branch (merge) whose task (a branch named `t<n>-…`) has a design note (a `.md` file in its task folder
   * named for a design, such as `design.md` or `pr2-design.md`) until the change adds or changes a decision record in
   * `<docsFolder>/decisions/`, so a design decided in a session's notes lands in the repository in its own words. A
   * docs folder outside the repository holds no branch's change: there a record that names the task clears it.
   */
  readonly decisionRecordGate: boolean;
  /** After the push, fast-forward the main checkout to it: only a fast-forward, only on the default branch with no tracked changes. */
  readonly updateMainCheckout: boolean;
  /**
   * The folder `teamrig worktree add` makes each new worktree in, one folder per branch named after it with each `/`
   * as `-`. A relative path is in the main checkout; unset: `.claude/worktrees` there.
   */
  readonly worktreeFolder?: string;
  /**
   * What `teamrig worktree add` runs in a new worktree, such as a link to the main checkout's node_modules: a program
   * and its arguments, run without a shell, with the main checkout's folder in `TEAMRIG_MAIN_CHECKOUT`. Anything but
   * exit 0 leaves the worktree in place and fails the add. Unset: nothing runs.
   */
  readonly worktreeSetup?: readonly string[];
  /** How `teamrig merge` merges a branch through the team's own flow, such as a pull request; unset: it pushes the branch to the default branch. */
  readonly merge?: MergeConfig;
  /** How `teamrig deploy` deploys what merged into the default branch; unset: the repository is not deployed. */
  readonly deploy?: DeployConfig;
}

/** A team's own way of merging a branch into the default branch, such as a pull request merged by the forge. */
export interface MergeConfig {
  /**
   * A program and its arguments, run without a shell in the branch's checkout under the host lock after the rebase and
   * the dependency check, with `TEAMRIG_MERGE_BRANCH`, `TEAMRIG_MERGE_BASE` (the default branch), `TEAMRIG_MERGE_HEAD`
   * and `TEAMRIG_SESSION` set. Exit 0: the branch merged, which `teamrig merge` confirms on the remote; 75: it waits (say a
   * pull request waits on its checks or review), and running `teamrig merge` again finishes it once it merges; anything else
   * fails it. Its last output line is shown as the reason.
   */
  readonly command: readonly string[];
  /**
   * The git remote whose default branch the command merges into: `teamrig merge` rebases onto it and confirms the merge on
   * it, and moves the local default branch to it. `origin` unless set; say `upstream` where origin is a contributor's
   * fork. The branch itself is pushed to and deleted from origin either way.
   */
  readonly remote: string;
}

/** A check `teamrig deploy` asks before it deploys: a program and its arguments, run without a shell from the main checkout. */
export interface DeployCheckConfig {
  /** Names the check in a wait or refusal, such as `flow`. */
  readonly name: string;
  /** Exit 0 lets the deploy go, 75 makes it wait, 2 refuses it; anything else, or no answer in time, makes it wait. */
  readonly command: readonly string[];
}

/** How `teamrig deploy` deploys a repository's default branch from its main checkout, each command run without a shell. */
export interface DeployConfig {
  /** The deploy targets it deploys: deploy freezes on them hold it. */
  readonly targets: readonly string[];
  /** Asked in order before the host lock and again under it; the first that does not pass holds the deploy. */
  readonly checks: readonly DeployCheckConfig[];
  /**
   * Installs a pulled range's dependency change (package-lock.json, or package.json fields an install reads), such as
   * `npm ci --ignore-scripts`: run after the pull and the `dependencyCheck`, before `afterPull`. A failed install
   * moves the main checkout back and runs again to restore its dependencies. With `dependencyGate`, a dependency
   * change deploys only when this and `dependencyCheck` are set.
   */
  readonly dependencyInstall?: readonly string[];
  /** Run in order after the pull, before `command`; one that fails ends the deploy before its command runs. */
  readonly afterPull: readonly (readonly string[])[];
  /** Deploys what the pull brought: exit 0 deployed (a stdout line `no-deploy`: nothing needed deploying), else failed. */
  readonly command: readonly string[];
}

/** `teamrig freeze`: deploy freezes, which hold deploys of their targets while a session measures them. */
export interface FreezesConfig {
  /** A freeze lasts at most this many minutes. */
  readonly maxMinutes: number;
}

/** `teamrig stable-periods`: when a measurement of a deploy target is clean, between the deploys and queued steps that disturb it. */
export interface StablePeriodsConfig {
  /** A target measures cleanly this many minutes after a deploy reached it. */
  readonly settleMinutes: number;
  /** Per deploy target, its own settle minutes in place of `settleMinutes`. */
  readonly targetSettleMinutes: Readonly<Record<string, number>>;
  /** How long a deploy is taken to have run before its ledger.md line when the ledger has no record of its start. */
  readonly assumedDeployMinutes: number;
  /** The shortest stable period worth listing. */
  readonly minMinutes: number;
}

/**
 * The delivery flow: its folder, the queue cutoff and the reset blackout, the host lock, how a step waits,
 * deploy freezes, the stable periods to measure in, and the repositories whose branches `teamrig merge` merges and `teamrig deploy` deploys.
 */
export interface DeliveryConfig {
  /** The delivery folder, which holds its ledger; a relative path is in the team's folder. Unset: `<state>/deploys`. */
  readonly dir?: string;
  readonly schedule: ScheduleConfig;
  readonly queue: QueueConfig;
  readonly wait: DeliveryWaitConfig;
  /** A deploy's check still running after this many seconds is stopped, and the deploy waits. */
  readonly checkTimeoutSeconds: number;
  readonly freezes: FreezesConfig;
  readonly stablePeriods: StablePeriodsConfig;
  /** By name, such as `api`. */
  readonly repos: Readonly<Record<string, DeliveryRepoConfig>>;
}

export interface AlertsConfig {
  /** The same external failure for this long must page a human. */
  readonly persistentFailureHours: number;
  /**
   * The name of the environment variable holding the chat webhook URL a page to the owner goes to (an expired Claude
   * login, src/restore/), never the URL itself, which is a secret. Absent, with `pageWebhookFile` absent too: no page.
   */
  readonly pageWebhookEnv?: string;
  /**
   * The absolute path of a one-line file holding that URL, read at each page, so the URL never sits in an environment,
   * a log or a session's read. Wins over `pageWebhookEnv` when both are set.
   */
  readonly pageWebhookFile?: string;
}

/** When the lead asks the owner the decisions waiting on them, together in a batch (src/decisions/batch.ts). */
export interface DecisionsConfig {
  /**
   * The lead's batch times, `HH:MM` UTC (its budget checkpoints, say). With none, a batch comes only at the daily
   * meeting or by `batchAt`, and a wait due within a day is asked at once.
   */
  readonly batchTimesUtc: readonly string[];
  /** A batch is due once this many waits on the owner are not yet asked; 0: never by count. */
  readonly batchAt: number;
  /** How the lead asks the owner at the daily meeting: in plain text, or with Claude Code's question picker. */
  readonly askWith: AskWith;
}

export const ASK_WITH = ['text', 'picker'] as const;
/**
 * How the daily meeting asks the owner each decision: `text` reads the cards in plain text and the owner answers in
 * their own words; `picker` asks the choices with Claude Code's question picker (AskUserQuestion), at most 4 a call.
 */
export type AskWith = (typeof ASK_WITH)[number];

export function isAskWith(value: unknown): value is AskWith {
  return ASK_WITH.some((way) => way === value);
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
  /** Title the tab once the session's handover is written: `[<team>] <name>: restarting`, or `[<team>] <name>: type /clear`. */
  readonly tabTitle: boolean;
  /**
   * Once the handover is written and the turn has ended, start the session fresh, which reads the handover:
   * the plugin's mod runs /clear in its tab; where no mod claims the ask, end its Claude Code process and start
   * it again, in the same tab when `teamrig open` started it, else in a new tab. A session with no work it can start
   * then waits for the wake that brings it some, which starts it fresh instead of waking it (T1383). A prompt typed
   * before then keeps the context. Off (the default): the user types /clear once done with the screen, which a /clear wipes.
   */
  readonly autoRestart: boolean;
  /** How long after the turn's end the automatic restart waits, so the user can still type to keep the context. */
  readonly restartDelaySeconds: number;
  /**
   * The plugin's mod holds the automatic /clear while the person typed in the tab's prompt (a key, a paste) or sent
   * a prompt there this recently, and while the prompt holds a draft: a /clear never lands under the person. The
   * default 30 min keeps the context through the person's talk in the tab (reading a reply, thinking it over), the
   * restart coming once they have been away that long (T1383). 0: only a draft holds it.
   */
  readonly holdAfterActivityMinutes: number;
  /**
   * Before the plugin's mod runs the automatic /clear, a band above the prompt counts down this many seconds, with
   * "Refresh now" and "Hold 10 min"; a key in the prompt holds it too. 0: no count, the /clear runs once nothing else holds it.
   */
  readonly countdownSeconds: number;
  /**
   * While a session's handover is asked for or written (the fresh start to come), the plugin's mod stops Claude Code's
   * own compaction (trigger `auto`) of its main conversation as long as the context, as Claude Code estimates it, is
   * under this many tokens: the /clear at the turn's end replaces the compaction. Past it a compaction goes through, so
   * a session never runs out of room (a prompt too long for the window is past it too); `/compact` and a subagent's own
   * compaction are never stopped. 0: never stopped. It also bounds an open owner meeting (the lead's daily one, or a
   * booked one from its `meeting start M<n>`), which holds the refresh of each session in it only under it
   * (src/refresh/decide.ts `meetingHolds`); 0 holds it until the meeting ends.
   */
  readonly compactCeilingTokens: number;
  /**
   * `teamrig refresh --ready` refuses a handover larger than this many bytes: the fresh start reads all of it, so a
   * handover that grows section by section fills the next session's context before its work begins. 0: no cap.
   */
  readonly handoverMaxBytes: number;
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
 * Who may hire a session onto the team (`teamrig hire`): `off` nobody; `owner` a lead (the lead, or a sub-lead
 * into its own group), once the owner approved (`--approved-by`, kept with the hire); `lead` a lead; `automatic` as
 * `lead`, and a hired session whose last open task closes is asked to write its handover (hiring/last-task-ask.ts).
 * Under every policy only a lead over a session retires it (`teamrig retire`).
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
 * Hiring the workers a team needs: who decides, and when an area needs one. No cap counts hires: the host's room
 * bounds who is at the office, and the leader decides who is hired. A hire with no task stays hired: the idle pass
 * deactivates it. A hire has no fixed daily budget: its part of the team's follows its share and queued work, like
 * any session's.
 */
export interface HiringConfig {
  readonly policy: HiringPolicy;
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
  /** The least share of the week, in %, projected unused at the pace end for a surplus burst: the team's part of the account's (src/budget/parts.ts `teamShareOf`). */
  readonly minSparePct: number;
  /** The most helpers each burst session runs at once. */
  readonly maxHelpers: number;
  /** The most sessions one burst may hire (`hire --burst`). */
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

/**
 * The room `teamrig open` and `teamrig hire --yes` need on the host before they add a session (src/sessions/headroom.ts),
 * and when `teamrig close` may end one to free it.
 */
export interface HeadroomConfig {
  /** The MB a new session is counted to need while no session runs to measure; else the median running session's tree. */
  readonly sessionMb: number;
  /** The most of the host's commit limit, in %, its commit charge may reach with the new session counted. */
  readonly commitMaxPct: number;
  /** How long, in minutes, a session stays quiet before `teamrig close` may end it. */
  readonly closeIdleMinutes: number;
}

/**
 * What the idle pass does with a session it would close or reopen (src/cli/idle-pass.ts): `off` runs no pass,
 * `dry-run` logs each step it would take and takes none, `on` also starts each close and reopen its steps ask for.
 */
export const IDLE_MODES = ['off', 'dry-run', 'on'] as const;
export type IdleMode = (typeof IDLE_MODES)[number];

export function isIdleMode(value: unknown): value is IdleMode {
  return IDLE_MODES.some((mode) => mode === value);
}

/** The idle pass: it closes a session the wake check would not wake once it is quiet, and reopens it when work arrives. */
export interface IdleConfig {
  readonly mode: IdleMode;
  /** Sessions never closed for being quiet (by the pass or `teamrig close`), on top of the lead and the delivery owner. */
  readonly keepOpen: readonly string[];
}

export interface OpenConfig {
  readonly terminal: TerminalChoice;
  /** Each tab of the team's sessions opens in a window of the team's own, apart from other teams' (Windows Terminal). */
  readonly teamWindow: boolean;
  readonly headroom: HeadroomConfig;
  readonly idle: IdleConfig;
}

/** What `teamrig statusline` shows beside the model and the plan's use of the week. */
export interface StatusLineConfig {
  /** The name of the session's folder. */
  readonly folder: boolean;
  /** The branch checked out there, or the commit of a detached HEAD. */
  readonly branch: boolean;
  /** Where the team's pace line stands now, beside the week's use: `week 63% (pace 53%)`. */
  readonly pace: boolean;
}

/** What the WIP rule does to a start it holds (`focus.wip.mode`): refuse it, let it through with a warning, or nothing. */
export const WIP_MODES = ['refuse', 'warn', 'off'] as const;
export type WipMode = (typeof WIP_MODES)[number];

export function isWipMode(value: unknown): value is WipMode {
  return WIP_MODES.some((mode) => mode === value);
}

/**
 * The WSJF score's parts (T2076): score = cost of delay / size, where cost of delay = value + urgency + unblocks +
 * owner order, and size is in percent of the week.
 */
export interface FocusScoreConfig {
  /** The value of a Roadmap task whose best goal rank is 1, 2 and so on; a rank past the list takes the last. */
  readonly rankValues: readonly number[];
  /** The value of a Roadmap task that serves no ranked goal. */
  readonly roadmapUnranked: number;
  /** The value of a Maintenance task, before its bug and critical additions. */
  readonly maintenanceValue: number;
  /** Added to a Maintenance task of type bug. */
  readonly maintenanceBug: number;
  /** Added to a Maintenance task marked critical. */
  readonly maintenanceCritical: number;
  /** The value of an Improvements task, and of one with no class. */
  readonly improvementsValue: number;
  /** The urgency of a task past its due. */
  readonly overdueValue: number;
  /** The urgency of a task due within `dueSoonDays`. */
  readonly dueSoonValue: number;
  readonly dueSoonDays: number;
  /** The share of the best value among the active tasks that need a task, added to its own. */
  readonly unblocksShare: number;
  /** The capped override an owner-sourced task's priority p1, p2 and so on adds; other tasks' priorities add nothing. */
  readonly ownerOrderValues: readonly number[];
  /** The size of a task with no size, spend or like tasks to measure by. */
  readonly defaultSizePct: number;
  /** The smallest size a score divides by, so a tiny task cannot outrank everything. */
  readonly minSizePct: number;
}

/** Which tasks go ahead of every score (band 0), beside a p0, which always does. */
export interface FocusExpediteConfig {
  /** A Maintenance task marked critical. */
  readonly critical: boolean;
  /** An owner-sourced p1 task. */
  readonly ownerP1: boolean;
}

/** The WIP rule: an Improvements start held while its owner has a Roadmap task that can move, and an in-progress cap. */
export interface FocusWipConfig {
  readonly mode: WipMode;
  /** The in-progress tasks a session may hold before a further start is held. */
  readonly maxInProgress: number;
}

/**
 * Goal-first ranking (T2076): the work classes a task is filed under, how its WSJF score is made, the WIP rule, and
 * the spend each class is planned to take. Every number is a default a team overrides.
 */
export interface FocusConfig {
  /** The classes `--class` takes, each spelled as WORK_CLASS_NAME. */
  readonly classes: readonly string[];
  /** The class ranked by its goals' rank, which the WIP rule protects. */
  readonly roadmapClass: string;
  /** The class ranked by severity first. */
  readonly maintenanceClass: string;
  /** The class a task with none counts as; it ranks last. */
  readonly defaultClass: string;
  /** The key results (goals with a parent) a team may hold with a target of today or later. */
  readonly maxActiveKeyResults: number;
  /**
   * The shippable slices (a goal's fewest tasks that ship something working, proven live) the leads keep open across
   * the tree at once (owner order T2201): spreading every task in parallel ships nothing for a long time.
   */
  readonly maxOpenSlices: number;
  readonly score: FocusScoreConfig;
  readonly expedite: FocusExpediteConfig;
  readonly wip: FocusWipConfig;
  /** The percent of the whole week each class is planned to take, by class; the shares sum to 100. */
  readonly allocation: Readonly<Record<string, number>>;
  /** How long a Roadmap task may wait on a leader's decision or approval before it is flagged. */
  readonly leaderWaitMinutes: number;
  /** The days without an event after which an Improvements task is parked out of list, plan, check and start. */
  readonly parkAfterDays: number;
  /** The percent of the week's spend planned work should take. */
  readonly plannedTargetPct: number;
  /** The UTC weekday whose meeting agenda carries the Improvements decisions, as one batch; no other day's shows them. */
  readonly improvementsDay: Weekday;
}

/** Claude Code's effort levels, lowest first: what `claude --effort` and `/effort` take. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === value);
}

/**
 * The Claude Code model and effort a session starts on (`claude --model`, `claude --effort`), and the folder it
 * starts in; an unset key leaves Claude Code's own choice. The lead takes `DEFAULT_LEAD_LAUNCH` for each model
 * and effort key it leaves unset.
 */
export interface LaunchConfig {
  /** A Claude Code model alias, such as `best` or `opus`, or a full model id starting `claude-`. */
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** The session's project folder, an absolute path; unset, the team's (`TeamLink.project`). */
  readonly project?: string;
}

/** Character budgets for the text Claude Code puts in every call's context; `doctor` flags a file over its budget. */
export interface ContextFilesConfig {
  /** The CLAUDE.md files a session loads: the user's, and the project folder's and each parent's. */
  readonly maxClaudeMdChars: number;
  /** The project's memory index (`MEMORY.md`). */
  readonly maxMemoryIndexChars: number;
  /** The skill listing: one `name: description` line per skill. */
  readonly maxSkillListingChars: number;
  /** The lists the newest session's context holds: skills, deferred tools, agent types and MCP server instructions. */
  readonly maxSessionListsChars: number;
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
  /**
   * The team's project folder, an absolute path: where its CLAUDE.md and rule files sit, and where its sessions
   * work unless their own `launch` entry names another. Unset, the folder holding the team's pointer file.
   */
  readonly project?: string;
}

export interface KitConfig {
  readonly configVersion: number;
  /** Unset in a config written before team trees: the team is then the root of its own tree. */
  readonly team?: TeamLink;
  /**
   * The IANA time zone, such as `Asia/Jerusalem`, the kit shows people every time in (zone-marked: `09:00 IDT`)
   * and reads the times they type in; unset, the machine's own. Stored times stay UTC.
   */
  readonly timeZone?: string;
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
  /**
   * Each sub-lead's members, by id (T781, `promote`): a sub-lead leads the sessions it lists, and the lead every
   * session no sub-lead lists; a sub-lead may list sub-leads, at any depth. Read through `LeadTree`.
   */
  readonly leads: Readonly<Record<string, readonly string[]>>;
  /** Decision areas only the human owner can approve; silence never counts as consent for them. */
  readonly ownerGates: readonly string[];
  /** The local rules kept although they conflict with a core rule, each with the side that wins (`rules keep`). */
  readonly ruleConflicts: readonly RuleConflict[];
  readonly messages: MessagesConfig;
  readonly register: RegisterConfig;
  readonly skills: SkillsConfig;
  readonly contextFiles: ContextFilesConfig;
  readonly lock: LockConfig;
  readonly exec: ExecConfig;
  readonly pushGuard: PushGuardConfig;
  readonly packageGuard: PackageGuardConfig;
  readonly commitGuard: CommitGuardConfig;
  readonly prompts: PromptsConfig;
  /** Refuses a call that would print a secret file, the environment or a secret variable, or whose line holds a secret as text (hook-secret-guard). */
  readonly secretGuard: SecretGuardConfig;
  readonly commits: CommitsConfig;
  readonly delivery: DeliveryConfig;
  readonly budget: BudgetConfig;
  readonly leadBoundary: LeadBoundaryConfig;
  readonly loops: LoopsConfig;
  readonly wake: WakeConfig;
  readonly tests: TestsConfig;
  readonly github: GithubConfig;
  readonly alerts: AlertsConfig;
  readonly decisions: DecisionsConfig;
  /**
   * A colored circle before each tab's title for what its session is doing (hook-tab-status.ts). It also
   * needs Claude Code's own title off (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`), else Claude Code writes over it.
   */
  readonly tabStatus: { readonly enabled: boolean };
  /**
   * Refuses Claude Code's question picker (AskUserQuestion), which would stop the session until the person answers,
   * to every session and helper, and to the lead outside the owner's daily meeting; the reason says to decide it if it
   * is the session's own, else record it on its task and go on (hook-picker-guard.ts). Off by default.
   */
  readonly pickerGuard: { readonly enabled: boolean };
  readonly turnLog: TurnLogConfig;
  /** Lets a shell line that only reads run without a permission prompt; off by default. */
  readonly readonlyShell: ReadonlyShellConfig;
  /** Which local allow rules stay when `permissions trim` removes the rest. */
  readonly permissions: PermissionsConfig;
  readonly refresh: RefreshConfig;
  readonly hiring: HiringConfig;
  readonly burst: BurstConfig;
  /** How `teamrig open` starts a session in a new terminal tab. */
  readonly open: OpenConfig;
  /** What `teamrig statusline` shows. */
  readonly statusLine: StatusLineConfig;
  /** Goal-first ranking: work classes, the WSJF score, the WIP rule and the class allocation (T2076). */
  readonly focus: FocusConfig;
  /** Each session's Claude Code model and effort, by id; the lead's unset keys take `DEFAULT_LEAD_LAUNCH`. */
  readonly launch: Readonly<Record<string, LaunchConfig>>;
  readonly paths: PathsConfig;
}
