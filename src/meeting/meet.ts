import type { AskWith } from '../config/types.ts';
import type { RunFiles } from '../register/hand-step.ts';
import type { OwnerCards } from '../register/owner-waits.ts';
import type { TaskTree } from '../register/tree.ts';
import { askLine, cardFacts, laterLine } from './agenda.ts';

/**
 * What `teamrig meet --cards` prints a session the owner meets on its own cards waiting on them (T1295): only the
 * cards the lead would ask now, each with its card facts, then how to bring, ask and record them. The cards the owner
 * put off stay out, so a session opened fresh for the meeting reads no more than it asks.
 */

export interface MeetInput {
  /** The session met, by id and by the name a person reads. */
  readonly id: string;
  readonly name: string;
  /** Its cards on the owner (ownerCardsBySession); only the due ones print. */
  readonly cards: OwnerCards;
  /** The read of the register that holds the cards. */
  readonly tree: TaskTree;
  /** The register's marker for the owner (`register.ownerSource`). */
  readonly ownerMarker: string;
  readonly command: string;
  /** `decisions.askWith`: plain text or the question picker (T1278). */
  readonly askWith: AskWith;
  /** What the hand step file of each due card hashes to now (T2312). */
  readonly runFiles: RunFiles;
}

/** The session's due cards on the owner, then how it brings them one at a time and records each answer on its task. */
export function meetCardLines(input: MeetInput): string[] {
  const { id, ownerMarker, command } = input;
  const { due } = input.cards;
  return [
    `MEET ${input.name} (session ${id}): ${due.length} card(s) waiting on ${ownerMarker}`,
    ...due.flatMap((task) => cardFacts(task, input.tree, input.runFiles)),
    `  Bring them to ${ownerMarker} one at a time, each read as it stands, each figure explained; where one says no card yet, the card is yours: give its question, options and your recommendation first. Never point to a doc; \`${command} show <id>\` prints a task whole.`,
    askLine(input.askWith, ownerMarker),
    `  A question a card does not answer is yours to find: find it now, or ask ${ownerMarker} to put the card off until you have it.`,
    `  Record each answer in the same turn: ${command} set <id> --status <the status the answer leaves it in> --note "${ownerMarker} decided: <decision>" --session ${id}; it leaves the lead's agenda.`,
    laterLine(command, ownerMarker, id, "it stays off the lead's agenda until then"),
    `  When none is left, go on with your own work: ${command} list --session ${id}.`,
  ];
}
