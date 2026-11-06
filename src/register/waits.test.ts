import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskStatus } from './model.ts';
import {
  allReady,
  isFinished,
  isPeerWait,
  isReady,
  isWaitKind,
  parseWaits,
  sameWait,
  sameWaits,
  unfinishedAfter,
  waitContext,
  waitOf,
  waitSpelling,
  waitsText,
  waitText,
  weekdayText,
  type WaitAnswerers,
  type WaitReason,
} from './waits.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const TASKS = new Map<string, { readonly status: TaskStatus }>([
  ['T1', { status: 'done' }],
  ['T2', { status: 'dropped' }],
  ['T3', { status: 'in-progress' }],
  ['T4', { status: 'waiting' }],
]);
const CONTEXT = waitContext(TASKS, NOW, TimeZone.UTC);

const DECISION: WaitReason = { kind: 'decision', who: 'owner' };
const APPROVAL: WaitReason = { kind: 'approval', who: 'lead' };

describe('waitSpelling, sameWait and isWaitKind', () => {
  it('spells each reason as typed', () => {
    assert.deepEqual(
      ([DECISION, APPROVAL, { kind: 'task', id: 'T5' }, { kind: 'time', at: '2030-01-09 12:00' }] satisfies WaitReason[]).map((reason) => waitSpelling(reason)),
      ['decision:owner', 'approval:lead', 'task:T5', 'time:2030-01-09 12:00'],
    );
  });

  it('matches two reasons naming the same thing', () => {
    assert.equal(sameWait(DECISION, { kind: 'decision', who: 'owner' }), true);
    assert.equal(sameWait(DECISION, { kind: 'approval', who: 'owner' }), false);
  });

  it('matches two lists naming the same reasons in any order', () => {
    assert.equal(sameWaits([DECISION, APPROVAL], [APPROVAL, DECISION]), true);
    assert.equal(sameWaits([DECISION], [DECISION, APPROVAL]), false);
    assert.equal(sameWaits([DECISION], [APPROVAL]), false);
    assert.equal(sameWaits([], []), true);
  });

  it('knows the four kinds only', () => {
    assert.equal(isWaitKind('time'), true);
    assert.equal(isWaitKind('blocked'), false);
    assert.equal(isWaitKind(4), false);
  });
});

describe('isPeerWait', () => {
  it("is a peer's decision or approval: anyone's but the lead's and the owner's", () => {
    const reasons: readonly WaitReason[] = [
      DECISION,
      APPROVAL,
      { kind: 'decision', who: 'alpha' },
      { kind: 'approval', who: 'bravo' },
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-11' },
    ];
    assert.deepEqual(
      reasons.map((reason) => isPeerWait(reason, leadersOnly(['lead']), 'owner')),
      [false, false, true, true, false, false],
    );
    assert.equal(isPeerWait(APPROVAL, leadersOnly(['alpha']), 'owner'), true, 'the lead is whoever the team config names');
  });

  it("is no peer's when the one asked is a sub-lead above the task's owner (T781)", () => {
    const answerers = leadersOnly(['alpha', 'lead']);
    assert.equal(isPeerWait({ kind: 'approval', who: 'alpha' }, answerers, 'owner'), false);
    assert.equal(isPeerWait({ kind: 'decision', who: 'alpha' }, answerers, 'owner'), false);
    assert.equal(isPeerWait({ kind: 'approval', who: 'bravo' }, answerers, 'owner'), true, 'a session outside the chain is a peer');
  });

  it("reads each kind's own answerers: the security reviewer answers an approval, not a decision (T828)", () => {
    const answerers: WaitAnswerers = { decision: ['lead'], approval: ['lead', 'security'] };
    assert.equal(isPeerWait({ kind: 'approval', who: 'security' }, answerers, 'owner'), false);
    assert.equal(isPeerWait({ kind: 'decision', who: 'security' }, answerers, 'owner'), true);
  });
});

/** The answerers of a team with no security reviewer: the same leaders for both kinds. */
function leadersOnly(leaders: readonly string[]): WaitAnswerers {
  return { decision: leaders, approval: leaders };
}

describe('waitOf', () => {
  it('reads each kind, a bare day for a time', () => {
    assert.deepEqual(waitOf('decision', 'owner'), DECISION);
    assert.deepEqual(waitOf('task', 'T12'), { kind: 'task', id: 'T12' });
    assert.deepEqual(waitOf('time', '2030-01-09'), { kind: 'time', at: '2030-01-09' });
  });

  it('names what is wrong with a value', () => {
    assert.equal(waitOf('approval', ''), 'approval needs who gives it');
    assert.equal(waitOf('task', 'T0'), 'T0 is not a task id like T12');
    assert.equal(waitOf('time', '2030-02-30'), '2030-02-30 is not YYYY-MM-DD or YYYY-MM-DD HH:MM');
  });
});

describe('parseWaits', () => {
  it('reads a stored list', () => {
    const stored = [
      { kind: 'decision', who: 'owner' },
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-09 12:00' },
    ];
    assert.deepEqual(parseWaits(stored), stored);
    assert.deepEqual(parseWaits([]), []);
  });

  it('names the first problem', () => {
    assert.equal(parseWaits({}), 'waits is not a list');
    assert.equal(parseWaits([null]), 'a wait is not an object');
    assert.equal(parseWaits([{ kind: 'blocked' }]), 'unknown wait kind "blocked"');
    assert.equal(parseWaits([{ kind: 'decision', id: 'T5' }]), 'a decision wait has no who');
    assert.equal(parseWaits([{ kind: 'task', id: 'X' }]), 'X is not a task id like T12');
  });
});

