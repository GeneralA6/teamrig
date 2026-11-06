import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import {
  changesOf,
  changesText,
  countLines,
  formatSweepRows,
  isSweepRow,
  parseSweepFile,
  planLine,
  planSweepRow,
  proposalOf,
  proposeRow,
  refusedPlan,
  sweepCounts,
  tallyOf,
  tallyText,
  titleWords,
  wouldPark,
  type SweepFocus,
  type SweepGoal,
  type SweepInput,
  type SweepPlan,
  type SweepRow,
} from './sweep.ts';

const FOCUS: SweepFocus = { roadmapClass: 'Roadmap', maintenanceClass: 'Maintenance', defaultClass: 'Improvements', parkAfterDays: 14 };

function goal(tag: string, title: string, rank: number | null, parent: string | null = null): SweepGoal {
  return { tag, title, parent, rank };
}

function goalsOf(...list: readonly SweepGoal[]): ReadonlyMap<string, SweepGoal> {
  return new Map(list.map((item) => [item.tag, item]));
}

const GOALS = goalsOf(
  goal('G1', 'Ship the payments checkout flow', 1),
  goal('K1', 'Checkout latency under budget', null, 'G1'),
  goal('G2', 'Mobile onboarding funnel', 2),
  goal('G3', 'Unranked archive cleanup work', null),
);

const NOW = Date.parse('2030-02-01T09:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * MS_PER_DAY).toISOString();
}

function input(overrides: Partial<SweepInput> = {}): SweepInput {
  return { team: 'alpha', focus: FOCUS, goals: GOALS, ownerSource: 'owner', now: NOW, sizeOf: () => 0.3, needed: () => false, ...overrides };
}

function row(overrides: Partial<SweepRow> = {}): SweepRow {
  return {
    id: 'T1',
    team: 'alpha',
    owner: 'alpha',
    title: 'A task',
    class: 'Roadmap',
    objective: 'G1',
    size: 0.5,
    proposedSize: 0.3,
    reason: 'serves ranked goal G1 (#1)',
    confidence: 'high',
    park: false,
    confirm: 'yes',
    ...overrides,
  };
}

/** A task the park rule would take: a stored Improvements class, open, quiet past the limit, nothing holding it. */
function parkable(overrides: Partial<Task> = {}): Task {
  return testTask({ workClass: 'Improvements', updatedAt: daysAgo(15), ...overrides });
}

describe('titleWords', () => {
  it('keeps words of four letters or more, lower case, without stop words', () => {
    assert.deepEqual([...titleWords('Add the Payments API for each checkout')], ['payments', 'checkout']);
  });

  it('splits on any punctuation and keeps a word once', () => {
    assert.deepEqual([...titleWords('checkout-flow: checkout/flow')], ['checkout', 'flow']);
  });
});

