import type {
  AlertsConfig,
  BudgetConfig,
  CommitsConfig,
  LaunchConfig,
  LockConfig,
  OpenConfig,
  PushGuardConfig,
  RefreshConfig,
  RegisterConfig,
  SkillsConfig,
} from './types.ts';

/** Defaults for every key except the roster (`sessions`, `roles.lead`), which each team supplies. */
export const DEFAULT_OWNER_GATES: readonly string[] = [
  'destructive data operations',
  'product and design decisions',
  'permissions',
  'budget',
  'resource changes',
];

export const DEFAULT_MESSAGES = { maxLines: 10 } as const;

export const DEFAULT_REGISTER: RegisterConfig = {
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
  requireNoteOn: ['blocked', 'done', 'dropped'],
  check: { staleAfterHours: 72, notPickedUpAfterHours: 24, prioritySkipAfterHours: 24, weekLengthDays: 7 },
};

export const DEFAULT_SKILLS: SkillsConfig = {
  sharedPrefix: 'team',
  maxDescriptionWords: 30,
  maxPerArea: 8,
  maxVerifiedAgeDays: 30,
  forbidFrontmatter: ['allowed-tools'],
};

export const DEFAULT_LOCK: LockConfig = { ttlMs: 30_000, pollMs: 50, waitMs: 20_000 };

export const DEFAULT_PUSH_GUARD: PushGuardConfig = { protectedBranches: ['main', 'master'] };

/** Tests: a test folder, `*.test.*` and `*.spec.*` files, and pytest's `test_*.py`. `warn` only adds to a push the guard already asks about. */
export const DEFAULT_COMMITS: CommitsConfig = {
  maxLines: 400,
  maxFiles: 15,
  largeCommitTrailer: 'Large-commit',
  testPatterns: ['(^|/)(tests?|__tests__|spec)/', '\\.(test|spec)\\.[^/]+$', '(^|/)test_[^/]+\\.py$'],
  gate: 'warn',
};

export const DEFAULT_BUDGET: BudgetConfig = { enabled: false, targetPct: 99.5, reservePct: 0.5 };

export const DEFAULT_ALERTS: AlertsConfig = { persistentFailureHours: 24 };

/** 250k suits a 1M-token window; on a 200k window Claude Code compacts first, so a team there sets about 150k. */
export const DEFAULT_REFRESH: RefreshConfig = { enabled: true, contextTokens: 250_000, tabTitle: true };

export const DEFAULT_OPEN: OpenConfig = { terminal: 'auto' };

/**
 * The lead's model and effort for each key its `launch` entry leaves unset: Opus (Claude Code's `opus`
 * alias, its newest Opus) at xhigh effort, since the lead plans, splits and judges the whole team's work.
 * Not `best`: in a lead A/B, Fable at xhigh judged no better than Opus and cost 2.4 times as much. A team
 * sets `launch.<lead id>.model` to `best` or a full model id to change it. The other sessions default to
 * Claude Code's own.
 */
export const DEFAULT_LEAD_LAUNCH: Required<LaunchConfig> = { model: 'opus', effort: 'xhigh' };
