import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from '../config/limits.ts';
import type { HookAsks, KitConfig, PushToProtected } from '../config/types.ts';
import { FOLLOWUP_STATUSES, TASK_STATUSES } from '../register/model.ts';
import { testConfig } from './config.ts';

/** A delivery repository that `teamrig deploy` deploys. */
export const DEPLOYED_REPO = { mainCheckout: 'C:/src/app', deploy: { targets: ['api'], command: ['node', 'deploy.js'] } };
export const longest = (letter: string, length: number) => letter.repeat(length);
export const filled = (limit: { readonly maxItems: number; readonly maxLength: number }, letter: string) =>
  Array.from({ length: limit.maxItems }, () => longest(letter, limit.maxLength));

/**
 * How the push and message rules are worded: the budget spec tries every combination, as which is longest changes
 * with the wording.
 */
export interface Wording {
  readonly pushToProtected: PushToProtected;
  readonly hookAsks: HookAsks;
  readonly wakeEnabled: boolean;
}

/** Every printed value at its longest: names, lists, numbers and the optional rules all on. */
export function worstCaseConfig(wording: Wording = { pushToProtected: 'ask', hookAsks: 'refuse', wakeEnabled: true }): KitConfig {
  const lead = longest('l', 32);
  const delivery = longest('c', 32);
  // A team above's reviewer, `<team>/<id>`, prints longest in rule 1; with one set, rule 11's auditor wording is longer.
  const reviewer = `${longest('t', 32)}/${longest('r', 32)}`;
  return testConfig({
    // Its mark and offset, `ACWST` and `UTC+8:45`, print widest of every zone's, in either season.
    timeZone: 'Australia/Eucla',
    sessions: [lead, delivery],
    roles: { lead, deliveryOwner: delivery, securityReviewer: reviewer },
    ownerGates: filled(CONFIG_LIMITS.ownerGates, 'g'),
    messages: { maxLines: CONFIG_LIMITS.maxLines.max },
    register: {
      requireNoteOn: [...TASK_STATUSES].sort((a, b) => b.length - a.length).slice(0, CONFIG_LIMITS.requireNoteOn.maxItems),
      requireEvidenceOnDone: true,
      requireSkillOnDone: true,
      requireFollowupsOn: FOLLOWUP_STATUSES.slice(0, CONFIG_LIMITS.requireFollowupsOn.maxItems),
      ownerSource: longest('o', 32),
    },
    skills: {
      sharedPrefix: longest('s', 32),
      maxDescriptionWords: CONFIG_LIMITS.maxDescriptionWords.max,
      maxPerArea: CONFIG_LIMITS.maxPerArea.max,
      maxVerifiedAgeDays: CONFIG_LIMITS.maxVerifiedAgeDays.max,
      forbidFrontmatter: filled(CONFIG_LIMITS.forbidFrontmatter, 'k'),
    },
    pushGuard: { protectedBranches: filled(CONFIG_LIMITS.protectedBranches, 'b'), pushToProtected: wording.pushToProtected },
    prompts: { hookAsks: wording.hookAsks },
    wake: { enabled: wording.wakeEnabled },
    commits: { maxLines: CONFIG_LIMITS.commitMaxLines.max, maxFiles: CONFIG_LIMITS.commitMaxFiles.max, largeCommitTrailer: 'T'.repeat(40), gate: 'refuse' },
    delivery: { schedule: { queueCutoffUtc: '22:30' }, repos: { app: DEPLOYED_REPO } },
    // Both round to their longest two-decimal form (two digits before the point), and together stay within 100%.
    // The lead's week-split line prints the main lead's team id and the floor.
    budget: {
      enabled: true,
      targetPct: 50.98765432109876,
      reservePct: 48.98765432109876,
      subagentWeight: 9.87654321,
      accountLead: longest('a', 32),
      shareFloorPct: CONFIG_LIMITS.shareFloorPct.max,
    },
    alerts: { persistentFailureHours: CONFIG_LIMITS.persistentFailureHours.max },
    // A class name is at most 32 characters (WORK_CLASS_NAME); the lead's slice line prints the Maintenance one.
    focus: {
      classes: ['Roadmap', longest('m', 32), 'Improvements'],
      maintenanceClass: longest('m', 32),
      allocation: { Roadmap: 60, [longest('m', 32)]: 25, Improvements: 15 },
      slicesPerSession: CONFIG_LIMITS.slicesPerSession.max,
      maxOwnerDecisions: CONFIG_LIMITS.maxOwnerDecisions.max,
    },
    tabStatus: { enabled: true },
    ruleConflicts: Array.from({ length: CONFIG_LIMITS.ruleConflicts.maxItems }, () => ({
      file: longest('f', RULE_CONFLICT_LIMITS.fileMaxLength),
      text: longest('t', RULE_CONFLICT_LIMITS.textMaxLength),
      rule: 'worktrees',
      wins: 'local',
      reason: longest('r', RULE_CONFLICT_LIMITS.reasonMaxLength),
    })),
  });
}
