import type { Task } from '../register/fold.ts';
import { cut } from '../register/views.ts';
import { oneLine } from './agenda.ts';
import type { Decision } from './decision-order.ts';
import type { Meeting } from './state.ts';

/**
 * The meeting's agenda panel (T2512): the owner's cards of an open meeting as one checklist beside the lead's chat.
 * It keeps no state of its own: a card the lead recorded a decision on since the meeting started (`update --decided`)
 * is checked off, in the order decided, then the cards still asked follow in the agenda's order (askedDecisions), and
 * the first of those is the one on the table now.
 */

/** One card on the panel; `id` names a task of a team under the lead's as `<team>/<id>`, as the agenda's rows do. */
export interface PanelItem {
  readonly id: string;
  readonly title: string;
  /**
   * What the card asks, in a line or two, since a title alone can be vague (T2519): its card's question, else the
   * task's description, cut to SUMMARY_CHARS; null when the task has neither.
   */
  readonly summary: string | null;
  readonly settled: boolean;
  /** What the owner decided, from the note the lead recorded; null on a card still asked, or one decided with no note. */
  readonly decision: string | null;
}

export interface MeetingPanel {
  readonly startedAt: string;
  readonly items: readonly PanelItem[];
  /** The card on the table now, the first one not settled; null once every card is. */
  readonly current: string | null;
  /** How many cards are still to decide. */
  readonly left: number;
}

/** A register the meeting covers: the lead's own (`team` undefined) or one under it, and the name its decisions are recorded by. */
export interface PanelRegister {
  readonly team: string | undefined;
  readonly tasks: readonly Task[];
  /** Who records the owner's decisions here: the lead's id on its own register, its `<team>/<id>` address below. */
  readonly decidedBy: string;
}

export interface PanelInput {
  readonly meeting: Meeting;
  readonly registers: readonly PanelRegister[];
  /** The cards the agenda asks now, in its order (askedDecisions). */
  readonly asked: { readonly daily: readonly Decision[]; readonly batch: readonly Decision[] };
  /** `register.ownerSource`: the word a decision note starts with (`<marker> decided: <decision>`), dropped on the panel. */
  readonly ownerMarker: string;
}

/** The longest summary a card shows: two lines of a 60-column pane, the full card being in the agenda the lead reads. */
export const SUMMARY_CHARS = 120;

function labelOf(team: string | undefined, id: string): string {
  return team === undefined ? id : `${team}/${id}`;
}

/** A card's summary: what its card asks, else what the task is; null when it has neither, or only blanks. */
export function summaryOf(task: Task): string | null {
  const text = oneLine(task.card?.question ?? task.description ?? '');
  return text === '' ? null : cut(text, SUMMARY_CHARS);
}

function itemOf(team: string | undefined, task: Task, decision: string | null, settled: boolean): PanelItem {
  return { id: labelOf(team, task.id), title: oneLine(task.title), summary: summaryOf(task), settled, decision };
}

/** The decision a recorded note gives, its `<marker> decided:` lead-in dropped. */
export function decisionOf(note: string | null, ownerMarker: string): string | null {
  if (note === null) {
    return null;
  }
  const text = oneLine(note);
  const lead = `${ownerMarker} decided:`;
  const decision = text.startsWith(lead) ? text.slice(lead.length).trim() : text;
  return decision === '' ? null : decision;
}

interface Settled {
  readonly item: PanelItem;
  readonly at: number;
}

function settledOf(register: PanelRegister, since: number, ownerMarker: string): Settled[] {
  return register.tasks.flatMap((task) => {
    const { decided } = task;
    if (decided === null || decided.by !== register.decidedBy || Date.parse(decided.at) < since) {
      return [];
    }
    return [{ item: itemOf(register.team, task, decisionOf(decided.note, ownerMarker), true), at: Date.parse(decided.at) }];
  });
}

export function meetingPanelOf(input: PanelInput): MeetingPanel {
  const since = Date.parse(input.meeting.startedAt);
  const settled = input.registers
    .flatMap((register) => settledOf(register, since, input.ownerMarker))
    .sort((a, b) => a.at - b.at)
    .map(({ item }) => item);
  const done = new Set(settled.map((item) => item.id));
  const asked = [...input.asked.daily, ...input.asked.batch]
    .map((card) => itemOf(card.team, card.task, null, false))
    .filter((item) => !done.has(item.id));
  return { startedAt: input.meeting.startedAt, items: [...settled, ...asked], current: asked[0]?.id ?? null, left: asked.length };
}