describe('proposalOf', () => {
  it('keeps a stored class over every rule, as a high-confidence row', () => {
    const task = testTask({ workClass: 'Improvements', critical: true, goals: ['G1'] });
    assert.deepEqual(proposalOf(task, input()), { class: 'Improvements', objective: 'G1', reason: 'class already set', confidence: 'high' });
  });

  it('gives no objective to a stored class with no ranked goal', () => {
    assert.equal(proposalOf(testTask({ workClass: 'Maintenance' }), input()).objective, null);
  });

  it('reads a ranked goal on the task as Roadmap, high', () => {
    assert.deepEqual(proposalOf(testTask({ goals: ['G2'] }), input()), { class: 'Roadmap', objective: 'G2', reason: 'serves ranked goal G2 (#2)', confidence: 'high' });
  });

  it('reads a ranked ancestor of the task\'s goal as Roadmap, naming the ancestor', () => {
    const proposal = proposalOf(testTask({ goals: ['K1'] }), input());
    assert.equal(proposal.class, 'Roadmap');
    assert.equal(proposal.objective, 'G1');
  });

  it('takes the best rank when the task serves two ranked goals', () => {
    assert.equal(proposalOf(testTask({ goals: ['G2', 'G1'] }), input()).objective, 'G1');
  });

  it('puts a ranked goal ahead of the upkeep signs', () => {
    assert.equal(proposalOf(testTask({ goals: ['G1'], type: 'bug', critical: true }), input()).class, 'Roadmap');
  });

  it('does not count an unranked goal as Roadmap', () => {
    assert.equal(proposalOf(testTask({ goals: ['G3'], title: 'Tidy it' }), input()).class, 'Improvements');
  });

  describe('a tag with no goal record', () => {
    const TIDY = 'Tidy it';
    const nearestNote = (tag: string, record: string) => `; tag ${tag} has no record, nearest is ${record}`;

    it('reads as its nearest record: Roadmap at medium, as only the tag name links them', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G2a'] }), input()), { class: 'Roadmap', objective: 'G2', reason: `serves ranked goal G2 (#2)${nearestNote('G2a', 'G2')}`, confidence: 'medium' });
    });

    it('names the nearest record, not the ranked goal above it, so a later rank on that record counts', () => {
      const proposal = proposalOf(testTask({ goals: ['K1a'] }), input());
      assert.equal(proposal.objective, 'K1');
      assert.equal(proposal.reason, `serves ranked goal G1 (#1)${nearestNote('K1a', 'K1')}`);
    });

    it('takes the longest record the tag sits under', () => {
      const goals = goalsOf(goal('K1', 'One', 1), goal('K1.2', 'Two', 2, 'K1'));
      assert.equal(proposalOf(testTask({ goals: ['K1.2a'] }), input({ goals })).objective, 'K1.2');
    });

    for (const tag of ['G2.x', 'G2-x', 'G2a']) {
      it(`counts ${tag} as under G2`, () => {
        assert.equal(proposalOf(testTask({ goals: [tag] }), input()).objective, 'G2');
      });
    }

    for (const [tag, record] of [['G10', 'G1'], ['Abc', 'Ab'], ['A2', 'A']] as const) {
      it(`never counts ${tag} as under ${record}, a goal of its own`, () => {
        const proposal = proposalOf(testTask({ goals: [tag], title: TIDY }), input({ goals: goalsOf(goal(record, 'One', 1)) }));
        assert.deepEqual([proposal.class, proposal.objective], ['Improvements', null]);
      });
    }

    it('leaves a tag with no record above it', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['Z9'], title: TIDY }), input()), { class: 'Improvements', objective: null, reason: 'no ranked goal, no upkeep sign', confidence: 'medium' });
    });

    it('proposes an unranked record too, so a rank given later reaches the task', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G3a'], title: TIDY }), input()), { class: 'Improvements', objective: 'G3', reason: `no ranked goal, no upkeep sign${nearestNote('G3a', 'G3')}`, confidence: 'medium' });
    });

    it('names the record on an upkeep row, the class still upkeep', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G3a'], type: 'bug' }), input()), { class: 'Maintenance', objective: 'G3', reason: `a bug${nearestNote('G3a', 'G3')}`, confidence: 'medium' });
    });

    it('names the record beside a stored class, which stays high', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G2a'], workClass: 'Improvements' }), input()), { class: 'Improvements', objective: 'G2', reason: `class already set${nearestNote('G2a', 'G2')}`, confidence: 'high' });
    });

    it('has nothing to add once the task names the record, as on a rerun after apply', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G2a', 'G2'] }), input()), { class: 'Roadmap', objective: 'G2', reason: 'serves ranked goal G2 (#2)', confidence: 'high' });
    });

    it('takes a better rank named outright over a nearest record', () => {
      assert.deepEqual(proposalOf(testTask({ goals: ['G1', 'G2a'] }), input()), { class: 'Roadmap', objective: 'G1', reason: 'serves ranked goal G1 (#1)', confidence: 'high' });
    });

    it('takes the better rank through a nearest record over one named outright', () => {
      assert.equal(proposalOf(testTask({ goals: ['G2', 'K1a'] }), input()).objective, 'K1');
    });

    it('leaves a title match its ranked goal, as an unranked record would leave a Roadmap row with no rank', () => {
      assert.equal(proposalOf(testTask({ goals: ['G3a'], title: 'Payments checkout rewrite' }), input()).objective, 'G1');
    });
  });

  it('survives a goal chain that loops', () => {
    const looped = goalsOf(goal('G8', 'One', null, 'G9'), goal('G9', 'Two', null, 'G8'));
    assert.equal(proposalOf(testTask({ goals: ['G8'], title: 'Tidy it' }), input({ goals: looped })).class, 'Improvements');
  });

  it('reads a critical task as Maintenance, high', () => {
    assert.deepEqual(proposalOf(testTask({ critical: true }), input()), { class: 'Maintenance', objective: null, reason: 'marked critical', confidence: 'high' });
  });

  it('reads a bug as Maintenance, medium', () => {
    assert.deepEqual(proposalOf(testTask({ type: 'bug' }), input()), { class: 'Maintenance', objective: null, reason: 'a bug', confidence: 'medium' });
  });

  for (const word of ['incident', 'outage', 'security', 'exposure', 'leak', 'data loss', 'backup', 'restore']) {
    it(`reads the title word "${word}" as Maintenance, medium`, () => {
      const proposal = proposalOf(testTask({ title: `Follow up the ${word} from Monday` }), input());
      assert.equal(proposal.class, 'Maintenance');
      assert.equal(proposal.confidence, 'medium');
      assert.equal(proposal.reason, `title says ${word}`);
    });
  }

  it('reads a plural and a capital in the upkeep words', () => {
    assert.equal(proposalOf(testTask({ title: 'Nightly Backups fail' }), input()).reason, 'title says backup');
  });

  it('does not read an upkeep word inside a longer word', () => {
    assert.equal(proposalOf(testTask({ title: 'Insecurity training leaky' }), input()).class, 'Improvements');
  });

  it('puts the upkeep words ahead of a title match', () => {
    assert.equal(proposalOf(testTask({ title: 'Payments checkout outage' }), input()).class, 'Maintenance');
  });

  it('reads two title words shared with a ranked goal as Roadmap, low', () => {
    assert.deepEqual(proposalOf(testTask({ title: 'Retry the payments checkout call' }), input()), {
      class: 'Roadmap',
      objective: 'G1',
      reason: 'title shares payments, checkout with goal G1',
      confidence: 'low',
    });
  });

  it('holds one shared word as chance', () => {
    assert.equal(proposalOf(testTask({ title: 'Retry the checkout call' }), input()).class, 'Improvements');
  });

  it('matches no unranked goal by title', () => {
    assert.equal(proposalOf(testTask({ title: 'Archive cleanup pass' }), input()).class, 'Improvements');
  });

  it('takes the goal sharing the most words, whatever its rank', () => {
    const goals = goalsOf(goal('G1', 'Alpha beta words', 1), goal('G2', 'Alpha beta gamma', 2));
    assert.equal(proposalOf(testTask({ title: 'Alpha beta gamma pass' }), input({ goals })).objective, 'G2');
  });

  it('breaks a tie of shared words by the better rank', () => {
    const goals = goalsOf(goal('G2', 'Alpha beta second', 2), goal('G1', 'Alpha beta first', 1));
    assert.equal(proposalOf(testTask({ title: 'Alpha beta pass' }), input({ goals })).objective, 'G1');
  });

  it('falls back to the default class, medium, with no objective', () => {
    assert.deepEqual(proposalOf(testTask({ title: 'Tidy the notes' }), input()), { class: 'Improvements', objective: null, reason: 'no ranked goal, no upkeep sign', confidence: 'medium' });
  });

  it('spells the classes as the team names them', () => {
    const focus: SweepFocus = { roadmapClass: 'Plan', maintenanceClass: 'Care', defaultClass: 'Rest', parkAfterDays: 14 };
    assert.equal(proposalOf(testTask({ goals: ['G1'] }), input({ focus })).class, 'Plan');
    assert.equal(proposalOf(testTask({ type: 'bug' }), input({ focus })).class, 'Care');
    assert.equal(proposalOf(testTask({ title: 'Tidy it' }), input({ focus })).class, 'Rest');
  });
});

