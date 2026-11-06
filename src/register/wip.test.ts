import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { waitContext } from './waits.ts';
import { wipHold, type WipFocus } from './wip.ts';

const NOW = new Date(Date.UTC(2030, 0, 7, 9));

const FOCUS: WipFocus = {
  roadmapClass: 'Roadmap',
  maintenanceClass: 'Maintenance',
  defaultClass: 'Improvements',
  expedite: { critical: true, ownerP1: true },
  wip: { mode: 'refuse', maxInProgress: 3 },
};

const OWNER = 'owner';

const TOOLING = testTask({ id: 'T9', workClass: 'Improvements' });
const ROADMAP = testTask({ id: 'T1', workClass: 'Roadmap' });

/** What the rule says of a start of `task`, with the other tasks of the register beside it. */
function holdOf(task: Task, others: readonly Task[], focus: WipFocus = FOCUS, oneCommit = false, spentClasses: ReadonlySet<string> = new Set()): string | undefined {
  const tasks = [task, ...others];
  const context = waitContext(new Map(tasks.map((held) => [held.id, held])), NOW, TimeZone.UTC);
  return wipHold({ task, status: 'in-progress', oneCommit, spentClasses }, tasks, context, focus, OWNER);
}

/** `count` tasks of `alpha` in progress, T101 up. */
function inProgress(count: number): Task[] {
  return Array.from({ length: count }, (_, index) => testTask({ id: `T${101 + index}`, status: 'in-progress', workClass: 'Maintenance' }));
}

describe('wipHold: a class that has spent its share of the week', () => {
  const SPENT: ReadonlySet<string> = new Set(['Improvements']);

  /** What the rule says of a start of `task` with Improvements spent and nothing else on its owner's list. */
  const spentHoldOf = (task: Task, focus: WipFocus = FOCUS, oneCommit = false): string | undefined => holdOf(task, [], focus, oneCommit, SPENT);

  it('holds the start with no Roadmap work to go first, naming the share, the reset and the way past', () => {
    assert.equal(
      spentHoldOf(TOOLING),
      "T9 is Improvements work and Improvements has spent its share of the week [focus.allocation]: it waits for the week's reset, or, for a one-commit fix, start it with --one-commit",
    );
  });

  it('says so ahead of the Roadmap work, as finishing that would not free the start', () => {
    assert.match(holdOf(TOOLING, [ROADMAP], FOCUS, false, SPENT) ?? '', /has spent its share/);
  });

  it('holds a task no one classed, which counts as the default class', () => {
    assert.match(spentHoldOf(testTask({ id: 'T9' })) ?? '', /^T9 is Improvements work and Improvements has spent/);
  });

  it('leaves a class that has share left alone', () => {
    assert.equal(holdOf(testTask({ id: 'T9', workClass: 'Research' }), [], FOCUS, false, SPENT), undefined);
  });

  it('holds nothing when the caller gave no spent classes', () => {
    const context = waitContext(new Map([[TOOLING.id, TOOLING]]), NOW, TimeZone.UTC);
    assert.equal(wipHold({ task: TOOLING, status: 'in-progress' }, [TOOLING], context, FOCUS, OWNER), undefined);
  });

  it('holds no Roadmap or Maintenance start past its share: the share is a limit on Improvements work alone', () => {
    const spent = new Set(['Roadmap', 'Maintenance']);
    assert.equal(holdOf({ ...TOOLING, workClass: 'Roadmap' }, [], FOCUS, false, spent), undefined);
    assert.equal(holdOf({ ...TOOLING, workClass: 'Maintenance' }, [], FOCUS, false, spent), undefined);
  });

  it('lets --one-commit, an expedited task and an owner-sourced task through', () => {
    assert.equal(spentHoldOf(TOOLING, FOCUS, true), undefined);
    assert.equal(spentHoldOf({ ...TOOLING, priority: 0 }), undefined);
    assert.equal(spentHoldOf({ ...TOOLING, source: OWNER }), undefined);
  });

  it('holds nothing with the rule off', () => {
    assert.equal(spentHoldOf(TOOLING, { ...FOCUS, wip: { mode: 'off', maxInProgress: 3 } }), undefined);
  });
});

