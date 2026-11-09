import { askLine, cardFacts, laterLine } from "./agenda.js";
/** The session's due cards on the owner, then how it brings them one at a time and records each answer on its task. */
export function meetCardLines(input) {
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
