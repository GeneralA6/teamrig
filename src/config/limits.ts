/**
 * Bounds on the config values the core rule pack prints. The parser enforces them, the JSON
 * schema states them, and the pack's budget test renders their extremes, so the always-loaded
 * rules stay inside their character budget whatever a team configures.
 */
export const CONFIG_LIMITS = {
  maxLines: { min: 3, max: 50 },
  maxDescriptionWords: { min: 5, max: 200 },
  maxPerArea: { min: 1, max: 100 },
  maxVerifiedAgeDays: { min: 1, max: 365 },
  ownerGates: { maxItems: 8, maxLength: 60 },
  protectedBranches: { maxItems: 8, maxLength: 64 },
  commitMaxLines: { min: 50, max: 5000 },
  commitMaxFiles: { min: 2, max: 500 },
  testPatterns: { maxItems: 8, maxLength: 100 },
  forbidFrontmatter: { maxItems: 8, maxLength: 32 },
  requireNoteOn: { maxItems: 5 },
  persistentFailureHours: { min: 1, max: 720 },
} as const;
