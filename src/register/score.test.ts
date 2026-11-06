import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { TEST_FOCUS } from '../testing/ranking.ts';
import { bandOf, ownerOrderOf, scoreOf, sizePctOf, unblocksOf, urgencyOf, valueOf, type ScoreFacts, type ScoreFocus, type ValueFacts } from './score.ts';

const NOW = Date.UTC(2030, 0, 7, 9);

const FOCUS = TEST_FOCUS;

function value(facts: Partial<ValueFacts>, focus: ScoreFocus = FOCUS): number {
  return valueOf({ workClass: 'Roadmap', rank: null, type: null, critical: false, ...facts }, focus);
}

function facts(overrides: Partial<ScoreFacts> = {}): ScoreFacts {
  return {
    workClass: 'Roadmap',
    rank: null,
    type: null,
    critical: false,
    priority: 3,
    ownerSourced: false,
    dueAt: undefined,
    neededValue: undefined,
    sizing: { size: 1, spentPct: 0, likeMedianPct: undefined },
    ...overrides,
  };
}

describe('valueOf', () => {
  it('values a Roadmap task by its goal rank, a rank past the list taking the last', () => {
    assert.deepEqual([1, 2, 5, 6, 40].map((rank) => value({ rank })), [20, 16, 4, 4, 4]);
  });

  it('values a Roadmap task with no ranked goal at the unranked value', () => {
    assert.equal(value({ rank: null }), 3);
  });

  it('adds the bug and critical values to a Maintenance task', () => {
    const maintenance = { workClass: 'Maintenance' };
    assert.equal(value(maintenance), 10);
    assert.equal(value({ ...maintenance, type: 'task' }), 10);
    assert.equal(value({ ...maintenance, type: 'bug' }), 14);
    assert.equal(value({ ...maintenance, critical: true }), 20);
    assert.equal(value({ ...maintenance, type: 'bug', critical: true }), 24);
  });

  it('values any other class flat, whatever its rank or severity', () => {
    assert.equal(value({ workClass: 'Improvements', rank: 1, type: 'bug', critical: true }), 1);
    assert.equal(value({ workClass: 'Sideline' }), 1);
  });

  it('reads the class names from the config, not the default words', () => {
    const renamed = { ...FOCUS, roadmapClass: 'Product', maintenanceClass: 'Upkeep' };
    assert.equal(value({ workClass: 'Product', rank: 1 }, renamed), 20);
    assert.equal(value({ workClass: 'Upkeep', type: 'bug' }, renamed), 14);
    assert.equal(value({ workClass: 'Roadmap', rank: 1 }, renamed), 1);
  });
});

describe('urgencyOf', () => {
  it('adds nothing with no due, or one further off than the due-soon days', () => {
    assert.equal(urgencyOf(undefined, NOW, FOCUS.score), 0);
    assert.equal(urgencyOf(NOW + 3 * MS_PER_DAY + 1, NOW, FOCUS.score), 0);
  });

  it('adds the due-soon value up to and on the due itself', () => {
    assert.equal(urgencyOf(NOW + 3 * MS_PER_DAY, NOW, FOCUS.score), 4);
    assert.equal(urgencyOf(NOW, NOW, FOCUS.score), 4);
  });

  it('adds the overdue value past the due', () => {
    assert.equal(urgencyOf(NOW - 1, NOW, FOCUS.score), 8);
  });
});

describe('unblocksOf', () => {
  it('adds a share of the best value among the tasks that need it', () => {
    assert.equal(unblocksOf(20, FOCUS.score), 10);
    assert.equal(unblocksOf(undefined, FOCUS.score), 0);
  });
});

describe('ownerOrderOf', () => {
  it('adds the capped value of an owner-sourced priority', () => {
    assert.deepEqual([1, 2, 3, 5].map((priority) => ownerOrderOf({ priority, ownerSourced: true }, FOCUS.score)), [12, 6, 0, 0]);
  });

  it('adds nothing past the list, or for a task the owner did not order', () => {
    assert.equal(ownerOrderOf({ priority: 9, ownerSourced: true }, FOCUS.score), 0);
    assert.equal(ownerOrderOf({ priority: 1, ownerSourced: false }, FOCUS.score), 0);
  });
});

