/**
 * The hook events Antigravity CLI (`agy`) fires.
 *
 * Its hooks page (`https://antigravity.google/docs/hooks/`, read 2026-11-20 for agy 1.5.12) names six, the whole
 * list. agy has none for a typed prompt, a permission request, a compaction, a session's end, a helper's start or
 * stop, or a failed tool, so teamrig's hooks for those have nothing to run on here. PreInvocation and PostInvocation
 * are agy's own: they fire before and after each model call.
 */
export const ANTIGRAVITY_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PreInvocation',
  'PostInvocation',
  'Stop',
] as const;

export type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

export function isAntigravityHookEvent(name: string): name is AntigravityHookEvent {
  return ANTIGRAVITY_HOOK_EVENTS.some((event) => event === name);
}
