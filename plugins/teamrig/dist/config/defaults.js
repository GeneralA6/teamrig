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
    maxTitle: 140,
    maxText: 300,
    secretPatterns: [],
    requireDescription: true,
    requireEvidenceOnDone: true,
    requireSkillOnDone: true,
    requireNoteOn: ['waiting', 'verifying', 'done', 'dropped'],
    autoArchive: true,
    requireProofOnVerifying: true,
    verifyGate: 'refuse',
    maxVerifying: 5,
    check: { staleAfterHours: 72, notPickedUpAfterHours: 24, prioritySkipAfterHours: 24, weekLengthDays: 7, stopgapFiles: ['CLAUDE.md', '.claude/rules'] },
};
export const DEFAULT_SKILLS = {
    sharedPrefix: 'team',
    maxDescriptionWords: 30,
    maxPerArea: 8,
    maxVerifiedAgeDays: 30,
    forbidFrontmatter: ['allowed-tools'],
};
/** Measured on a working team (10-15): 23k of CLAUDE.md, 15k of memory index and 4.6k of skill listing were re-read every call. */
export const DEFAULT_CONTEXT_FILES = { maxClaudeMdChars: 12_000, maxMemoryIndexChars: 6_000, maxSkillListingChars: 4_000 };
export const DEFAULT_LOCK = { ttlMs: 30_000, pollMs: 50, waitMs: 20_000 };
export const DEFAULT_PUSH_GUARD = { protectedBranches: ['main', 'master'], pushToProtected: 'ask' };
/** Tests: a test folder, `*.test.*` and `*.spec.*` files, and pytest's `test_*.py`. `warn` only adds to a push the guard already asks about. */
export const DEFAULT_COMMITS = {
    maxLines: 400,
    maxFiles: 15,
    largeCommitTrailer: 'Large-commit',
    testPatterns: ['(^|/)(tests?|__tests__|spec)/', '\\.(test|spec)\\.[^/]+$', '(^|/)test_[^/]+\\.py$'],
    gate: 'warn',
};
/**
 * Neutral on purpose: off, no allowance cap, every session an equal share, and past the line only
 * the warning lines, so a team that turns it on is measured and shown before anything acts.
 * The optional keys (weekly limit, reset, daily %, cap, quiet hours, snapshot folder) stay unset.
 */
export const DEFAULT_BUDGET = {
    enabled: false,
    subagentWeight: 1,
    targetPct: 99.5,
    reservePct: 0.5,
    paceEndHoursBeforeReset: 1,
    sessions: {},
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
export const DEFAULT_LOOPS = { chainNudgeAt: 6 };
export const DEFAULT_LEAD_BOUNDARY = { enabled: true, ownPaths: [], searchNudgeAt: 3 };
/**
 * On, for p1 only. In one team of 12 sessions, others handed a session 3 to 6 p1 tasks a day once its register
 * settled, so even all of them waking a session cold (about 210k W each) costs about 1.3M W a day, under 0.2% of
 * a 900M W week. Two minutes gathers the tasks handed in one sitting into one wake, and 15 minutes between wakes
 * caps a session at 4 an hour however much is handed.
 */
export const DEFAULT_WAKE = { enabled: true, priority: 1, batchSeconds: 120, minGapMinutes: 15 };
/** About a screenful: two or three failing tests with their errors and first stack frames. */
export const DEFAULT_TESTS = { maxFailureChars: 4000 };
/**
 * Off until a team lists a repository; two weeks of closed issues covers a sync missed over a holiday. Every 15
 * minutes a new issue reaches its session within a working block, at two gh calls per repository each time.
 */
export const DEFAULT_GITHUB = { repos: [], owners: {}, sessions: {}, closedDays: 14, everyMinutes: 15 };
/**
 * Claude Code compacts a 200k window at about 167k, so 120k refreshes before that; every 3 tasks catches a
 * session that grows slowly, from 80k up. Measured over 8 days of 12 sessions: about 9 refreshes a day in all.
 * The user types /clear for the fresh start (`autoRestart` off): an automatic /clear wiped the screen while the
 * user was still reading the last reply, still had its question to answer, or was away.
 */
export const DEFAULT_REFRESH = {
    enabled: true,
    contextTokens: 120_000,
    everyTasks: 3,
    everyTasksMinTokens: 80_000,
    tabTitle: true,
    autoRestart: false,
    restartDelaySeconds: 15,
    endCommand: [],
};
export const DEFAULT_OPEN = { terminal: 'auto' };
/**
 * A hire spends the week's budget, so it waits for the owner's yes: at most two hires at 1% of the week a day
 * each, 3% in all, reviewed after a week and due to retire after 4 hours with no open task. A rehire resumes its
 * last Claude Code session only when it holds at most 250k tokens of context and was idle at most a week.
 */
/**
 * A burst spends more of the week, so the owner approves each one. A surplus burst may start from 48 hours before
 * the reset once at least 5% of the week is projected unused; each burst session runs at most 3 helpers at once,
 * and one burst hires at most 2 sessions, as many as `hiring.maxSessions` allows by default.
 */
export const DEFAULT_BURST = { policy: 'owner', surplusHours: 48, minSparePct: 5, maxHelpers: 3, maxHires: 2 };
export const DEFAULT_HIRING = { policy: 'owner', maxSessions: 2, dailyPct: 1, maxDailyPct: 3, idleHours: 4, reviewDays: 7, resumeMaxTokens: 250_000, resumeMaxIdleDays: 7 };
/**
 * The lead's model and effort for each key its `launch` entry leaves unset: Opus (Claude Code's `opus`
 * alias, its newest Opus) at xhigh effort, since the lead plans, splits and judges the whole team's work.
 * Not `best`: in a lead A/B, Fable at xhigh judged no better than Opus and cost 2.4 times as much. A team
 * sets `launch.<lead id>.model` to `best` or a full model id to change it. The other sessions default to
 * Claude Code's own.
 */
export const DEFAULT_LEAD_LAUNCH = { model: 'opus', effort: 'xhigh' };