describe('wipHold: Improvements work behind Roadmap work that can move', () => {
  it('holds the start, naming the Roadmap task and the way past', () => {
    assert.equal(
      holdOf(TOOLING, [ROADMAP]),
      'T9 is Improvements work and alpha holds Roadmap work that can move: T1; work that first [focus.wip], or, for a one-commit fix, start it with --one-commit',
    );
  });

  it('holds a task no one classed, which counts as the default class', () => {
    assert.match(holdOf(testTask({ id: 'T9' }), [ROADMAP]) ?? '', /^T9 is Improvements work/);
  });

  it('holds any class that is neither Roadmap nor Maintenance', () => {
    assert.match(holdOf(testTask({ id: 'T9', workClass: 'Research' }), [ROADMAP]) ?? '', /^T9 is Research work/);
  });

  it('counts a Roadmap task in progress as able to move', () => {
    assert.match(holdOf(TOOLING, [{ ...ROADMAP, status: 'in-progress' }]) ?? '', /can move: T1;/);
  });

  it('names three Roadmap tasks, then counts the rest', () => {
    const roadmap = ['T1', 'T2', 'T3', 'T4', 'T5'].map((id) => ({ ...ROADMAP, id }));
    assert.match(holdOf(TOOLING, roadmap) ?? '', /can move: T1, T2, T3 and 2 more;/);
  });

  it('leaves a Roadmap or Maintenance start alone', () => {
    assert.equal(holdOf({ ...TOOLING, workClass: 'Roadmap' }, [ROADMAP]), undefined);
    assert.equal(holdOf({ ...TOOLING, workClass: 'Maintenance' }, [ROADMAP]), undefined);
  });

  it('reads the class names of the config, as a team may rename them', () => {
    const renamed: WipFocus = { ...FOCUS, roadmapClass: 'Bets', maintenanceClass: 'Upkeep', defaultClass: 'Chores' };
    assert.equal(holdOf(testTask({ id: 'T9' }), [ROADMAP], renamed), undefined);
    assert.match(holdOf(testTask({ id: 'T9' }), [{ ...ROADMAP, workClass: 'Bets' }], renamed) ?? '', /^T9 is Chores work and alpha holds Bets work/);
  });

  describe('Roadmap work that cannot move holds nothing', () => {
    const cases: readonly (readonly [string, Task, readonly Task[]])[] = [
      ['waiting', { ...ROADMAP, status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }] }, []],
      ['verifying', { ...ROADMAP, status: 'verifying' }, []],
      ['done', { ...ROADMAP, status: 'done' }, []],
      ['dropped', { ...ROADMAP, status: 'dropped' }, []],
      ['open with a wait left on it', { ...ROADMAP, waits: [{ kind: 'task', id: 'T7' }] }, [testTask({ id: 'T7', owner: 'bravo' })]],
      ['waiting on a wait that cleared, until its owner sets the next status', { ...ROADMAP, status: 'waiting', waits: [{ kind: 'task', id: 'T7' }] }, [testTask({ id: 'T7', owner: 'bravo', status: 'done' })]],
      ['planned after a task not finished', { ...ROADMAP, after: ['T2'] }, [testTask({ id: 'T2', owner: 'bravo' })]],
      ["another session's", { ...ROADMAP, owner: 'bravo' }, []],
    ];
    for (const [name, roadmap, rest] of cases) {
      it(name, () => assert.equal(holdOf(TOOLING, [roadmap, ...rest]), undefined));
    }
  });

  it('holds once every task the Roadmap task comes after is finished', () => {
    const needed = testTask({ id: 'T2', owner: 'bravo', status: 'done' });
    assert.match(holdOf(TOOLING, [{ ...ROADMAP, after: ['T2'] }, needed]) ?? '', /can move: T1;/);
  });
});

describe('wipHold: the in-progress limit', () => {
  it('holds a start at the limit, naming what to finish or put back', () => {
    assert.equal(
      holdOf(ROADMAP, inProgress(3)),
      'alpha already has 3 tasks in progress, at the limit of 3 [focus.wip.maxInProgress]: finish T101, T102, T103 or put one back (--status open) before T1, or, for a one-commit fix, start it with --one-commit',
    );
  });

  it('lets the start that reaches the limit through', () => {
    assert.equal(holdOf(ROADMAP, inProgress(2)), undefined);
  });

  it('holds every class alike', () => {
    assert.match(holdOf({ ...ROADMAP, workClass: 'Maintenance' }, inProgress(3)) ?? '', /^alpha already has 3 tasks/);
    assert.match(holdOf(TOOLING, inProgress(3)) ?? '', /^alpha already has 3 tasks/);
  });

  it("counts only the owner's own tasks in progress", () => {
    assert.equal(holdOf(ROADMAP, inProgress(3).map((task) => ({ ...task, owner: 'bravo' }))), undefined);
  });

  it('counts no status but in-progress', () => {
    assert.equal(holdOf(ROADMAP, inProgress(3).map((task) => ({ ...task, status: 'verifying' }))), undefined);
  });

  it('reads the limit from the config', () => {
    assert.equal(holdOf(ROADMAP, inProgress(3), { ...FOCUS, wip: { mode: 'refuse', maxInProgress: 4 } }), undefined);
    assert.match(holdOf(ROADMAP, inProgress(1), { ...FOCUS, wip: { mode: 'refuse', maxInProgress: 1 } }) ?? '', /^alpha already has 1 tasks in progress, at the limit of 1/);
  });

  it('names three tasks past a long list, then counts the rest', () => {
    assert.match(holdOf(ROADMAP, inProgress(5)) ?? '', /finish T101, T102, T103 and 2 more or put one back/);
  });

  it('says the Roadmap hold first when both hold', () => {
    assert.match(holdOf(TOOLING, [ROADMAP, ...inProgress(3)]) ?? '', /^T9 is Improvements work/);
  });
});

