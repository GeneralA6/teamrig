import type { TreePlace } from '../config/tree.ts';
import type { AskWith } from '../config/types.ts';
import { formatAddress } from '../core/address.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { DECISION_MARKER } from '../tabs/status.ts';

/**
 * The picker guard: with `pickerGuard.enabled`, refuses Claude Code's question picker (AskUserQuestion) in every
 * team session. The picker stops the session until the person answers, and the owner may be away for hours, so a
 * session waiting on one task's decision would move none of its other tasks meanwhile. The refusal's reason says
 * what to do instead: decide it when it is the session's own to decide, else record it on its task as a decision
 * card with its default, which reaches the owner through the lead, and go on with the next task.
 *
 * The lead's own thread keeps the picker only while the owner's daily meeting is open and the team asks with it
 * (`decisions.askWith: picker`): the owner is there then. By default the meeting asks in plain text, so the guard
 * refuses it there too, saying to ask the cards in plain text (T1278). A sub-team's lead never keeps it: the user talks only to the root team's lead, so its
 * decisions go up to its parent lead (T1019). A helper never keeps it, the lead's neither: its picker stops the
 * session that started it, and its question belongs in its report. ExitPlanMode stays allowed: plan mode starts only
 * when the person chose it in that tab, and the tool is its only way out.
 */

/** The tool the guard refuses: the question picker. */
export const PICKER_TOOL = 'AskUserQuestion';

/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of the picker. */
export function guardsPicker(enabled: boolean, payload: JsonRecord): boolean {
  return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === PICKER_TOOL;
}

/** A sub-team's parent lead and the name to message it by (config/tree.ts). */
export type ParentLead = NonNullable<TreePlace['parentLead']>;

/**
 * Who calls the picker: a team session's own thread, the lead's of a team with no parent team, a sub-team's lead's
 * with its parent lead, or a helper that any of them started.
 */
export type PickerAsker =
  | { readonly session: string; readonly role: 'session' | 'lead' | 'helper' }
  | { readonly session: string; readonly role: 'subteam-lead'; readonly parentLead: ParentLead };

/**
 * Who calls the picker in `session`, from a helper or not; `parentLead` is the team's parent lead when the team hangs
 * under another. Undefined for a tab that is no team session, which the guard leaves alone.
 */
export function askerOf(session: string | undefined, helper: boolean, lead: string, parentLead: ParentLead | undefined): PickerAsker | undefined {
  if (session === undefined) {
    return undefined;
  }
  if (helper || session !== lead) {
    return { session, role: helper ? 'helper' : 'session' };
  }
  return parentLead === undefined ? { session, role: 'lead' } : { session, role: 'subteam-lead', parentLead };
}

/**
 * The owner's daily meeting as the guard sees it: whether it is open, read for the root lead's own thread only, as no
 * other asker's picker opens in it, and how it asks the owner (`decisions.askWith`).
 */
export interface LeadMeeting {
  readonly open: boolean;
  readonly askWith: AskWith;
}

/**
 * Whether the guard refuses the picker to `asker`: always, but to the root lead's own thread while the owner's daily
 * meeting is open and asks with the picker.
 */
export function refusesAsker(asker: PickerAsker, meeting: LeadMeeting): boolean {
  return asker.role !== 'lead' || !meeting.open || meeting.askWith !== 'picker';
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
export function pickerReason(command: string, asker: PickerAsker, meeting: LeadMeeting): string {
  const guard = `${command} picker guard:`;
  if (asker.role === 'lead' && meeting.open) {
    return (
      `${guard} the owner's daily meeting asks in plain text (decisions.askWith: text). Read the card as it stands,` +
      " its options numbered and your recommendation first, and let the owner answer in their own words; record the answer in the same turn:" +
      ` \`${command} update <id> --decided --note "owner decided: <decision>" --session ${asker.session}\`.`
    );
  }
  if (asker.role === 'helper') {
    return (
      `${guard} a helper's question picker stops the session that started it until the owner answers, and the owner may be away for hours.` +
      ' Decide it yourself if it is within your brief. Else finish the rest of your brief and end your report with the decision:' +
      ' what is decided, the options, your recommendation and what happens with no answer; the session that started you records it.'
    );
  }
  const card =
    `${guard} the question picker stops this session until the owner answers, and the owner may be away for hours, so none of its other tasks moves meanwhile.` +
    ' Decide it yourself if it is yours to decide, and note it on its task. Else record it on its task as a decision card, its --default included,' +
    ` and take your next task that does not need the answer: ${cardCommand(command, asker.session)}`;
  const ask = ` Only when no task is left, end your turn with the question in plain text and a \`${DECISION_MARKER}\` line.`;
  switch (asker.role) {
    case 'session':
      return `${card}; the lead brings it to the owner.${ask}`;
    case 'lead':
      return `${card}; the agenda of the owner's next daily meeting lists it, ${meetingAsk(command, meeting.askWith)}.${ask}`;
    case 'subteam-lead':
      return `${card}${parentRoute(command, asker.session, asker.parentLead)}`;
  }
}

/** How the root lead asks the card at the owner's next daily meeting, per `askWith`. */
function meetingAsk(command: string, askWith: AskWith): string {
  return askWith === 'picker'
    ? `and the picker opens for you only while that meeting is open (\`${command} meeting start\`)`
    : `and you ask it there in plain text (\`${command} meeting start\`)`;
}

/** Where a sub-team's lead takes the card instead: one inbox line to its parent lead, who carries it up to the owner. */
function parentRoute(command: string, session: string, parentLead: ParentLead): string {
  const to = formatAddress(parentLead);
  return (
    `; then tell your parent lead ${to} (name \`${parentLead.name}\`) in one inbox line,` +
    ` \`${command} inbox add --to ${to} --text "T<id> waits on the owner's decision: <what is decided>" --session ${session}\`, and it carries the decision up.` +
    " The user talks only to the root team's lead, so the picker never opens for a sub-team's lead, and its tab never asks the owner: with no task left, end your turn."
  );
}