describe('isFinished, isReady and allReady', () => {
  it('finishes a done or dropped task, and one the read lacks, which only a retired task is', () => {
    assert.deepEqual(
      ['T1', 'T2', 'T3', 'T4', 'T9'].map((id) => isFinished(id, CONTEXT)),
      [true, true, false, false, true],
    );
  });

  it('clears a task reason once its task finished, and a time once it passed', () => {
    assert.equal(isReady({ kind: 'task', id: 'T1' }, CONTEXT), true);
    assert.equal(isReady({ kind: 'task', id: 'T3' }, CONTEXT), false);
    assert.equal(isReady({ kind: 'time', at: '2030-01-10 12:00' }, CONTEXT), true, 'the minute itself counts');
    assert.equal(isReady({ kind: 'time', at: '2030-01-10 12:01' }, CONTEXT), false);
    assert.equal(isReady({ kind: 'time', at: '2030-01-10' }, CONTEXT), false, 'a bare day lasts to its end');
    assert.equal(isReady({ kind: 'time', at: 'not a time' }, CONTEXT), false);
  });

  it('never clears a decision or an approval: the task owner says when it came', () => {
    assert.equal(isReady(DECISION, CONTEXT), false);
    assert.equal(isReady(APPROVAL, CONTEXT), false);
  });

  it('is ready only with reasons, all of them ready', () => {
    assert.equal(allReady([], CONTEXT), false);
    assert.equal(allReady([{ kind: 'task', id: 'T1' }, { kind: 'time', at: '2030-01-09' }], CONTEXT), true);
    assert.equal(allReady([{ kind: 'task', id: 'T1' }, DECISION], CONTEXT), false);
  });
});

describe('waitText and waitsText', () => {
  it('says each reason in plain words, with the weekday of a time', () => {
    assert.equal(weekdayText('2030-01-10 13:00', TimeZone.UTC), 'Thu 01-10 13:00 UTC');
    assert.equal(weekdayText('2030-01-10', TimeZone.UTC), 'Thu 01-10');
    assert.equal(weekdayText('soon', TimeZone.UTC), 'soon', 'a stored time a reader cannot read prints as stored');
    assert.equal(
      waitsText([DECISION, APPROVAL, { kind: 'task', id: 'T304' }, { kind: 'time', at: '2030-01-10 13:00' }], TimeZone.UTC),
      'decision owner · approval lead · on T304 · until Thu 01-10 13:00 UTC',
    );
  });

  it('marks a ready reason only when it has a read to judge by', () => {
    assert.equal(waitText({ kind: 'task', id: 'T1' }, TimeZone.UTC), 'on T1');
    assert.equal(waitText({ kind: 'task', id: 'T1' }, TimeZone.UTC, CONTEXT), 'on T1 ready');
    assert.equal(waitText(DECISION, TimeZone.UTC, CONTEXT), 'decision owner');
  });
});

describe('unfinishedAfter', () => {
  it('keeps the tasks of a plan dependency not finished yet, in order', () => {
    assert.deepEqual(unfinishedAfter(['T4', 'T1', 'T3', 'T9'], CONTEXT), ['T4', 'T3']);
    assert.deepEqual(unfinishedAfter([], CONTEXT), []);
  });
});

describe('a task another register of the team tree holds', () => {
  const elsewhere = new Map<string, { readonly task: { readonly status: TaskStatus } }>([
    ['T7', { task: { status: 'in-progress' } }],
    ['T8', { task: { status: 'done' } }],
    ['T3', { task: { status: 'done' } }],
  ]);
  const context = waitContext(TASKS, NOW, TimeZone.UTC, elsewhere);

  it('reads its status there for an id this read lacks, the read winning an id both hold', () => {
    assert.equal(context.statusOf('T7'), 'in-progress');
    assert.equal(isFinished('T7', context), false);
    assert.equal(isReady({ kind: 'task', id: 'T7' }, context), false);
    assert.equal(isReady({ kind: 'task', id: 'T8' }, context), true);
    assert.equal(context.statusOf('T3'), 'in-progress', 'a register numbered before its tree reads its own T3');
    assert.deepEqual(unfinishedAfter(['T7', 'T8', 'T3', 'T9'], context), ['T7', 'T3'], 'T9, in no register, was retired');
  });
});

describe("a time wait in the team's zone", () => {
  it('prints a stored minute there, zone-marked, and its weekday there', () => {
    assert.equal(weekdayText('2030-01-10 23:30', JERUSALEM), 'Fri 01-11 01:30 IST', 'a stored minute is UTC; its local day can be the next one');
    assert.equal(weekdayText('2030-01-10', JERUSALEM), 'Thu 01-10', 'a bare day is a day of the zone');
  });

  it('readies a bare day once that day has ended there', () => {
    const at = new Date('2030-01-10T22:30:00.000Z');
    const day: WaitReason = { kind: 'time', at: '2030-01-10' };
    assert.equal(isReady(day, waitContext(TASKS, at, JERUSALEM)), true, 'Jerusalem is at 01-11 00:30');
    assert.equal(isReady(day, waitContext(TASKS, at, TimeZone.UTC)), false, 'UTC is at 01-10 22:30');
  });
});
