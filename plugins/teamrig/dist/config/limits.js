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
};
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
};
