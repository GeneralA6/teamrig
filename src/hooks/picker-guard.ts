import { stringField, type JsonRecord } from '../core/guards.ts';
import { DECISION_MARKER } from '../tabs/status.ts';

/**
 * The picker guard: with `pickerGuard.enabled`, refuses Claude Code's question picker (AskUserQuestion) in every
 * team session. The picker stops the session until the person answers, and the owner may be away for hours, so a
 * session waiting on one task's decision would move none of its other tasks meanwhile. The refusal's reason says
 * what to do instead: decide it when it is the session's own to decide, else record it on its task as a decision
 * card with its default, which reaches the owner through the lead, and go on with the next task.
 *
 * The lead's own thread keeps the picker only while the owner's daily meeting is open: the owner is there then, and
 * the meeting asks through it. A helper never keeps it, the lead's neither: its picker stops the session that
 * started it, and its question belongs in its report. ExitPlanMode stays allowed: plan mode starts only when the
 * person chose it in that tab, and the tool is its only way out.
 */

/** The tool the guard refuses: the question picker. */
export const PICKER_TOOL = 'AskUserQuestion';

/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of the picker. */
export function guardsPicker(enabled: boolean, payload: JsonRecord): boolean {
  return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === PICKER_TOOL;
}

/** Who calls the picker: a team session's own thread, the lead's, or a helper that either started. */
export type AskerRole = 'session' | 'lead' | 'helper';

export interface PickerAsker {
  readonly session: string;
  readonly role: AskerRole;
}

/** Who calls the picker in `session`, from a helper or not; undefined for a tab that is no team session, which the guard leaves alone. */
export function askerOf(session: string | undefined, helper: boolean, lead: string): PickerAsker | undefined {
  if (session === undefined) {
    return undefined;
  }
  return { session, role: helper ? 'helper' : session === lead ? 'lead' : 'session' };
}

/** Whether the guard refuses the picker to `asker`: always, but to the lead's own thread while the owner's daily meeting is open. */
export function refusesAsker(asker: PickerAsker, meetingOpen: boolean): boolean {
  return asker.role !== 'lead' || !meetingOpen;
}

/** The decision card's set command for `session`, run with `command`. */
function cardCommand(command: string, session: string): string {
  return (
    `\`${command} set <id> --status waiting --waits decision:owner --note "<what waits>"` +
    ` --question "<what is decided>" --options "<a, its numbers> | <b>" --recommend "<which, and why>" --default "<what happens with no answer>"` +
    ` --session ${session}\``
  );
}

/** Why the picker is refused, and what `asker` does instead, with the `command` it runs. */
export function pickerReason(command: string, asker: PickerAsker): string {
  const guard = `${command} picker guard:`;
  if (asker.role === 'helper') {
    return (
      `${guard} a helper's question picker stops the session that started it until the owner answers, and the owner may be away for hours.` +
      ' Decide it yourself if it is within your brief. Else finish the rest of your brief and end your report with the decision:' +
      ' what is decided, the options, your recommendation and what happens with no answer; the session that started you records it.'
    );
  }
  const route =
    asker.role === 'lead'
      ? `; the agenda of the owner's next daily meeting lists it, and the picker opens for you only while that meeting is open (\`${command} meeting start\`).`
      : '; the lead brings it to the owner.';
  return (
    `${guard} the question picker stops this session until the owner answers, and the owner may be away for hours, so none of its other tasks moves meanwhile.` +
    ' Decide it yourself if it is yours to decide, and note it on its task. Else record it on its task as a decision card, its --default included,' +
    ` and take your next task that does not need the answer: ${cardCommand(command, asker.session)}${route}` +
    ` Only when no task is left, end your turn with the question in plain text and a \`${DECISION_MARKER}\` line.`
  );
}

/** The hook's stdout for a refusal: a PreToolUse deny with the reason. */
export function pickerGuardOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
