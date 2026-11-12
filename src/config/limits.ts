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
  sessionListsChars: { min: 500, max: 500_000 },
  ownerGates: { maxItems: 8, maxLength: 60 },
  ruleConflicts: { maxItems: 40 },
  protectedBranches: { maxItems: 8, maxLength: 64 },
  reviewPaths: { maxItems: 128 },
  commitMaxLines: { min: 50, max: 5000 },
  commitMaxFiles: { min: 2, max: 500 },
  testPatterns: { maxItems: 8, maxLength: 100 },
  sourcePatterns: { maxItems: 8, maxLength: 100 },
  forbidFrontmatter: { maxItems: 8, maxLength: 32 },
  requireNoteOn: { maxItems: 5 },
  requireFollowupsOn: { maxItems: 3 },
  reviewRequireOn: { maxItems: 2 },
  criticalOwners: { maxItems: 32 },
  dedicatedOwners: { maxItems: 32 },
  maxVerifying: { min: 0, max: 100 },
  maxReparks: { min: 0, max: 20 },
  maxSelfMadePerDay: { min: 0, max: 200 },
  /** Its span (these days and today) stays inside compaction's RETAIN_DAYS, so every task moved in it is still read. */
  goalProgressDays: { min: 0, max: 7 },
  overSizeMultiple: { min: 0, max: 10 },
  stopgapFiles: { maxItems: 20, maxLength: 260 },
  persistentFailureHours: { min: 1, max: 720 },
  /** At least one slice open, so work can ship; past 5 a session spreads its work as thin as no cap would (T2215). */
  slicesPerSession: { min: 1, max: 5 },
  /** At least one, or no slice needing the owner could open; past 20 the owner's queue outgrows a meeting (T2215). */
  maxOwnerDecisions: { min: 1, max: 20 },
  decisionBatchTimes: { maxItems: 8 },
  decisionBatchAt: { min: 0, max: 50 },
  chainNudgeAt: { min: 0, max: 50 },
  leadOwnPaths: { maxItems: 16, maxLength: 256 },
  readonlyShellPrefixes: { maxItems: 16, maxLength: 120 },
  keepAllow: { maxItems: 64, maxLength: 120 },
  secretPaths: { maxItems: 32, maxLength: 200 },
  secretEnvNames: { maxItems: 16, maxLength: 120 },
  secretCommands: { maxItems: 16, maxLength: 200 },
  packageCooldownDays: { min: 0, max: 365 },
  searchNudgeAt: { min: 0, max: 50 },
  turnLogKeepHours: { min: 1, max: 168 },
  meetingBeforeMinutes: { min: 0, max: 120 },
  meetingMissedMinutes: { min: 0, max: 120 },
  wakePriority: { min: 1, max: 99 },
  wakeBatchSeconds: { min: 0, max: 3600 },
  wakeMinGapMinutes: { min: 0, max: 1440 },
  maxFailureChars: { min: 500, max: 50_000 },
  githubRepos: { maxItems: 20, maxLength: 140 },
  closedDays: { min: 1, max: 365 },
  githubEveryMinutes: { min: 0, max: 1440 },
  similarThreshold: { min: 0, max: 1 },
  budgetTargetPct: { min: 1, max: 100 },
  budgetReservePct: { min: 0, max: 50 },
  /** 0 turns the floor off; past 50 one team's floor would leave a second less than its own (T2215). */
  shareFloorPct: { min: 0, max: 50 },
  weeklyLimitW: { min: 1_000_000, max: 1_000_000_000_000 },
  subagentWeight: { min: 0.1, max: 10 },
  extraWPerUsd: { min: 1_000, max: 1_000_000_000 },
  paceEndHoursBeforeReset: { min: 0, max: 48 },
  sessionShare: { min: 0, max: 100 },
  warnAtPct: { maxItems: 8, itemMin: 1, itemMax: 1_000 },
  budgetFiveHourWarnPct: { min: 1, max: 100 },
  paceTolerancePct: { min: 0, max: 10 },
  quietPaceWeight: { min: 0, max: 1 },
  liftMaxStopPct: { min: 1, max: 100 },
  liftReserveStopPct: { min: 1, max: 100 },
  maxBytesPerHook: { min: 100_000, max: 100_000_000 },
  budgetResets: { maxItems: 20 },
  budgetResetCount: { min: 1, max: 20 },
  hiringReviewDays: { min: 1, max: 90 },
  hiringResumeMaxTokens: { min: 10_000, max: 1_000_000 },
  hiringResumeMaxIdleDays: { min: 1, max: 90 },
  // At most RETAIN_DAYS (src/register/compaction.ts): a compaction retires older finished tasks from the working set.
  scaleOutWindowDays: { min: 1, max: 8 },
  scaleOutMinDone: { min: 1, max: 100 },
  scaleOutTopPriorities: { min: 1, max: 10 },
  burstSurplusHours: { min: 1, max: 167 },
  burstMinSparePct: { min: 0.1, max: 100 },
  burstMaxHelpers: { min: 0, max: 20 },
  burstMaxHires: { min: 0, max: 20 },
  queueLockTtlMinutes: { min: 11, max: 1440 },
  queueMaxRunMinutes: { min: 1, max: 1430 },
  queueSmallMaxRunMinutes: { min: 1, max: 1430 },
  queueWaitMinutes: { min: 0, max: 1440 },
  queueMemorySampleSeconds: { min: 0, max: 600 },
  queueMemoryFloorMb: { min: 0, max: 1_048_576 },
  queueSmallReserveMb: { min: 0, max: 1_048_576 },
  queueHeavyReserveMb: { min: 0, max: 1_048_576 },
  queueAgingMinutes: { min: 0, max: 1440 },
  queuePerSessionRunning: { min: 0, max: 64 },
  queueMaxHeavyParallel: { min: 1, max: 64 },
  headroomSessionMb: { min: 100, max: 65_536 },
  headroomCommitMaxPct: { min: 50, max: 100 },
  headroomCloseIdleMinutes: { min: 15, max: 10_080 },
  headroomFloorMb: { min: 0, max: 1_048_576 },
  headroomLoadMinutes: { min: 1, max: 60 },
  deliveryPollSeconds: { min: 1, max: 600 },
  deliveryWaitMaxMinutes: { min: 0, max: 1440 },
  checkTimeoutSeconds: { min: 1, max: 600 },
  freezeMaxMinutes: { min: 1, max: 1440 },
  settleMinutes: { min: 0, max: 1440 },
  assumedDeployMinutes: { min: 0, max: 1440 },
  stablePeriodMinMinutes: { min: 1, max: 1440 },
  resetBlackoutHours: { min: 1, max: 48 },
  execPath: { maxItems: 16, maxLength: 260 },
  /** Under 0.1 the dimming goes unseen; past 0.9 the rest of the screen can no longer be read behind it (T2517). */
  spotlightDim: { min: 0.1, max: 0.9 },
  /**
   * Under 10 s the dimming is back before the owner has read the break-through (the overlay checks every 2 s); past an
   * hour the meeting has lost its spotlight for good (T2524).
   */
  spotlightBreakthroughSeconds: { min: 10, max: 3600 },
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

/** The longest `meeting.statusLine.heldText`: it is appended to every other tab's status line, which must stay one row. */
export const MEETING_HELD_TEXT_MAX_LENGTH = 40;

/** `meeting.statusLine.colour`: a 24-bit `#rrggbb` colour, the form the status line's ANSI foreground code takes. */
export const MEETING_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** The longest `budget.account` name, on one line. */
export const BUDGET_ACCOUNT_MAX_LENGTH = 100;

/** The longest `github.acceptLabel`: GitHub caps a label name at 50 characters. */
export const GITHUB_LABEL_MAX_LENGTH = 50;

/** Bounds on the fields of one review gate entry (`pushGuard.reviewPaths`). */
export const REVIEW_PATH_LIMITS = {
  globMaxLength: 200,
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