describe('sizePctOf', () => {
  it('takes the first known of size, the like median and the default', () => {
    assert.equal(sizePctOf({ size: 2, spentPct: 0, likeMedianPct: 7 }, FOCUS.score), 2);
    assert.equal(sizePctOf({ size: null, spentPct: 0, likeMedianPct: 7 }, FOCUS.score), 7);
    assert.equal(sizePctOf({ size: null, spentPct: 0, likeMedianPct: undefined }, FOCUS.score), 0.3);
  });

  it('takes what the task spent off each of them, as a started task ranks by the work left', () => {
    assert.equal(sizePctOf({ size: 2, spentPct: 0.5, likeMedianPct: 7 }, FOCUS.score), 1.5);
    assert.equal(sizePctOf({ size: null, spentPct: 5, likeMedianPct: 7 }, FOCUS.score), 2);
    assert.equal(sizePctOf({ size: null, spentPct: 0.25, likeMedianPct: undefined }, FOCUS.score), 0.05);
  });

  it('holds every source to the floor, a task past its size among them', () => {
    assert.equal(sizePctOf({ size: 0, spentPct: 0, likeMedianPct: undefined }, FOCUS.score), 0.05);
    assert.equal(sizePctOf({ size: null, spentPct: 0, likeMedianPct: 0.01 }, FOCUS.score), 0.05);
    assert.equal(sizePctOf({ size: 1, spentPct: 3, likeMedianPct: undefined }, FOCUS.score), 0.05);
    assert.equal(sizePctOf({ size: null, spentPct: 3, likeMedianPct: undefined }, FOCUS.score), 0.05);
  });
});

describe('bandOf', () => {
  it('puts critical Maintenance and an owner-sourced p1 in band 0', () => {
    assert.equal(bandOf(facts({ workClass: 'Maintenance', critical: true }), FOCUS), 0);
    assert.equal(bandOf(facts({ workClass: 'Improvements', priority: 1, ownerSourced: true }), FOCUS), 0);
  });

  it('puts a p0 in band 0 in any class, whoever asked, with both expedite arms off', () => {
    const noArms = { ...FOCUS, expedite: { critical: false, ownerP1: false } };
    assert.deepEqual(['Roadmap', 'Improvements', 'Sideline'].map((workClass) => bandOf(facts({ workClass, priority: 0 }), noArms)), [0, 0, 0]);
    assert.equal(bandOf(facts({ workClass: 'Improvements', priority: 0, ownerSourced: true }), FOCUS), 0);
  });

  it('turns each expedite arm off on its own', () => {
    const noCritical = { ...FOCUS, expedite: { critical: false, ownerP1: true } };
    const noOwner = { ...FOCUS, expedite: { critical: true, ownerP1: false } };
    assert.equal(bandOf(facts({ workClass: 'Maintenance', critical: true }), noCritical), 1);
    assert.equal(bandOf(facts({ workClass: 'Improvements', priority: 1, ownerSourced: true }), noOwner), 2);
  });

  it('leaves a critical task of another class and a p1 the owner did not order unexpedited', () => {
    assert.equal(bandOf(facts({ workClass: 'Roadmap', critical: true }), FOCUS), 1);
    assert.equal(bandOf(facts({ workClass: 'Roadmap', priority: 1 }), FOCUS), 1);
  });

  it('puts Roadmap and Maintenance in band 1, the rest in band 2', () => {
    assert.deepEqual(['Roadmap', 'Maintenance', 'Improvements', 'Sideline'].map((workClass) => bandOf(facts({ workClass }), FOCUS)), [1, 1, 2, 2]);
  });
});

describe('scoreOf', () => {
  it('sums the cost of delay and divides it by the size', () => {
    const scored = scoreOf(
      facts({ rank: 1, dueAt: NOW + MS_PER_DAY, neededValue: 16, priority: 2, ownerSourced: true, sizing: { size: 4, spentPct: 0, likeMedianPct: undefined } }),
      FOCUS,
      NOW,
    );
    assert.deepEqual(scored, { band: 1, score: 9.5, costOfDelay: 38, sizePct: 4 });
  });

  it('keeps two decimals and prints no trailing zero', () => {
    const sized = (size: number) => scoreOf(facts({ rank: 1, dueAt: NOW, sizing: { size, spentPct: 0, likeMedianPct: undefined } }), FOCUS, NOW).score;
    assert.equal(String(sized(1.125)), '21.33');
    assert.equal(String(sized(1.127)), '21.3');
  });

  it('scores a task of no size at the default and a zero size at the floor, never dividing by zero', () => {
    assert.equal(scoreOf(facts({ sizing: { size: null, spentPct: 0, likeMedianPct: undefined } }), FOCUS, NOW).score, 10);
    assert.equal(scoreOf(facts({ sizing: { size: 0, spentPct: 0, likeMedianPct: undefined } }), FOCUS, NOW).score, 60);
  });

  it('never lets a task fall as it spends: its score rises to the floor and stays there (T2109)', () => {
    const spent = (spentPct: number) => scoreOf(facts({ rank: 1, sizing: { size: null, spentPct, likeMedianPct: 2 } }), FOCUS, NOW).score;
    assert.deepEqual([0, 1, 1.5, 1.95, 2, 40].map(spent), [10, 20, 40, 400, 400, 400]);
  });

  it('ranks a small low-value task above a large high-value one by value per size', () => {
    const large = scoreOf(facts({ rank: 1, sizing: { size: 10, spentPct: 0, likeMedianPct: undefined } }), FOCUS, NOW);
    const small = scoreOf(facts({ rank: 5, sizing: { size: 0.5, spentPct: 0, likeMedianPct: undefined } }), FOCUS, NOW);
    assert.ok(small.score > large.score, `${small.score} > ${large.score}`);
  });
});
