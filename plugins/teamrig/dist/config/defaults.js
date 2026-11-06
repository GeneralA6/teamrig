/** Defaults for every key except the roster (`sessions`, `roles.lead`), which each team supplies. */
export const DEFAULT_OWNER_GATES = [
    'destructive data operations',
    'product and design decisions',
    'permissions',
    'budget',
    'resource changes',
];
export const DEFAULT_MESSAGES = { maxLines: 10, coldAfterMinutes: 60 };
/**
 * The most characters a task's description holds, beside `maxTitle` and `maxText` (the note, ref, evidence and
 * proof): a fixed limit, not a config key, so a GitHub issue body cut to it reads the same on every team.
 */
export const MAX_DESCRIPTION = 2_000;
export const DEFAULT_REGISTER = {
    ownerSource: 'owner',
    priorities: [
        { id: 1, name: 'keep the lights on' },
        { id: 2, name: 'correctness' },
        { id: 3, name: 'scale' },
        { id: 4, name: "this week's owner decisions" },
        { id: 5, name: 'if budget allows' },
    ],
    goals: 'free',
    maxTitle: 140,
    maxText: 300,
    secretPatterns: [],
    requireDescription: true,
    requireEvidenceOnDone: true,
    requireSkillOnDone: true,
    requireNoteOn: ['waiting', 'verifying', 'done', 'dropped'],
    requireFollowupsOn: ['verifying', 'done'],
    autoArchive: true,
    requireProofOnVerifying: true,
    requireDecisionCard: true,
    verifyGate: 'refuse',
    maxVerifying: 5,
    maxReparks: 2,
    /**
     * maxSelfMadePerDay, measured on a working team (10-15 to 10-18): on a day a session added tasks for itself, it added
     * 3 at the median and 9 at the 90th percentile; the two days past 10 (36 and 19) were the run that raised the question.
     * goalProgressDays: a working day that moves no planned task is the drift to catch the next morning.
     * overSizeMultiple: the old register flagged a task whose cost passed twice its estimate (T327).
     */
    check: {
        staleAfterHours: 72,
        notPickedUpAfterHours: 24,
        prioritySkipAfterHours: 24,
        maxSelfMadePerDay: 10,
        goalProgressDays: 1,
        overSizeMultiple: 2,
        weekLengthDays: 7,
        stopgapFiles: ['CLAUDE.md', '.claude/rules'],
    },
    review: {
        mode: 'refuse',
        requireOn: ['verifying', 'done'],
        criticalOwners: [],
        hintPattern: String.raw `\b(fix|bug|broken?|regress\w*|incident|fail\w*|crash\w*|leak\w*|wrong|missed)\b`,
    },
};
export const DEFAULT_SKILLS = {
    sharedPrefix: 'team',
    maxDescriptionWords: 30,
    maxPerArea: 8,
    maxVerifiedAgeDays: 30,
    forbidFrontmatter: ['allowed-tools'],
    otherAreas: 'name-only',
};
/**
 * Measured on a working team (10-15): 23k of CLAUDE.md, 15k of memory index and 4.6k of skill listing were re-read every call.
 * Its session lists measured 38k on 10-21; a bare Claude Code setup holds about 10k.
 */
export const DEFAULT_CONTEXT_FILES = {
    maxClaudeMdChars: 12_000,
    maxMemoryIndexChars: 6_000,
    maxSkillListingChars: 4_000,
    maxSessionListsChars: 16_000,
};
export const DEFAULT_LOCK = { ttlMs: 300_000, pollMs: 50, waitMs: 20_000 };
/** No exec PATH: a privileged command names its program by absolute path until the team lists its tool folders. */
export const DEFAULT_EXEC = { path: [] };
export const DEFAULT_PUSH_GUARD = { protectedBranches: ['main', 'master'], pushToProtected: 'ask', reviewPaths: [] };
/**
 * Refused by default: a helper's `npx eslint` once fetched and ran an unvetted package (T450, 10-16), and an install
 * lands a version as unvetted unless its exact version is old enough and has no advisory (T681). Two weeks is the
 * window in which a compromised release is usually found and pulled.
 */