describe('wouldPark', () => {
  it('parks a quiet, open, stored Improvements task', () => {
    assert.equal(wouldPark(parkable(), input()), true);
  });

  it('parks at exactly the limit', () => {
    assert.equal(wouldPark(parkable({ updatedAt: daysAgo(14) }), input()), true);
  });

  it('never parks a null class, however quiet', () => {
    assert.equal(wouldPark(parkable({ workClass: null }), input()), false);
  });

  it('never parks a Roadmap or a Maintenance class', () => {
    assert.equal(wouldPark(parkable({ workClass: 'Roadmap' }), input()), false);
    assert.equal(wouldPark(parkable({ workClass: 'Maintenance' }), input()), false);
  });

  it('parks a team\'s own Improvements-like class', () => {
    assert.equal(wouldPark(parkable({ workClass: 'Chores' }), input()), true);
  });

  for (const status of ['in-progress', 'waiting', 'verifying'] as const) {
    it(`leaves a ${status} task`, () => {
      assert.equal(wouldPark(parkable({ status }), input()), false);
    });
  }

  it('leaves a task with an event inside the limit', () => {
    assert.equal(wouldPark(parkable({ updatedAt: daysAgo(13) }), input()), false);
  });

  it('leaves a pinned task', () => {
    assert.equal(wouldPark(parkable({ pin: 'lead' }), input()), false);
  });

  it('leaves a critical task', () => {
    assert.equal(wouldPark(parkable({ critical: true }), input()), false);
  });

  it('leaves an owner-sourced task, by the team\'s own source name', () => {
    assert.equal(wouldPark(parkable({ source: 'boss' }), input({ ownerSource: 'boss' })), false);
  });

  it('leaves a task an active task needs', () => {
    assert.equal(wouldPark(parkable({ id: 'T7' }), input({ needed: (id) => id === 'T7' })), false);
  });
});

