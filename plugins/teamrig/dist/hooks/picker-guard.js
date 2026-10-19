import { stringField } from "../core/guards.js";
import { DECISION_MARKER } from "../tabs/status.js";
/**
 * The picker guard: with `pickerGuard.enabled`, refuses Claude Code's question picker (AskUserQuestion) to every
 * team session but the lead. The picker stops the session until the person answers, so a session waiting on one
 * task's decision moves none of its other tasks meanwhile. The refusal's reason says what to do instead: record the
 * decision on its task, which reaches the owner through the lead, and go on with the next task.
 *
 * The lead keeps the picker: it is the owner's route, and the daily meeting asks through it. ExitPlanMode stays
 * allowed: plan mode starts only when the person chose it in that tab, and the tool is its only way out.
 */
/** The tool the guard refuses: the question picker. */
export const PICKER_TOOL = 'AskUserQuestion';
/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of the picker. */
export function guardsPicker(enabled, payload) {
    return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === PICKER_TOOL;
}
/** Whether the guard refuses the picker to `session`: a team session but the lead; undefined is a tab that is no team session. */
export function refusesSession(session, lead) {
    return session !== undefined && session !== lead;
}
/** Why the picker is refused, and what `session` does instead, with the `command` it runs. */
export function pickerReason(command, session) {
    return (`${command} picker guard: the question picker stops this session until the owner answers, so none of its other tasks moves meanwhile.` +
        ` Record the decision on its task instead: \`${command} set <id> --status waiting --waits decision:owner --note "<what waits>"` +
        ` --question "<what is decided>" --options "<a, its numbers> | <b>" --recommend "<which, and why>" --default "<what happens with no answer>"` +
        ` --session ${session}\`; the lead brings it to the owner. Then go straight on with your next task that does not need the answer.` +
        ` Only when no task is left, end your turn with the question in plain text and a \`${DECISION_MARKER}\` line.`);
}
/** The hook's stdout for a refusal: a PreToolUse deny with the reason. */
export function pickerGuardOutput(reason) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
