import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_TARGET_HOURS, isLate, REMIND_SHARE, repoOf, stepClocks, waitingSince, type Clock, type Thread, type ThreadPost } from './clock.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 15, 8);
const outside = (hours: number): ThreadPost => ({ at: T0 + hours * HOUR, ours: false });
const ours = (hours: number): ThreadPost => ({ at: T0 + hours * HOUR, ours: true });
const thread = (number: number, posts: readonly ThreadPost[], kind: Thread['kind'] = 'bug'): Thread => ({ ref: `acme/app#${number}`, kind, owner: 'alpha', posts });

describe('waitingSince', () => {
  it('starts at the oldest outside post after our newest one, so a follow-up does not restart the wait', () => {
    assert.equal(waitingSince([outside(0), ours(1), outside(2), outside(5)]), T0 + 2 * HOUR);
  });

  it('is undefined when we spoke last, or only we posted', () => {
    assert.equal(waitingSince([outside(0), ours(1)]), undefined);
    assert.equal(waitingSince([ours(0)]), undefined);
    assert.equal(waitingSince([]), undefined);
  });

  it('reads posts in time order whatever order they come in', () => {
    assert.equal(waitingSince([outside(5), ours(1), outside(0), outside(2)]), T0 + 2 * HOUR);
  });
});

describe('the answer targets', () => {
  it('pins the design table: security 4 h, bug, pull and comment 24 h, feature 72 h; reminded at 75%', () => {
    assert.deepEqual(ANSWER_TARGET_HOURS, { security: 4, bug: 24, pull: 24, comment: 24, feature: 72 });
    assert.equal(REMIND_SHARE, 0.75);
  });

  it('is late at its target, not before', () => {
    assert.equal(isLate({ kind: 'security', since: T0 }, T0 + 4 * HOUR - 1), false);
    assert.equal(isLate({ kind: 'security', since: T0 }, T0 + 4 * HOUR), true);
  });
});

describe('stepClocks', () => {
  const read = new Set(['acme/app']);

  it('starts a clock on a thread waiting on us, and none on one we answered', () => {
    const step = stepClocks(new Map(), read, [thread(1, [outside(0)]), thread(2, [outside(0), ours(1)])], T0 + HOUR);
    assert.deepEqual([...step.clocks.keys()], ['acme/app#1']);
    assert.deepEqual(step.clocks.get('acme/app#1'), { ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined });
    assert.deepEqual(step.remind, []);
  });

  it('reminds once at 75% of the target, and keeps the reminder while the same wait runs', () => {
    const at = T0 + 18 * HOUR;
    const first = stepClocks(new Map(), read, [thread(1, [outside(0)])], at);
    assert.deepEqual(first.remind.map((clock) => clock.ref), ['acme/app#1']);
    assert.equal(first.clocks.get('acme/app#1')?.remindedAt, at);
    const second = stepClocks(first.clocks, read, [thread(1, [outside(0), outside(19)])], at + HOUR);
    assert.deepEqual(second.remind, []);
    assert.equal(second.clocks.get('acme/app#1')?.remindedAt, at);
  });

  it('does not remind before 75%', () => {
    assert.deepEqual(stepClocks(new Map(), read, [thread(1, [outside(0)])], T0 + 18 * HOUR - 1).remind, []);
  });

  it('starts afresh, reminder cleared, once we answered and the outsider posts again', () => {
    const before: ReadonlyMap<string, Clock> = new Map([['acme/app#1', { ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0, remindedAt: T0 + 18 * HOUR }]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(20), outside(21)])], T0 + 22 * HOUR);
    assert.deepEqual(step.clocks.get('acme/app#1'), { ref: 'acme/app#1', kind: 'bug', owner: 'alpha', since: T0 + 21 * HOUR, remindedAt: undefined });
  });

  it('stops the clock of a thread answered, closed or gone from a repository read, and keeps those of one not read', () => {
    const clock = (ref: string): Clock => ({ ref, kind: 'bug', owner: 'alpha', since: T0, remindedAt: undefined });
    const before = new Map([['acme/app#1', clock('acme/app#1')], ['acme/app#2', clock('acme/app#2')], ['acme/docs#3', clock('acme/docs#3')]]);
    const step = stepClocks(before, read, [thread(1, [outside(0), ours(1)])], T0 + 2 * HOUR);
    assert.deepEqual([...step.clocks.keys()], ['acme/docs#3']);
  });
});

describe('repoOf', () => {
  it('cuts the number off a ref', () => {
    assert.equal(repoOf('acme/app#12'), 'acme/app');
    assert.equal(repoOf('acme/app'), 'acme/app');
  });
});