export const DEFAULT_PACKAGE_GUARD = { adHocRunners: 'deny', installs: 'deny', cooldownDays: 14 };
/** Refused by default: the hooks are the repository's own checks, and a session that skips them ships what they would catch. */
export const DEFAULT_COMMIT_GUARD = { skipHooks: 'deny' };
export const DEFAULT_PROMPTS = { hookAsks: 'ask', routeAllow: 'on' };
/** Refused by default: a secret printed into a session lands in its transcript and every later prompt (T660, 10-19). */
export const DEFAULT_SECRET_GUARD = { secretReads: 'deny', writes: 'deny', paths: [], envNames: [], commands: [], redact: true };
/** Off, and trusting no prefix, until a team opts in. */
export const DEFAULT_READONLY_SHELL = { enabled: false, allowPrefixes: [] };
/**
 * Read-only commands outside Claude Code's own read-only set whose arguments can neither run a program nor write
 * (the general part of security's keep-list, T1037 10-23), kept in both shells; PowerShell's own cmdlets in
 * PowerShell only. A team's own list replaces this one, so one that adds its tools' read-only commands repeats these.
 */
const KEPT_SHELL_COMMANDS = [
    'kubectl get',
    'kubectl describe',
    'kubectl logs',
    'kubectl top',
    'kubectl rollout status',
    'kubectl version',
    'kubectl config current-context',
    'npm ls',
    'npm view',
    'gh pr view',
    'gh pr list',
    'gh pr checks',
    'gh run list',
    'gh run view',
    'tasklist',
    'netstat',
    'sleep',
];
const KEPT_CMDLETS = ['Test-Path', 'Get-Date', 'Get-Process'];
export const DEFAULT_PERMISSIONS = {
    keepAllow: [
        ...KEPT_SHELL_COMMANDS.flatMap((command) => [`Bash(${command} *)`, `PowerShell(${command} *)`]),
        ...KEPT_CMDLETS.map((cmdlet) => `PowerShell(${cmdlet} *)`),
        'WebSearch',
    ],
};
/**
 * Tests: a test folder, `*.test.*` and `*.spec.*` files, and pytest's `test_*.py`. Source: code files by extension, so
 * docs, config and data are not. `warn` only adds to a push the guard already asks about.
 */
export const DEFAULT_COMMITS = {
    maxLines: 400,
    maxFiles: 15,
    largeCommitTrailer: 'Large-commit',
    testPatterns: ['(^|/)(tests?|__tests__|spec)/', '\\.(test|spec)\\.[^/]+$', '(^|/)test_[^/]+\\.py$'],
    sourcePatterns: ['\\.([cm]?[jt]sx?|py|go|rs|java|kt|cs|c|cc|cpp|h|hpp|rb|swift|vue|svelte|sh|ps1)$'],
    gate: 'warn',
};
/**
 * Neutral on purpose: off, no allowance cap, every session an equal share, and past the line only
 * the warning lines, so a team that turns it on is measured and shown before anything acts.
 * The optional keys (weekly limit, extra usage's W per dollar, reset, quiet hours, snapshot folder) stay unset.
 */
export const DEFAULT_BUDGET = {
    enabled: false,
    subagentWeight: 1,
    targetPct: 99.5,
    reservePct: 0.5,
    paceEndHoursBeforeReset: 1,
    sessions: {},
    pauseByPriority: false,
    warnAtPct: [80, 100],
    paceTolerancePct: 0.5,
    overAction: 'warn',
    escalate: 'session-and-fleet',
    lift: { maxStopPct: 99.3, reserveStopPct: 99.9 },
    maxBytesPerHook: 4_000_000,
};
/** The share of a session the budget's `sessions` map leaves out, or lists without one. */
export const DEFAULT_SESSION_SHARE = 1;
export const DEFAULT_ALERTS = { persistentFailureHours: 24 };
/** The remote a repository's merge command merges into when `merge.remote` is unset. */
export const DEFAULT_MERGE_REMOTE = 'origin';
/** Where `teamrig worktree add` makes a repository's worktrees when `worktreeFolder` is unset: in its main checkout, where Claude Code makes its own. */
export const DEFAULT_WORKTREE_FOLDER = '.claude/worktrees';
/** A repository's docs folder when `docsFolder` is unset: `docs` at its root, where most projects keep theirs. */
export const DEFAULT_DOCS_FOLDER = 'docs';
export const DEFAULT_DECISIONS = { batchTimesUtc: [], batchAt: 5, askWith: 'text' };
export const DEFAULT_LOOPS = { chainNudgeAt: 3 };
export const DEFAULT_LEAD_BOUNDARY = { enabled: true, ownPaths: [], searchNudgeAt: 3 };
/** On, for a day: what a tab showed stays readable through a night of refreshes. */
export const DEFAULT_TURN_LOG = { enabled: true, keepHours: 24 };
/**
 * On, for p0 and p1 only. In one team of 12 sessions, others handed a session 3 to 6 p1 tasks a day once its register
 * settled, so even all of them waking a session cold (about 210k W each) costs about 1.3M W a day, under 0.2% of
 * a 900M W week. Two minutes gathers the tasks handed in one sitting into one wake, and 15 minutes between wakes
 * caps a session at 4 an hour however much is handed. No day start: waking every session each morning costs up to
 * 210k W each, so a team opts in with `wake.dayStartUtc`.
 */