describe('proposeRow', () => {
  it('fills every column, confirm empty', () => {
    const task = testTask({ id: 'T9', owner: 'beta', title: 'Open the shop', goals: ['G1'] });
    assert.deepEqual(proposeRow(task, input({ sizeOf: () => 1.2345 })), {
      id: 'T9',
      team: 'alpha',
      owner: 'beta',
      title: 'Open the shop',
      class: 'Roadmap',
      objective: 'G1',
      size: 1.23,
      proposedSize: 1.23,
      reason: 'serves ranked goal G1 (#1)',
      confidence: 'high',
      park: false,
      confirm: '',
    });
  });

  it('marks a task the park rule would take', () => {
    assert.equal(proposeRow(parkable(), input()).park, true);
  });
});

describe('sweepCounts', () => {
  it('counts rows per team and class, both by name', () => {
    const counts = sweepCounts([
      { team: 'beta', class: 'Roadmap' },
      { team: 'alpha', class: 'Roadmap' },
      { team: 'alpha', class: 'Improvements' },
      { team: 'alpha', class: 'Roadmap' },
    ]);
    assert.deepEqual(
      [...counts].map(([team, classes]) => [team, [...classes]]),
      [
        ['alpha', [['Improvements', 1], ['Roadmap', 2]]],
        ['beta', [['Roadmap', 1]]],
      ],
    );
  });
});

