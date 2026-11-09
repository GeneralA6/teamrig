import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { askLine, cardFacts, laterLine } from './agenda.ts';
import { meetCardLines, type MeetInput } from './meet.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function treeOf(tasks: readonly Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC);
}

const DECIDE = testTask({ id: 'T4', title: 'Pick the pricing tier', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD });
const APPROVE = testTask({ id: 'T5', title: 'Ship the price page', status: 'verifying', waits: [{ kind: 'approval', who: 'owner' }] });
const PUT_OFF = testTask({ id: 'T6', title: 'Name the plan', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }, { kind: 'time', at: '2030-01-09 12:00' }], card: TEST_OWNER_CARD });

function inputOf(due: readonly Task[], askWith: MeetInput['askWith'] = 'text'): MeetInput {
  return {
    id: 'alpha',
    name: 'api',
    cards: { due, later: [{ task: PUT_OFF, until: '2030-01-09 12:00' }] },
    tree: treeOf([...due, PUT_OFF]),
    ownerMarker: 'owner',
    command: 'teamrig',
    askWith,
    runFiles: new Map(),
  };
}

describe('meetCardLines', () => {
  it("prints only the session's due cards, each with its card facts, then how to bring, ask and record them", () => {
    const input = inputOf([DECIDE, APPROVE]);
    const lines = meetCardLines(input);
    const facts = [...cardFacts(DECIDE, input.tree, input.runFiles), ...cardFacts(APPROVE, input.tree, input.runFiles)];
    assert.equal(lines[0], 'MEET api (session alpha): 2 card(s) waiting on owner');
    assert.deepEqual(lines.slice(1, 1 + facts.length), facts);
    assert.deepEqual(lines.slice(1 + facts.length), [
      "  Bring them to owner one at a time, each read as it stands, each figure explained; where one says no card yet, the card is yours: give its question, options and your recommendation first. Never point to a doc; `teamrig show <id>` prints a task whole.",
      askLine('text', 'owner'),
      '  A question a card does not answer is yours to find: find it now, or ask owner to put the card off until you have it.',
      '  Record each answer in the same turn: teamrig set <id> --status <the status the answer leaves it in> --note "owner decided: <decision>" --session alpha; it leaves the lead\'s agenda.',
      laterLine('teamrig', 'owner', 'alpha', "it stays off the lead's agenda until then"),
      '  When none is left, go on with your own work: teamrig list --session alpha.',
    ]);
    assert.ok(!lines.some((line) => line.includes('T6')), 'a card put off is not read');
  });

  it('asks with the question picker when the team asks for it', () => {
    assert.ok(meetCardLines(inputOf([DECIDE], 'picker')).includes(askLine('picker', 'owner')));
  });
});
