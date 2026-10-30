import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS } from '../config/limits.ts';
import type { KitConfig } from '../config/types.ts';
import type { JsonRecord } from '../core/guards.ts';
import { RETAIN_DAYS } from '../register/compaction.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import type { HireRecord } from './record.ts';
import { scaleOutFlags, type ScaleOutInput, type ScaleOutResult } from './scale-out.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = new Date('2030-01-08T00:00:00Z');
const DAY_MS = 86_400_000;
/** Two days from now. */
const DUE = '2030-01-10 00:00';
const HIRE = 'the lead hires for it (teamrig hire <new id> --scope "<the slice>" --reason "SCALE-OUT"), then teamrig update <id> --owner <new id>, for each';

function config(hiring: JsonRecord = {}, sessions: readonly string[] = ['lead', 'alpha', 'bravo']): KitConfig {
  return testConfig({ sessions: [...sessions], hiring: { policy: 'lead', ...hiring } });
}

/** `count` tasks `owner` finished a day before now (or at `at`), numbered from `from`. */
function finished(owner: string, count: number, from: number, at = NOW.getTime() - DAY_MS): Task[] {
  return Array.from({ length: count }, (_item, index) => testTask({ id: `T${from + index}`, owner, status: 'done', statusAt: new Date(at).toISOString() }));
}

/** An open p1 task of `owner` due in two days, by number. */
function dated(owner: string, ids: readonly number[], overrides: Partial<Task> = {}): Task[] {
  return ids.map((id) => testTask({ id: `T${id}`, owner, priority: 1, due: DUE, ...overrides }));
}

function hire(session: string, overrides: Partial<HireRecord> = {}): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', reviewBy: '2030-01-15', by: 'lead', at: NOW.getTime() - DAY_MS, ...overrides };
}

function scaleOut(tasks: readonly Task[], overrides: Partial<ScaleOutInput> = {}): ScaleOutResult {
  return scaleOutFlags({
    hires: [],
    tasks,
    tree: new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC),
    config: config(),
    burstsOver: new Set(),
    spare: { sparePct: 10, paceEnd: NOW.getTime() + 6 * DAY_MS },
    hirePct: 1,
    now: NOW,
    ...overrides,
  });
}

/** alpha: 7 done in the week, a pace of 1 a day, and four tasks due in two days: two past what it finishes. */
const ALPHA_BEHIND = [...finished('alpha', 7, 100), ...dated('alpha', [1, 2, 3, 4])];