describe('isSweepRow', () => {
  it('takes a row and a row with null objective and size', () => {
    assert.equal(isSweepRow(row()), true);
    assert.equal(isSweepRow(row({ objective: null, size: null })), true);
  });

  const bad: readonly (readonly [string, unknown])[] = [
    ['a bad id', { ...row(), id: 'X1' }],
    ['a blank team', { ...row(), team: ' ' }],
    ['a blank owner', { ...row(), owner: '' }],
    ['a title as a number', { ...row(), title: 1 }],
    ['a blank class', { ...row(), class: '' }],
    ['a blank objective', { ...row(), objective: '' }],
    ['a zero size', { ...row(), size: 0 }],
    ['a size past the week', { ...row(), size: 101 }],
    ['a size as text', { ...row(), size: '1' }],
    ['no proposedSize', { ...row(), proposedSize: undefined }],
    ['a null proposedSize', { ...row(), proposedSize: null }],
    ['a proposedSize as text', { ...row(), proposedSize: '0.3' }],
    ['a proposedSize of 0', { ...row(), proposedSize: 0 }],
    ['a proposedSize over the week', { ...row(), proposedSize: 101 }],
    ['an unknown confidence', { ...row(), confidence: 'sure' }],
    ['a park as text', { ...row(), park: 'false' }],
    ['no confirm', { ...row(), confirm: null }],
    ['no record', 'T1'],
  ];
  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      assert.equal(isSweepRow(value), false);
    });
  }
});

describe('parseSweepFile', () => {
  it('reads back what formatSweepRows wrote', () => {
    const rows = [row(), row({ id: 'T2', objective: null })];
    assert.deepEqual(parseSweepFile(formatSweepRows(rows)), { ok: true, value: rows });
  });

  it('skips blank lines and takes CRLF endings', () => {
    assert.deepEqual(parseSweepFile(`\r\n${JSON.stringify(row())}\r\n\r\n`), { ok: true, value: [row()] });
  });

  it('reads an empty file as no rows', () => {
    assert.deepEqual(parseSweepFile(''), { ok: true, value: [] });
  });

  it('refuses the whole file on a line that is not JSON, naming the line', () => {
    const verdict = parseSweepFile(`${JSON.stringify(row())}\n{broken\n`);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.error, /^line 2 is not JSON/);
  });

  it('refuses the whole file on a line that is no row', () => {
    const verdict = parseSweepFile(`${JSON.stringify({ id: 'T1' })}\n`);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.error, /^line 1 is not a sweep row/);
  });

  it('refuses the whole file on a row an older sweep wrote, saying to sweep again (T2114)', () => {
    const verdict = parseSweepFile(`${JSON.stringify(row())}\n${JSON.stringify({ ...row({ id: 'T2' }), proposedSize: undefined })}\n`);
    assert.deepEqual(verdict, { ok: false, error: 'line 2 holds no proposedSize, so an older version wrote it: sweep again on this version' });
  });

  it('calls a row with a bad proposedSize no sweep row, as an older sweep did not write it (T2114)', () => {
    const verdict = parseSweepFile(`${JSON.stringify(row({ proposedSize: 0 }))}\n`);
    assert.match(verdict.ok ? '' : verdict.error, /^line 1 is not a sweep row/);
  });

  it('refuses a task named twice', () => {
    const verdict = parseSweepFile(formatSweepRows([row(), row({ confirm: '' })]));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.error, /^line 2 repeats alpha\/T1/);
  });

  it('takes one id in two teams', () => {
    assert.equal(parseSweepFile(formatSweepRows([row(), row({ team: 'beta' })])).ok, true);
  });
});

