import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIRING } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import type { HireRecord } from './record.ts';
import { ownsOpenTask, retireAskDue, retireAskReason, type RetireAskInput } from './retire-ask.ts';

const ASK = { task: 'T4', at: '2030-01-08T10:00:00.000Z' };

function hire(session: string): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', reviewBy: '2030-01-15', by: 'lead', at: 0 };
}

function input(overrides: Partial<RetireAskInput> = {}): RetireAskInput {
  const done = testTask({ id: 'T4', owner: 'helper', status: 'done' });
  return {
    config: { sessions: ['lead', 'helper'], hiring: { ...DEFAULT_HIRING, policy: 'automatic' } },
    hires: [hire('helper')],
    task: done,
    tasks: [done, testTask({ id: 'T5', owner: 'lead', status: 'open' })],
    ...overrides,
  };
}

describe('ownsOpenTask', () => {
  it('counts only the session\'s tasks that are not closed', () => {
    assert.equal(ownsOpenTask([testTask({ owner: 'helper', status: 'done' }), testTask({ owner: 'lead', status: 'open' })], 'helper'), false);
    assert.equal(ownsOpenTask([testTask({ owner: 'helper', status: 'waiting' })], 'helper'), true);
    assert.equal(ownsOpenTask([], 'helper'), false);
  });
});

describe('retireAskDue', () => {
  it('asks a hired session on the team, under automatic, left with no open task', () => {
    assert.equal(retireAskDue(input()), true);
  });

  it('asks nobody under another policy, for a session not hired or not on the team, or one with a task still open', () => {
    assert.equal(retireAskDue(input({ config: { sessions: ['lead', 'helper'], hiring: DEFAULT_HIRING } })), false);
    assert.equal(retireAskDue(input({ hires: [hire('other')] })), false);
    assert.equal(retireAskDue(input({ config: { sessions: ['lead'], hiring: { ...DEFAULT_HIRING, policy: 'automatic' } } })), false);
    const open = testTask({ id: 'T6', owner: 'helper', status: 'in-progress' });
    assert.equal(retireAskDue(input({ tasks: [input().task, open] })), false);
  });
});

describe('retireAskReason', () => {
  it('names the task and the handover path, and tells the session not to retire', () => {
    const reason = retireAskReason(ASK, '/team/handover/helper.md');
    assert.match(reason, /^Your last open task T4 is closed\. Write your handover to \/team\/handover\/helper\.md /);
    assert.ok(reason.includes('Do not retire: your leader decides which workers the team needs'), reason);
    assert.ok(!reason.includes('teamrig retire'), reason);
    assert.ok(reason.endsWith('say so in one line and carry on.'));
  });
});