export const DEFAULT_WAKE = { enabled: true, priority: 1, batchSeconds: 120, minGapMinutes: 15 };
/** About a screenful: two or three failing tests with their errors and first stack frames. */
export const DEFAULT_TESTS = { maxFailureChars: 4000 };
/**
 * Off until a team lists a repository; two weeks of closed issues covers a sync missed over a holiday. Every 15
 * minutes a new issue reaches its session within a working block, at two gh calls per repository each time (one more
 * per further hundred open, or recently changed closed, issues). An outsider's issue waits for the `teamrig` label,
 * named after the tool so it does not clash with a repository's own triage labels.
 */
export const DEFAULT_GITHUB = { repos: [], owners: {}, sessions: {}, closedDays: 14, everyMinutes: 15, acceptLabel: 'teamrig' };
/**
 * Claude Code compacts a 200k window at about 167k, so 120k refreshes before that; every 3 tasks catches a
 * session that grows slowly, from 80k up. Measured over 8 days of 12 sessions: about 9 refreshes a day in all.
 * The user types /clear for the fresh start (`autoRestart` off): an automatic /clear wiped the screen while the
 * user was still reading the last reply, still had its question to answer, or was away. While a handover is
 * pending, the compaction at 167k waits up to 185k: 18k of room to finish the step and write it, and 15k under the
 * window for a large tool result. A handover over 20 KB is refused: on 10-24 most were 4 to 8 KB, and one appended
 * to section by section (29 of them) reached 88 KB, which its every fresh start read whole.
 */
export const DEFAULT_REFRESH = {
    enabled: true,
    contextTokens: 120_000,
    everyTasks: 3,
    everyTasksMinTokens: 80_000,
    tabTitle: true,
    autoRestart: false,
    restartDelaySeconds: 15,
    holdAfterActivityMinutes: 30,
    countdownSeconds: 20,
    compactCeilingTokens: 185_000,
    handoverMaxBytes: 20_000,
    endCommand: [],
};
/**
 * A session is counted at 1.2 GB (on 10-19, 18 sessions held 21.9 GB with their helpers and MCP servers), and the
 * commit charge stays at most 92% with it (it reached 100% that morning, and Claude Code then killed running steps).
 * A session quiet an hour may be closed: the owner's pick on 10-19.
 */
export const DEFAULT_HEADROOM = { sessionMb: 1200, commitMaxPct: 92, closeIdleMinutes: 60 };
/**
 * The idle pass closes and reopens sessions unless the team sets it to dry-run or off, so an idle tab spends no tokens
 * on any team (owner order, T1409); it keeps open only the sessions its roles name.
 */
export const DEFAULT_IDLE = { mode: 'on', keepOpen: [] };
export const DEFAULT_OPEN = { terminal: 'auto', teamWindow: false, headroom: DEFAULT_HEADROOM, idle: DEFAULT_IDLE };
/** The status line shows the session's folder, its branch and the team's pace line, unless the team turns them off. */
export const DEFAULT_STATUS_LINE = { folder: true, branch: true, pace: true };
/**
 * Goal-first ranking (owner order 11-06, T2076): roadmap work first, maintenance by severity, team tooling last. A
 * ranked goal is worth 20 down to 4, so the top objective beats any Maintenance task short of a critical bug (10 + 4 +
 * 10), and an owner's p1 adds 12 as a capped override instead of ranking alone. At most 3 tasks in progress, an
 * Improvements start refused while a Roadmap task can move, and 60/25/15 of the week's spend planned by class.
 */