describe('changesOf', () => {
  const target = { workClass: null, goals: [], status: 'open', size: null } as const;

  it('writes every field a row holds new', () => {
    assert.deepEqual(changesOf(row(), target, GOALS), { workClass: 'Roadmap', goals: ['G1'], size: 0.5 });
  });

  it('adds the objective after the tags the task holds', () => {
    assert.deepEqual(changesOf(row({ objective: 'G2' }), { ...target, goals: ['G3'] }, GOALS).goals, ['G3', 'G2']);
  });

  it('adds no tag the task already holds', () => {
    assert.equal(changesOf(row(), { ...target, goals: ['G1'] }, GOALS).goals, undefined);
  });

  it('adds no tag for a goal the task serves through a key result', () => {
    assert.equal(changesOf(row(), { ...target, goals: ['K1'] }, GOALS).goals, undefined);
  });

  it('keeps a tag with no record and adds its nearest record beside it', () => {
    assert.deepEqual(changesOf(row({ objective: 'G2' }), { ...target, goals: ['G2a'] }, GOALS).goals, ['G2a', 'G2']);
  });

  it('leaves the goals on a null objective and the size on a null size', () => {
    assert.deepEqual(changesOf(row({ objective: null, size: null }), target, GOALS), { workClass: 'Roadmap' });
  });

  it('holds nothing when the task already matches', () => {
    assert.deepEqual(changesOf(row(), { workClass: 'Roadmap', goals: ['G1'], status: 'open', size: 0.5 }, GOALS), {});
  });

  it('holds no size for a row still at its proposal, so a median or floor size stays live (T2114)', () => {
    assert.equal(changesOf(row({ size: 0.12, proposedSize: 0.12 }), target, GOALS).size, undefined);
  });

  it('leaves a size stored since the sweep to a row still at its proposal (T2114)', () => {
    assert.equal(changesOf(row({ size: 0.12, proposedSize: 0.12 }), { ...target, size: 0.7 }, GOALS).size, undefined);
  });

  it('holds the size a person corrected the row to (T2114)', () => {
    assert.equal(changesOf(row({ size: 0.13, proposedSize: 0.12 }), target, GOALS).size, 0.13);
  });

  it('holds no size a person corrected to once the task stores it, so a second apply changes nothing (T2114)', () => {
    assert.equal(changesOf(row({ size: 0.13, proposedSize: 0.12 }), { ...target, size: 0.13 }, GOALS).size, undefined);
  });
});

describe('planSweepRow', () => {
  const task = { workClass: null, goals: [], status: 'open', size: null } as const;
  const allow = (): undefined => undefined;

  it('leaves a row with any confirm but yes, before reading the task', () => {
    assert.deepEqual(planSweepRow(row({ confirm: '' }), undefined, GOALS, allow).action, 'unconfirmed');
    assert.deepEqual(planSweepRow(row({ confirm: 'YES' }), task, GOALS, allow).action, 'unconfirmed');
  });

  it('refuses a task the register lacks', () => {
    assert.deepEqual(planSweepRow(row(), undefined, GOALS, allow), { row: row(), action: 'refused', reason: 'no task T1 in team alpha' });
  });

  it('refuses a task finished since the sweep', () => {
    assert.deepEqual(planSweepRow(row(), { ...task, status: 'done' }, GOALS, allow), { row: row(), action: 'refused', reason: 'T1 is done now' });
  });

  it('counts a row with nothing new as unchanged, without asking the judge', () => {
    const plan = planSweepRow(row(), { workClass: 'Roadmap', goals: ['G1'], status: 'open', size: 0.5 }, GOALS, () => 'never asked');
    assert.equal(plan.action, 'unchanged');
  });

  it('counts a row still at its proposal on a task with no stored size as unchanged (T2114)', () => {
    const still = row({ proposedSize: 0.5 });
    assert.deepEqual(planSweepRow(still, { workClass: 'Roadmap', goals: ['G1'], status: 'open', size: null }, GOALS, allow), { row: still, action: 'unchanged' });
  });

  it('plans a change the judge allows', () => {
    assert.deepEqual(planSweepRow(row(), task, GOALS, allow), { row: row(), action: 'change', changes: { workClass: 'Roadmap', goals: ['G1'], size: 0.5 } });
  });

  it('hands the judge the task and the changes and refuses with its reason', () => {
    const seen: unknown[] = [];
    const plan = planSweepRow(row(), task, GOALS, (judged, changes) => {
      seen.push(judged, changes);
      return 'not your task';
    });
    assert.deepEqual(plan, { row: row(), action: 'refused', reason: 'not your task' });
    assert.deepEqual(seen, [task, { workClass: 'Roadmap', goals: ['G1'], size: 0.5 }]);
  });
});