describe('wipHold: what is exempt', () => {
  const heldBoth = [ROADMAP, ...inProgress(3)];

  it('passes --one-commit past both holds', () => {
    assert.equal(holdOf(TOOLING, heldBoth, FOCUS, true), undefined);
  });

  it('passes an owner-sourced task past both holds, at any priority', () => {
    assert.equal(holdOf({ ...TOOLING, source: OWNER, priority: 3 }, heldBoth), undefined);
  });

  it('passes an expedite-band task past the limit', () => {
    assert.equal(holdOf({ ...ROADMAP, workClass: 'Maintenance', critical: true }, inProgress(3)), undefined);
  });

  it('holds a critical task when the expedite arm is off', () => {
    const noExpedite: WipFocus = { ...FOCUS, expedite: { critical: false, ownerP1: true } };
    assert.match(holdOf({ ...ROADMAP, workClass: 'Maintenance', critical: true }, inProgress(3), noExpedite) ?? '', /^alpha already has 3 tasks/);
  });

  it('holds a critical task of a class that is not Maintenance, which no expedite covers', () => {
    assert.match(holdOf({ ...TOOLING, critical: true }, heldBoth) ?? '', /^T9 is Improvements work/);
  });
});

describe('wipHold: what it never judges', () => {
  const heldBoth = [ROADMAP, ...inProgress(3)];

  it('holds nothing with the rule off', () => {
    assert.equal(holdOf(TOOLING, heldBoth, { ...FOCUS, wip: { mode: 'off', maxInProgress: 3 } }), undefined);
  });

  it('says the same in warn mode as in refuse mode: the caller decides what a hold does', () => {
    assert.equal(holdOf(TOOLING, heldBoth, { ...FOCUS, wip: { mode: 'warn', maxInProgress: 3 } }), holdOf(TOOLING, heldBoth));
  });

  it('never holds setting a task in progress again', () => {
    assert.equal(holdOf({ ...TOOLING, status: 'in-progress' }, heldBoth), undefined);
  });

  it('holds a reopen as it holds a first start', () => {
    assert.match(holdOf({ ...TOOLING, status: 'verifying', startedAt: '2030-01-07T08:00:00.000Z' }, heldBoth) ?? '', /^T9 is Improvements work/);
    assert.match(holdOf({ ...TOOLING, status: 'waiting', startedAt: '2030-01-07T08:00:00.000Z' }, heldBoth) ?? '', /^T9 is Improvements work/);
  });

  it('never counts the started task itself', () => {
    assert.equal(holdOf({ ...ROADMAP, status: 'open' }, inProgress(2)), undefined);
    assert.equal(holdOf(ROADMAP, []), undefined);
  });

  it('judges no other status', () => {
    const context = waitContext(new Map(heldBoth.map((held) => [held.id, held])), NOW, TimeZone.UTC);
    assert.equal(wipHold({ task: TOOLING, status: 'waiting', oneCommit: false }, heldBoth, context, FOCUS, OWNER), undefined);
    assert.equal(wipHold({ task: TOOLING, status: 'done', oneCommit: false }, heldBoth, context, FOCUS, OWNER), undefined);
  });

  it('reads a task the Roadmap task comes after from the rest of the team tree', () => {
    const needed = testTask({ id: 'T2', owner: 'bravo' });
    const roadmap = { ...ROADMAP, after: ['T2'] };
    const tasks = [TOOLING, roadmap];
    const here = new Map(tasks.map((held) => [held.id, held]));
    const open = waitContext(here, NOW, TimeZone.UTC, new Map([['T2', { team: 'web', task: needed }]]));
    const done = waitContext(here, NOW, TimeZone.UTC, new Map([['T2', { team: 'web', task: { ...needed, status: 'done' } }]]));
    assert.equal(wipHold({ task: TOOLING, status: 'in-progress', oneCommit: false }, tasks, open, FOCUS, OWNER), undefined);
    assert.match(wipHold({ task: TOOLING, status: 'in-progress', oneCommit: false }, tasks, done, FOCUS, OWNER) ?? '', /can move: T1;/);
  });
});
