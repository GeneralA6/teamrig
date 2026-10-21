import { DEFAULT_PROMPTS } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { HookAsks } from '../config/types.ts';

/** How a teamrig hook holds a call back: a question for the human, or a refusal. */
export type HoldBack = 'ask' | 'deny';

/** The PreToolUse permission fields of a call a hook holds back. */
export interface Permission {
  readonly permissionDecision: HoldBack;
  readonly permissionDecisionReason: string;
}

/** What the session does instead of the prompt a refused ask would have raised. */
export const ASK_REFUSED_NOTE =
  'Asks are off [prompts.hookAsks], so teamrig refuses this instead of asking; do not retry it or route around it. ' +
  'Record the step as waiting for the owner (`teamrig set <task> --status waiting --waits approval:owner --note "<the command>"`) ' +
  'and take your next task.';

/** What a hook does with a call it would ask about. A missing or unreadable config keeps the default. */
export function hookAsksOf(load: ConfigLoad | undefined): HookAsks {
  return load?.status === 'loaded' ? load.config.prompts.hookAsks : DEFAULT_PROMPTS.hookAsks;
}

/**
 * The permission fields for a call a hook holds back. An ask stays a question under `ask`; under `refuse` it becomes
 * a refusal whose reason tells the session to record the step for the owner and take its next task, so no prompt
 * holds a session while nobody is there to answer it. A refusal stays a refusal either way.
 */
export function holdBack(decision: HoldBack, reason: string, asks: HookAsks): Permission {
  return decision === 'ask' && asks === 'refuse'
    ? { permissionDecision: 'deny', permissionDecisionReason: `${reason} ${ASK_REFUSED_NOTE}` }
    : { permissionDecision: decision, permissionDecisionReason: reason };
}

/** The PreToolUse output of a call a hook refuses whatever `prompts.hookAsks` says. */
export function refusalOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/** The PreToolUse output of a call a hook holds back (see `holdBack`). */
export function holdBackOutput(decision: HoldBack, reason: string, asks: HookAsks): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...holdBack(decision, reason, asks) } });
}