describe('refusedPlan', () => {
  it('refuses a confirmed row with the reason', () => {
    assert.deepEqual(refusedPlan(row(), 'closed'), { row: row(), action: 'refused', reason: 'closed' });
  });

  it('counts a row nobody confirmed as unconfirmed, not as a refusal', () => {
    assert.deepEqual(refusedPlan(row({ confirm: '' }), 'closed'), { row: row({ confirm: '' }), action: 'unconfirmed' });
  });
});

describe('countLines', () => {
  it('prints a line per team, its classes by name', () => {
    const rows = [
      { team: 'beta', class: 'Roadmap' },
      { team: 'alpha', class: 'Roadmap' },
      { team: 'alpha', class: 'Improvements' },
      { team: 'alpha', class: 'Improvements' },
    ];
    assert.deepEqual(countLines(rows), ['alpha: Improvements 2, Roadmap 1', 'beta: Roadmap 1']);
  });

  it('prints nothing for no rows', () => {
    assert.deepEqual(countLines([]), []);
  });
});

describe('tallyText', () => {
  it('prints the three counts a clean run holds', () => {
    assert.equal(tallyText({ inserted: 0, changed: 2, unchanged: 1, unconfirmed: 0, refused: 0 }), 'inserted 0, changed 2, unchanged 1');
  });

  it('adds the rows left and refused when there are some', () => {
    assert.equal(tallyText({ inserted: 0, changed: 0, unchanged: 0, unconfirmed: 3, refused: 1 }), 'inserted 0, changed 0, unchanged 0, unconfirmed 3, refused 1');
  });
});

describe('planLine', () => {
  const changed: SweepPlan = { row: row(), action: 'change', changes: { size: 1 } };

  it('says a dry run would change what a write changed', () => {
    assert.equal(planLine(changed, false), 'WOULD CHANGE alpha/T1: size 1');
    assert.equal(planLine(changed, true), 'CHANGED alpha/T1: size 1');
  });

  it('names a refused row and why, either way', () => {
    assert.equal(planLine({ row: row(), action: 'refused', reason: 'no' }, true), 'REFUSED alpha/T1: no');
  });

  it('gives a row left alone no line', () => {
    assert.equal(planLine({ row: row(), action: 'unchanged' }, true), undefined);
    assert.equal(planLine({ row: row(), action: 'unconfirmed' }, false), undefined);
  });
});

describe('tallyOf', () => {
  it('counts each fate, inserted always 0', () => {
    const plans: readonly SweepPlan[] = [
      { row: row(), action: 'change', changes: { size: 1 } },
      { row: row(), action: 'change', changes: { size: 2 } },
      { row: row(), action: 'unchanged' },
      { row: row(), action: 'unconfirmed' },
      { row: row(), action: 'refused', reason: 'no' },
    ];
    assert.deepEqual(tallyOf(plans), { inserted: 0, changed: 2, unchanged: 1, unconfirmed: 1, refused: 1 });
  });
});

describe('changesText', () => {
  it('names each field a change writes', () => {
    assert.equal(changesText({ workClass: 'Roadmap', goals: ['G1', 'G2'], size: 0.5 }), 'class Roadmap, goals G1,G2, size 0.5');
  });

  it('names only what is there', () => {
    assert.equal(changesText({ size: 2 }), 'size 2');
  });
});