export const DEFAULT_FOCUS = {
    classes: ['Roadmap', 'Maintenance', 'Improvements'],
    roadmapClass: 'Roadmap',
    maintenanceClass: 'Maintenance',
    defaultClass: 'Improvements',
    maxActiveKeyResults: 5,
    score: {
        rankValues: [20, 16, 12, 8, 4],
        roadmapUnranked: 3,
        maintenanceValue: 10,
        maintenanceBug: 4,
        maintenanceCritical: 10,
        improvementsValue: 1,
        overdueValue: 8,
        dueSoonValue: 4,
        dueSoonDays: 3,
        unblocksShare: 0.5,
        ownerOrderValues: [12, 6, 0, 0, 0],
        defaultSizePct: 0.3,
        minSizePct: 0.05,
    },
    expedite: { critical: true, ownerP1: true },
    wip: { mode: 'refuse', maxInProgress: 3 },
    allocation: { Roadmap: 60, Maintenance: 25, Improvements: 15 },
    leaderWaitMinutes: 60,
    parkAfterDays: 14,
    plannedTargetPct: 70,
};
/**
 * A host lock outlives the longest queued step it may hold by this many minutes, so the step is killed
 * before its lock runs out and no second step starts beside it.
 */
export const QUEUE_TTL_MARGIN_MINUTES = 10;
/**
 * A host lock lasts 150 minutes and a queued step at most 45 of them, a small step at most 10; a step waits up to an hour
 * for the lock, and its memory is sampled every 15 seconds while it runs.
 */
export const DEFAULT_QUEUE = { lockTtlMinutes: 150, maxRunMinutes: 45, smallMaxRunMinutes: 10, waitMinutes: 60, memorySampleSeconds: 15, memoryFloorMb: 4096, smallReserveMb: 2048 };
/** A waiting delivery step looks again every 30 seconds; a deploy step waits up to an hour for freezes and the host lock. */
export const DEFAULT_DELIVERY_WAIT = { pollSeconds: 30, maxMinutes: 60 };
/** A deploy's check answers within 20 seconds, else the deploy waits. */
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 20;
/** A deploy freeze lasts at most two hours. */
export const DEFAULT_FREEZES = { maxMinutes: 120 };
/** A target measures cleanly 30 minutes after a deploy; a deploy the ledger knows only by its ledger.md line ran for 20 minutes; a stable period under 15 minutes is left out. */
export const DEFAULT_STABLE_PERIODS = { settleMinutes: 30, targetSettleMinutes: {}, assumedDeployMinutes: 20, minMinutes: 15 };
/**
 * A burst spends more of the week, so the owner approves each one. A surplus burst may start from 48 hours before
 * the reset once at least 5% of the week is projected unused; each burst session runs at most 3 helpers at once,
 * and one burst hires at most 2 sessions.
 */
export const DEFAULT_BURST = { policy: 'owner', surplusHours: 48, minSparePct: 5, maxHelpers: 3, maxHires: 2 };
/**
 * An area's pace is the tasks it finished over the last week, counted once it finished at least 3; the dated
 * tasks of the top two priorities are the work it must finish in time.
 */
export const DEFAULT_SCALE_OUT = { windowDays: 7, minDone: 3, topPriorities: 2 };
/**
 * A hire spends the week's budget, so it waits for the owner's yes, each spending its part of the team's daily
 * budget, and reviewed after a week. A rehire resumes its last Claude Code session only when it holds at most 250k
 * tokens of context and was idle at most a week.
 */
export const DEFAULT_HIRING = {
    policy: 'owner',
    reviewDays: 7,
    resumeMaxTokens: 250_000,
    resumeMaxIdleDays: 7,
    scaleOut: DEFAULT_SCALE_OUT,
};
/**
 * The lead's model and effort for each key its `launch` entry leaves unset: Opus (Claude Code's `opus`
 * alias, its newest Opus) at xhigh effort, since the lead plans, splits and judges the whole team's work.
 * Not `best`: in a lead A/B, Fable at xhigh judged no better than Opus and cost 2.4 times as much. A team
 * sets `launch.<lead id>.model` to `best` or a full model id to change it. The other sessions default to
 * Claude Code's own.
 */
export const DEFAULT_LEAD_LAUNCH = { model: 'opus', effort: 'xhigh' };