describe('scaleOutFlags: when an area is behind', () => {
  it('flags an area with more due by a date than its pace finishes, naming the latest tasks to move and the cost', () => {
    const { flags, busy } = scaleOut(ALPHA_BEHIND);
    const detail = '4 due by 01-10 00:00 UTC, its pace finishes 2 by then (7 done in 7 d); slice T3 T4, due by 01-10 00:00 UTC, about 2.0% of the week, 10.0% spare';
    assert.deepEqual(flags, [{ kind: 'SCALE-OUT', session: 'alpha', detail, action: HIRE }]);
    assert.deepEqual([...busy], []);
  });

  it('flags nothing for an area its pace keeps on time, or one with too few tasks done to measure', () => {
    assert.deepEqual(scaleOut([...finished('alpha', 7, 100), ...dated('alpha', [1, 2])]).flags, []);
    assert.deepEqual(scaleOut([...finished('alpha', 2, 100), ...dated('alpha', [1, 2, 3, 4])]).flags, [], 'below hiring.scaleOut.minDone');
    const old = finished('alpha', 7, 100, NOW.getTime() - 8 * DAY_MS);
    assert.deepEqual(scaleOut([...old, ...dated('alpha', [1, 2, 3, 4])]).flags, [], 'done before the window does not count');
    assert.deepEqual(scaleOut([...finished('bravo', 7, 100), ...dated('alpha', [1, 2, 3, 4])]).flags, [], "another area's done tasks do not count");
  });

  it('measures the pace only over days a compaction keeps finished tasks in the working set', () => {
    assert.equal(CONFIG_LIMITS.scaleOutWindowDays.max, RETAIN_DAYS);
  });

  it('counts only active dated tasks of the top priorities, a due inherited from a task that needs it too', () => {
    const lower = [...dated('alpha', [3, 4], { priority: 3 }), ...dated('alpha', [5, 6], { due: null }), ...dated('alpha', [7], { status: 'done' })];
    assert.deepEqual(scaleOut([...finished('alpha', 7, 100), ...dated('alpha', [1, 2]), ...lower]).flags, []);
    const needer = testTask({ id: 'T9', owner: 'bravo', due: DUE, after: ['T5'] });
    const inherits = [...finished('alpha', 7, 100), ...dated('alpha', [1, 2, 3]), ...dated('alpha', [5], { due: null }), needer];
    assert.match(scaleOut(inherits).flags[0]?.detail ?? '', /^4 due by 01-10 00:00 UTC, .*; slice T2 T3,/, 'T5 counts; it unblocks T9, so it sorts first');
  });

  it("counts teamrig's p0 tasks beside the top priorities, without taking one of their places", () => {
    const one = config({ scaleOut: { topPriorities: 1 } });
    const tasks = [...finished('alpha', 7, 100), ...dated('alpha', [1, 2]), ...dated('alpha', [3, 4], { priority: 0 })];
    assert.match(scaleOut(tasks, { config: one }).flags[0]?.detail ?? '', /^4 due by 01-10 00:00 UTC, /);
  });

  it('never measures the lead or a hired session', () => {
    const team = config({}, ['lead', 'alpha', 'helper']);
    const tasks = [...finished('lead', 7, 100), ...dated('lead', [1, 2, 3, 4]), ...finished('helper', 7, 200), ...dated('helper', [11, 12, 13, 14], { status: 'waiting' })];
    assert.deepEqual(scaleOut(tasks, { config: team, hires: [hire('helper')] }).flags, []);
  });
});

describe('scaleOutFlags: the slice', () => {
  it('keeps a started task and one that started work needs, moving earlier open tasks instead', () => {
    const tasks = [...finished('alpha', 7, 100), ...dated('alpha', [1, 2, 3]), ...dated('alpha', [4], { status: 'in-progress' })];
    const needer = testTask({ id: 'T9', owner: 'bravo', status: 'in-progress', after: ['T3'] });
    assert.match(scaleOut([...tasks, needer]).flags[0]?.detail ?? '', /slice T1 T2,/);
  });

  it('names what stays late when too few tasks can move, and flags nothing when none can', () => {
    const someStuck = [...finished('alpha', 7, 100), ...dated('alpha', [1]), ...dated('alpha', [2, 3, 4], { status: 'in-progress' })];
    assert.match(scaleOut(someStuck).flags[0]?.detail ?? '', /slice T1, .*; 1 more stay late: started, or needed by started work$/);
    const allStarted = [...finished('alpha', 7, 100), ...dated('alpha', [1, 2, 3, 4], { status: 'verifying' })];
    assert.deepEqual(scaleOut(allStarted).flags, []);
  });

  it('counts the cost only to the week\'s pace end, a day at least', () => {
    const halfDay = { sparePct: 10, paceEnd: NOW.getTime() + DAY_MS / 2 };
    assert.match(scaleOut(ALPHA_BEHIND, { spare: halfDay }).flags[0]?.detail ?? '', /about 1\.0% of the week/);
  });

  it("prices each day of the slice at a new hire's part of today's team budget, as given", () => {
    assert.match(scaleOut(ALPHA_BEHIND, { hirePct: 2.5 }).flags[0]?.detail ?? '', /about 5\.0% of the week, 10\.0% spare$/);
    assert.deepEqual(scaleOut(ALPHA_BEHIND, { hirePct: 6 }).flags, [], 'two days at 6% pass the 10% spare');
  });
});

