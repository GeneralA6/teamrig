import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { testTask } from '../testing/task.ts';
import type { Decision } from './decision-order.ts';
import { decisionOf, meetingPanelOf, type PanelInput, type PanelRegister } from './panel.ts';
import type { Meeting } from './state.ts';

const STARTED = '2030-01-08T10:00:00.000Z';
const MEETING: Meeting = { startedAt: STARTED, by: 'lead', endedAt: null, since: null };
const TREE = new TaskTree(new Map(), new Date(STARTED), TimeZone.UTC);

function asked(task: Task, team?: string): Decision {
  return { task, tree: TREE, team };
}

function decidedTask(id: string, at: string, note: string | null, by = 'lead'): Task {
  return testTask({ id, title: `Card ${id}`, status: 'open', decided: { by, at, note } });
}

function own(tasks: readonly Task[]): PanelRegister {
  return { team: undefined, tasks, decidedBy: 'lead' };
}

function inputOf(registers: readonly PanelRegister[], daily: readonly Decision[] = [], batch: readonly Decision[] = []): PanelInput {
  return { meeting: MEETING, registers, asked: { daily, batch }, ownerMarker: 'owner' };
}

describe('the meeting agenda panel (T2512)', () => {
  it('lists the cards still asked in the agenda order, the first one current', () => {
    const panel = meetingPanelOf(inputOf([own([])], [asked(testTask({ id: 'T2', title: 'Pick a tier' })), asked(testTask({ id: 'T7' }), 'web')], [asked(testTask({ id: 'T9' }))]));
    assert.deepEqual(
      panel.items.map((item) => [item.id, item.settled]),
      [
        ['T2', false],
        ['web/T7', false],
        ['T9', false],
      ],
    );
    assert.equal(panel.items[0]?.title, 'Pick a tier');
    assert.equal(panel.current, 'T2');
    assert.equal(panel.left, 3);
    assert.equal(panel.startedAt, STARTED);
  });

  it('checks off the cards decided since the start, in the order decided, with the decision, before the asked ones', () => {
    const later = decidedTask('T3', '2030-01-08T10:20:00.000Z', 'owner decided: ship tier B first');
    const earlier = decidedTask('T5', '2030-01-08T10:05:00.000Z', null);
    const below: PanelRegister = { team: 'web', tasks: [decidedTask('T1', '2030-01-08T10:10:00.000Z', 'keep it', 'app/lead')], decidedBy: 'app/lead' };
    const panel = meetingPanelOf(inputOf([own([later, earlier]), below], [asked(testTask({ id: 'T8' }))]));
    assert.deepEqual(panel.items, [
      { id: 'T5', title: 'Card T5', settled: true, decision: null },
      { id: 'web/T1', title: 'Card T1', settled: true, decision: 'keep it' },
      { id: 'T3', title: 'Card T3', settled: true, decision: 'ship tier B first' },
      { id: 'T8', title: 'Add a health check', settled: false, decision: null },
    ]);
    assert.equal(panel.current, 'T8');
    assert.equal(panel.left, 1);
  });

  it('leaves out a decision from before the start or recorded by another leader', () => {
    const before = decidedTask('T3', '2030-01-08T09:59:59.000Z', 'owner decided: no');
    const other = decidedTask('T4', '2030-01-08T10:30:00.000Z', 'owner decided: yes', 'sub-lead');
    assert.deepEqual(meetingPanelOf(inputOf([own([before, other])])).items, []);
  });

  it('shows a card once, settled, when it is decided yet still asked', () => {
    const task = decidedTask('T3', '2030-01-08T10:20:00.000Z', 'owner decided: yes');
    const panel = meetingPanelOf(inputOf([own([task])], [asked(task)]));
    assert.deepEqual(
      panel.items.map((item) => item.id),
      ['T3'],
    );
    assert.equal(panel.current, null);
    assert.equal(panel.left, 0);
  });

  it('reads the decision from the note, the lead-in dropped, a blank one as none', () => {
    assert.equal(decisionOf('owner decided:  tier B\nfirst', 'owner'), 'tier B first');
    assert.equal(decisionOf('tier B', 'owner'), 'tier B');
    assert.equal(decisionOf('owner decided:', 'owner'), null);
    assert.equal(decisionOf(null, 'owner'), null);
  });
});
