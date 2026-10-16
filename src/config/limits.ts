/**
 * Bounds on config values: the parser enforces them and the JSON schema states them. For the values
 * the core rule pack prints, the pack's budget test renders their extremes, so the always-loaded
 * rules stay inside their character budget whatever a team configures. `itemMin`/`itemMax` bound
 * each item of a number list.
 */
export const CONFIG_LIMITS = {
  maxLines: { min: 3, max: 50 },
  coldAfterMinutes: { min: 0, max: 1440 },
  maxDescriptionWords: { min: 5, max: 200 },
  maxPerArea: { min: 1, max: 100 },
  maxVerifiedAgeDays: { min: 1, max: 365 },
  claudeMdChars: { min: 500, max: 500_000 },
  memoryIndexChars: { min: 500, max: 500_000 },
  skillListingChars: { min: 500, max: 500_000 },
  ownerGates: { maxItems: 8, maxLength: 60 },
  ruleConflicts: { maxItems: 40 },
  protectedBranches: { maxItems: 8, maxLength: 64 },
  commitMaxLines: { min: 50, max: 5000 },
  commitMaxFiles: { min: 2, max: 500 },
  testPatterns: { maxItems: 8, maxLength: 100 },
  forbidFrontmatter: { maxItems: 8, maxLength: 32 },
  requireNoteOn: { maxItems: 5 },
  maxVerifying: { min: 0, max: 100 },
  stopgapFiles: { maxItems: 20, maxLength: 260 },
  persistentFailureHours: { min: 1, max: 720 },
  chainNudgeAt: { min: 0, max: 50 },
  leadOwnPaths: { maxItems: 16, maxLength: 256 },
  searchNudgeAt: { min: 0, max: 50 },
  wakePriority: { min: 1, max: 99 },
  wakeBatchSeconds: { min: 0, max: 3600 },
  wakeMinGapMinutes: { min: 0, max: 1440 },
  maxFailureChars: { min: 500, max: 50_000 },
  githubRepos: { maxItems: 20, maxLength: 140 },
  closedDays: { min: 1, max: 365 },
  githubEveryMinutes: { min: 0, max: 1440 },
  budgetTargetPct: { min: 1, max: 100 },
  budgetReservePct: { min: 0, max: 50 },
  weeklyLimitW: { min: 1_000_000, max: 1_000_000_000_000 },
  subagentWeight: { min: 0.1, max: 10 },
  paceEndHoursBeforeReset: { min: 0, max: 48 },
  dailyPct: { min: 0.1, max: 100 },
  maxDailyPct: { min: 0.1, max: 100 },
  sessionShare: { min: 0, max: 100 },
  sessionDailyPct: { min: 0.1, max: 100 },
  warnAtPct: { maxItems: 8, itemMin: 1, itemMax: 1_000 },
  paceTolerancePct: { min: 0, max: 10 },
  liftMaxStopPct: { min: 1, max: 100 },
  liftReserveStopPct: { min: 1, max: 100 },
  maxBytesPerHook: { min: 100_000, max: 100_000_000 },
  hiringMaxSessions: { min: 1, max: 20 },
  hiringDailyPct: { min: 0.1, max: 100 },
  hiringMaxDailyPct: { min: 0.1, max: 100 },
  hiringIdleHours: { min: 1, max: 168 },
  hiringReviewDays: { min: 1, max: 90 },
  hiringResumeMaxTokens: { min: 10_000, max: 1_000_000 },
  hiringResumeMaxIdleDays: { min: 1, max: 90 },
} as const;

/**
 * Bounds on the fields of one recorded rule conflict (`ruleConflicts`). A line longer than `textMaxLength` is
 * recorded by its start, which is enough to find it again; the pack quotes less still.
 */
export const RULE_CONFLICT_LIMITS = {
  fileMaxLength: 512,
  textMaxLength: 300,
  reasonMaxLength: 200,
} as const;

/**
 * Bounds on a tree of teams, which `team create` and `doctor` enforce. A lead's `--tree` roll-up reads
 * every register below it, so these keep one at most 1 + 8 + 64 registers, and an owner decision
 * passes at most two leads before it reaches the root lead, the one session the user talks to.
 */
export const TREE_LIMITS = {
  /** Levels in one tree, the root team counted as level 1. */
  levels: 3,
  /** Child teams under one team. */
  childTeams: 8,
} as const;
