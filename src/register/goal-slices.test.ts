import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { goalSliceRefusal, goalsInRankOrder, isLate, lateSlices, sliceLabel, type GoalSliceInput, type SliceWriter } from './goal-slices.ts';
import { foldGoals, type Goal, type GoalAdd, type GoalRecord, type GoalSliceRecord } from './goals.ts';

const add = (tag: string): GoalAdd => ({
  type: 'goal-add',
  at: '2030-01-08T10:00:00.000Z',
  by: 'lead',
  tag,
  title: `Goal ${tag}`,
  start: '2030-01-08',
  target: '2030-01-31',
  parent: null,
});

const FIRST: GoalSliceRecord = {
  type: 'goal-slice',
  at: '2030-01-09T10:00:00.000Z',
  by: 'lead',
  tag: 'A1',
  slice: 1,
  title: 'Pane reads slices',
  owner: 'tr-pane',
  ship: '2030-01-15',
  proof: 'the pane shows A1:1 live',
  tasks: ['T10', 'T11'],
  size: null,
  proven: null,
  note: 'first slice',
};

const LEAD: SliceWriter = { by: 'lead', lead: 'lead' };
const OWNER: SliceWriter = { by: 'tr-pane', lead: 'lead' };

function goalsOf(...records: readonly GoalRecord[]): ReadonlyMap<string, Goal> {
  return foldGoals(records).goals;
}

/** A `goal slice` ask naming only what `over` gives. */
function input(over: Partial<GoalSliceInput> = {}): GoalSliceInput {
  return { tag: 'A1', slice: 1, title: null, owner: null, ship: null, proof: null, tasks: null, size: null, proven: null, note: 'why', ...over };
}

const NEW: GoalSliceInput = input({ title: 'Pane reads slices', owner: 'tr-pane', ship: '2030-01-15', proof: 'the pane shows A1:1 live', tasks: ['T10', 'T11'] });

describe('sliceLabel', () => {
  it('names a slice by its goal tag and number', () => {
    assert.equal(sliceLabel('A1.2', 3), 'A1.2:3');
  });
});

describe('goalSliceRefusal', () => {
  const sliced = goalsOf(add('A1'), FIRST);

  it('lets the lead add a whole new slice and change one, and the owner record its proof alone', () => {
    assert.equal(goalSliceRefusal(NEW, goalsOf(add('A1')), LEAD), undefined);
    assert.equal(goalSliceRefusal(input({ ship: '2030-01-17' }), sliced, LEAD), undefined);
    assert.equal(goalSliceRefusal(input({ proven: 'shown live' }), sliced, OWNER), undefined);
    assert.equal(goalSliceRefusal(input({ proven: 'shown live' }), sliced, LEAD), undefined);
  });

  it('says why it refuses each bad slice write', () => {
    const proven = goalsOf(add('A1'), FIRST, { ...FIRST, at: '2030-01-12T10:00:00.000Z', by: 'tr-pane', title: null, owner: null, ship: null, proof: null, tasks: null, proven: 'shown live' });
    const twoSlices = goalsOf(add('A1'), FIRST, { ...FIRST, slice: 2, tasks: ['T12'] });
    const cases: readonly (readonly [GoalSliceInput, ReadonlyMap<string, Goal>, SliceWriter, RegExp])[] = [
      [input({ tag: 'B1' }), sliced, LEAD, /goal B1 does not exist/],
      [input({ slice: 0 }), sliced, LEAD, /a slice is a whole number from 1/],
      [input({ ship: '2030-01-17', note: ' ' }), sliced, LEAD, /says why in --note/],
      [input({ ship: 'soon' }), sliced, LEAD, /--ship is a YYYY-MM-DD day/],
      [NEW, goalsOf(add('A1')), OWNER, /only the lead \(lead\) adds and changes/],
      [input({ ship: '2030-01-17' }), sliced, OWNER, /a slice's owner records only its --proven/],
      [input({ proven: 'shown live' }), sliced, { by: 'tr-guards', lead: 'lead' }, /only the lead/],
      [input({ ship: '2030-01-17' }), sliced, { by: 'lead', lead: undefined }, /^only the lead adds/],
      [input({ title: 'Only a title', slice: 2 }), sliced, LEAD, /slice A1:2 is new: name its --title, --owner, --ship, --proof and --tasks/],
      [{ ...NEW, slice: 2, tasks: ['T12'], proven: 'early' }, sliced, LEAD, /slice A1:2 is new: add it first/],
      [input({ proven: 'again' }), proven, OWNER, /slice A1:1 is proven already, by tr-pane: shown live/],
      [input({ ship: '2030-01-15', owner: 'tr-pane' }), sliced, LEAD, /already reads so; nothing to change/],
      [input({ tasks: ['T10', 'T12'] }), twoSlices, LEAD, /T12 makes slice A1:2 already/],
      [input({ tasks: ['T10', 'T10'] }), sliced, LEAD, /--tasks names a task twice/],
    ];
    for (const [ask, goals, writer, reason] of cases) {
      assert.match(goalSliceRefusal(ask, goals, writer) ?? '', reason);
    }
  });
});

describe('lateSlices', () => {
  it('names the slices past their ship day with no proof, today itself on time', () => {
    const goals = goalsOf(
      add('A1'),
      add('B1'),
      FIRST,
      { ...FIRST, slice: 2, ship: '2030-01-20', tasks: ['T12'] },
      { ...FIRST, tag: 'B1', tasks: ['T20'] },
      { ...FIRST, tag: 'B1', at: '2030-01-14T10:00:00.000Z', title: null, owner: null, ship: null, proof: null, tasks: null, proven: 'shown live' },
    );
    assert.deepEqual(
      lateSlices(goals, '2030-01-15').map(({ goal, slice }) => sliceLabel(goal.tag, slice.number)),
      [],
    );
    assert.deepEqual(
      lateSlices(goals, '2030-01-16').map(({ goal, slice }) => sliceLabel(goal.tag, slice.number)),
      ['A1:1'],
    );
    const proven = goals.get('B1')?.slices[0];
    assert.ok(proven !== undefined);
    assert.equal(isLate(proven, '2030-02-01'), false);
  });
});

describe('goalsInRankOrder', () => {
  it('puts the ranked goals first by rank, then the rest in add order', () => {
    const goals = goalsOf(add('A1'), add('B1'), add('C1'), add('D1'), { type: 'goal-rank', at: '2030-01-09T10:00:00.000Z', by: 'lead', tag: 'C1', rank: 2 }, { type: 'goal-rank', at: '2030-01-09T10:00:00.000Z', by: 'lead', tag: 'D1', rank: 1 });
    assert.deepEqual(
      goalsInRankOrder(goals).map((goal) => goal.tag),
      ['D1', 'C1', 'A1', 'B1'],
    );
  });
});
