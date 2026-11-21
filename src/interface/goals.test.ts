import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import type { Goal, GoalSlip } from '../register/goals.ts';
import { cutText, goalsBody, type GoalsBody, type HeldGoals, type ServedGoal } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

function goal(tag: string, changes: Partial<Goal> = {}): Goal {
  return {
    tag,
    title: `Goal ${tag}`,
    start: '2030-01-08',
    target: '2030-02-01',
    parent: null,
    addedAt: '2030-01-08T08:00:00.000Z',
    addedBy: 'lead',
    slips: [],
    rank: null,
    slice: null,
    slices: [],
    ...changes,
  };
}

function slip(to: string, note: string): GoalSlip {
  return { at: '2030-01-09T08:00:00.000Z', by: 'lead', from: '2030-02-01', to, note };
}

function body(...held: HeldGoals[]): GoalsBody {
  return goalsBody({ held, shapes: new SecretScanner() });
}

function servedOf(answer: GoalsBody, tag: string): ServedGoal {
  const found = answer.goals.find((candidate) => candidate.tag === tag);
  assert.ok(found !== undefined, `${tag} is served`);
  return found;
}

describe('goalsBody', () => {
  it('serves a goal with its team, window, parent, rank, open slice and every move of its target', () => {
    const moved = slip('2030-02-10', 'the audit took a week');
    const answer = body({ team: 'app', goals: [goal('A1'), goal('A1.1', { parent: 'A1', rank: 2, slice: 3, target: '2030-02-10', slips: [moved] })] });
    assert.deepEqual(servedOf(answer, 'A1'), {
      tag: 'A1',
      team: 'app',
      title: 'Goal A1',
      parent: null,
      rank: null,
      slice: null,
      start: '2030-01-08',
      target: '2030-02-01',
      slips: [],
    });
    assert.deepEqual(servedOf(answer, 'A1.1'), {
      tag: 'A1.1',
      team: 'app',
      title: 'Goal A1.1',
      parent: 'A1',
      rank: 2,
      slice: 3,
      start: '2030-01-08',
      target: '2030-02-10',
      slips: [moved],
    });
    assert.deepEqual(answer.cuts, []);
  });

  it('puts the ranked goals first by rank, then the others by tag, whichever team holds them', () => {
    const answer = body({ team: 'app', goals: [goal('C1'), goal('B1', { rank: 2 })] }, { team: 'web', goals: [goal('A9'), goal('Z1', { rank: 1 }), goal('A2', { rank: 2 })] });
    assert.deepEqual(
      answer.goals.map((served) => [served.tag, served.team]),
      [
        ['Z1', 'web'],
        ['A2', 'web'],
        ['B1', 'app'],
        ['A9', 'web'],
        ['C1', 'app'],
      ],
    );
  });

  it('serves a tag two teams hold once, as the nearer team’s goal', () => {
    const answer = body({ team: 'app', goals: [goal('A1', { title: 'The root’s', rank: 1 })] }, { team: 'web', goals: [goal('A1', { title: 'The nearer team’s' })] });
    assert.deepEqual(
      answer.goals.map((served) => [served.tag, served.team, served.title, served.rank]),
      [['A1', 'web', 'The nearer team’s', null]],
    );
  });

  it('serves a slip’s time as the instant it reads as, never as a stored text with words in it', () => {
    const worded: GoalSlip = { ...slip('2030-02-10', 'a plain note'), at: `Jan 9 2030 08:00 UTC (${SECRET})` };
    const answer = body({ team: 'app', goals: [goal('A1', { slips: [worded] })] });
    assert.deepEqual(servedOf(answer, 'A1').slips.map((moved) => moved.at), ['2030-01-09T08:00:00.000Z']);
    assert.ok(!JSON.stringify(answer).includes(SECRET));
  });

  it('cuts a title or a note shaped like a secret, and names the goal and the field', () => {
    const shape = new SecretScanner().find(SECRET)?.description;
    assert.ok(shape !== undefined, 'the shipped shapes know the test secret');
    const answer = body({ team: 'app', goals: [goal('A1', { title: SECRET }), goal('B1', { slips: [slip('2030-02-10', 'a plain note'), slip('2030-02-20', SECRET)] })] });
    assert.equal(servedOf(answer, 'A1').title, cutText(shape));
    assert.deepEqual(
      servedOf(answer, 'B1').slips.map((moved) => moved.note),
      ['a plain note', cutText(shape)],
    );
    assert.deepEqual(answer.cuts, [
      { id: 'A1', field: 'title', shape },
      { id: 'B1', field: 'slips.1.note', shape },
    ]);
    assert.ok(!JSON.stringify(answer).includes(SECRET));
  });

  it('serves no goal of no team', () => {
    assert.deepEqual(body(), { goals: [], cuts: [] });
  });
});
