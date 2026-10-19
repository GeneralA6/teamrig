import { DEFAULT_PROMPTS } from "../config/defaults.js";
/** What the session does instead of the prompt a refused ask would have raised. */
export const ASK_REFUSED_NOTE = 'Asks are off [prompts.hookAsks], so teamrig refuses this instead of asking; do not retry it or route around it. ' +
    'Record the step as waiting for the owner (`teamrig set <task> --status waiting --waits approval:owner --note "<the command>"`) ' +
    'and take your next task.';
/** What a hook does with a call it would ask about. A missing or unreadable config keeps the default. */
export function hookAsksOf(load) {
    return load?.status === 'loaded' ? load.config.prompts.hookAsks : DEFAULT_PROMPTS.hookAsks;
}
/**
 * The permission fields for a call a hook holds back. An ask stays a question under `ask`; under `refuse` it becomes
 * a refusal whose reason tells the session to record the step for the owner and take its next task, so no prompt
 * holds a session while nobody is there to answer it. A refusal stays a refusal either way.
 */
export function holdBack(decision, reason, asks) {
    return decision === 'ask' && asks === 'refuse'
        ? { permissionDecision: 'deny', permissionDecisionReason: `${reason} ${ASK_REFUSED_NOTE}` }
        : { permissionDecision: decision, permissionDecisionReason: reason };
}
/** The PreToolUse output of a call a hook holds back (see `holdBack`). */
export function holdBackOutput(decision, reason, asks) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...holdBack(decision, reason, asks) } });
}
