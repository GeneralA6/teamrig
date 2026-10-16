/**
 * Each core rule's stable key, in the pack's order, so rule N is `CORE_RULE_KEYS[N - 1]`. A recorded
 * conflict names its rule by key, so it keeps naming the same rule when a rule is added or moved.
 */
export const CORE_RULE_KEYS = [
  'roles',
  'own-change',
  'messages',
  'register',
  'task-order',
  'owner-gates',
  'deploy',
  'lean-calls',
  'investigate',
  'resources',
  'data',
  'contracts',
  'skills',
  'commits',
  'push',
  'worktrees',
] as const;

export type CoreRuleKey = (typeof CORE_RULE_KEYS)[number];

export function isCoreRuleKey(text: string): text is CoreRuleKey {
  return CORE_RULE_KEYS.some((key) => key === text);
}

/** The rule's number in the pack, from 1. */
export function ruleNumberOf(key: CoreRuleKey): number {
  return CORE_RULE_KEYS.indexOf(key) + 1;
}

/** `16 worktrees`: how a scan or a record names a rule, its number for reading the pack and its key for typing. */
export function ruleLabel(key: CoreRuleKey): string {
  return `${ruleNumberOf(key)} ${key}`;
}

/** The rule a user names by its number (`16`) or its key (`worktrees`), or undefined when neither fits. */
export function coreRuleKeyOf(text: string): CoreRuleKey | undefined {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    return CORE_RULE_KEYS[Number(trimmed) - 1];
  }
  return isCoreRuleKey(trimmed) ? trimmed : undefined;
}
