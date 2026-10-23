import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { answerTo, approvalCleared, approvedTaskOf } from './approval.ts';
import type { ApprovalAnswer } from './fold.ts';
import type { WaitReason } from './waits.ts';

const LEAD: WaitReason = { kind: 'approval', who: 'lead' };
const APPROVED: ApprovalAnswer = { verdict: 'approved', by: 'lead', at: '2030-01-07T11:00:00.000Z', note: 'tests green' };
const DECLINED: ApprovalAnswer = { ...APPROVED, verdict: 'declined', note: 'add the test' };

describe('answerTo (T996)', () => {
  it("gives the giver's answer to an approval wait either way, and nothing for another wait or giver", () => {
    assert.equal(answerTo(testTask({ answer: APPROVED }), LEAD), APPROVED);
    assert.equal(answerTo(testTask({ answer: DECLINED }), LEAD), DECLINED);
    assert.equal(answerTo(testTask({ answer: APPROVED }), { kind: 'approval', who: 'owner' }), undefined, "the lead's answer is not the owner's");
    assert.equal(answerTo(testTask({ answer: APPROVED }), { kind: 'decision', who: 'lead' }), undefined, 'a decision is not an approval');
    assert.equal(answerTo(testTask(), LEAD), undefined, 'unanswered');
  });
});

describe('approvalCleared (T684)', () => {
  it('clears an approval wait its giver approved, and nothing else', () => {
    const answered = testTask({ answer: APPROVED });
    assert.equal(approvalCleared(answered, LEAD), true);
    assert.equal(approvalCleared(testTask({ answer: DECLINED }), LEAD), false);
    assert.equal(approvalCleared(answered, { kind: 'approval', who: 'owner' }), false, "the lead's answer is not the owner's");
    assert.equal(approvalCleared(answered, { kind: 'decision', who: 'lead' }), false, 'a decision is not an approval');
    assert.equal(approvalCleared(testTask(), LEAD), false, 'unanswered');
  });
});

describe('approvedTaskOf (T684, T781)', () => {
  const waiting = { status: 'waiting', owner: 'alpha', waits: [LEAD] } as const;

  it("finds the owner's waiting task that the lead approved, and says who did", () => {
    const tasks = [testTask({ id: 'T1', ...waiting }), testTask({ id: 'T2', ...waiting, answer: APPROVED })];
    const approved = approvedTaskOf(tasks, 'alpha', ['lead']);
    assert.deepEqual([approved?.task.id, approved?.by], ['T2', 'lead']);
  });

  it("finds one a sub-lead above the owner approved, but none from a leader outside the owner's chain", () => {
    const sub: WaitReason = { kind: 'approval', who: 'bravo' };
    const tasks = [testTask({ id: 'T1', ...waiting, waits: [sub], answer: { ...APPROVED, by: 'bravo' } })];
    const approved = approvedTaskOf(tasks, 'alpha', ['bravo', 'lead']);
    assert.deepEqual([approved?.task.id, approved?.by], ['T1', 'bravo']);
    assert.equal(approvedTaskOf(tasks, 'alpha', ['lead']), undefined, 'bravo leads someone else, not alpha');
  });

  it("finds none in another owner's task, a decline, the owner's approval, or a task no longer waiting", () => {
    const tasks = [
      testTask({ id: 'T1', ...waiting, owner: 'bravo', answer: APPROVED }),
      testTask({ id: 'T2', ...waiting, answer: { ...APPROVED, verdict: 'declined' } }),
      testTask({ id: 'T3', ...waiting, waits: [{ kind: 'approval', who: 'owner' }], answer: { ...APPROVED, by: 'owner' } }),
      testTask({ id: 'T4', ...waiting, status: 'verifying', answer: APPROVED }),
    ];
    assert.equal(approvedTaskOf(tasks, 'alpha', ['lead']), undefined);
  });
});