describe('scaleOutFlags: the budget and who takes the slice', () => {
  /** bravo: 7 done, three due in two days: one past what it finishes, so behind alpha. */
  const BRAVO_BEHIND = [...finished('bravo', 7, 200), ...dated('bravo', [21, 22, 23])];

  it("flags nothing with no reading of the week or of the team's daily budget, a spare too small, or hiring.policy off", () => {
    assert.deepEqual(scaleOut(ALPHA_BEHIND, { spare: undefined }).flags, []);
    assert.deepEqual(scaleOut(ALPHA_BEHIND, { hirePct: undefined }).flags, []);
    assert.deepEqual(scaleOut(ALPHA_BEHIND, { spare: { sparePct: 1.5, paceEnd: NOW.getTime() + 6 * DAY_MS } }).flags, []);
    assert.deepEqual(scaleOut(ALPHA_BEHIND, { config: config({ policy: 'off' }) }).flags, []);
  });

  it('pays the area furthest behind first, out of the spare that is left', () => {
    const both = [...BRAVO_BEHIND, ...ALPHA_BEHIND];
    assert.deepEqual(scaleOut(both, { spare: { sparePct: 3, paceEnd: NOW.getTime() + 6 * DAY_MS } }).flags.map((flag) => flag.session), ['alpha']);
    assert.deepEqual(scaleOut(both).flags.map((flag) => flag.session), ['alpha', 'bravo']);
  });

  it('gives the slice to an idle hire, which then holds it, before any new hire', () => {
    const team = config({}, ['lead', 'alpha', 'helper']);
    const { flags, busy } = scaleOut(ALPHA_BEHIND, { config: team, hires: [hire('helper')] });
    assert.equal(flags[0]?.action, 'the lead moves the slice to helper, an idle hire (teamrig update <id> --owner helper, for each)');
    assert.deepEqual([...busy], ['helper']);
    const working = scaleOut([...ALPHA_BEHIND, testTask({ id: 'T50', owner: 'helper' })], { config: team, hires: [hire('helper')] });
    assert.equal(working.flags[0]?.action, HIRE, 'a hire with work is not idle');
    const over = scaleOut(ALPHA_BEHIND, { config: team, hires: [hire('helper', { burst: 5 })], burstsOver: new Set([5]) });
    assert.equal(over.flags[0]?.action, HIRE, 'a hire whose burst is over retires');
  });

  it('asks the owner first under hiring.policy owner', () => {
    const action = 'the lead asks the owner, then hires for it (teamrig hire <new id> --scope "<the slice>" --reason "SCALE-OUT" --approved-by "<who>"), then teamrig update <id> --owner <new id>, for each';
    assert.equal(scaleOut(ALPHA_BEHIND, { config: config({ policy: 'owner' }) }).flags[0]?.action, action);
  });

  it("sends a child team's lead to its parent team's lead, never the owner, for the owner's approval", () => {
    const child = testConfig({ sessions: ['lead', 'alpha', 'bravo'], team: { id: 'ui', parent: 'web' }, hiring: { policy: 'owner' } });
    const asked = scaleOut(ALPHA_BEHIND, { config: child }).flags[0]?.action ?? '';
    assert.match(asked, /^the lead asks the lead of team web, who takes it to the owner, then hires for it \(teamrig hire <new id> /);
  });

  it('hires for each area behind however many hires the team holds: no cap blocks a hire', () => {
    const team = config({}, ['lead', 'alpha', 'bravo', 'helper', 'second']);
    const busyHires = [testTask({ id: 'T50', owner: 'helper' }), testTask({ id: 'T51', owner: 'second' })];
    const flags = scaleOut([...BRAVO_BEHIND, ...ALPHA_BEHIND, ...busyHires], { config: team, hires: [hire('helper'), hire('second')] }).flags;
    assert.deepEqual(flags.map((flag) => [flag.session, flag.action]), [['alpha', HIRE], ['bravo', HIRE]]);
  });
});
