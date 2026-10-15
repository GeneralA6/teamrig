/** Defaults for every key except the roster (`sessions`, `roles.lead`), which each team supplies. */
export const DEFAULT_OWNER_GATES = [
    'destructive data operations',
    'product and design decisions',
    'permissions',
    'budget',
    'resource changes',
];
export const DEFAULT_MESSAGES = { maxLines: 10, coldAfterMinutes: 60 };
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
/** About a screenful: two or three failing tests with their errors and first stack frames. */
export const DEFAULT_TESTS = { maxFailureChars: 4000 };
/** Off until a team lists a repository; two weeks of closed issues covers a sync missed over a holiday. */
export const DEFAULT_GITHUB = { repos: [], owners: {}, sessions: {}, closedDays: 14 };
/**
 * Claude Code compacts a 200k window at about 167k, so 120k refreshes before that; every 3 tasks catches a
 * session that grows slowly, from 80k up. Measured over 8 days of 12 sessions: about 9 refreshes a day in all.
 */
export const DEFAULT_REFRESH = { enabled: true, contextTokens: 120_000, everyTasks: 3, everyTasksMinTokens: 80_000, tabTitle: true };
export const DEFAULT_OPEN = { terminal: 'auto' };
/**
 * The lead's model and effort for each key its `launch` entry leaves unset: Opus (Claude Code's `opus`
 * alias, its newest Opus) at xhigh effort, since the lead plans, splits and judges the whole team's work.
 * Not `best`: in a lead A/B, Fable at xhigh judged no better than Opus and cost 2.4 times as much. A team
 * sets `launch.<lead id>.model` to `best` or a full model id to change it. The other sessions default to
 * Claude Code's own.
 */
export const DEFAULT_LEAD_LAUNCH = { model: 'opus', effort: 'xhigh' };
