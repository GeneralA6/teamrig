import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { approvalCleared, leadApprovedTask } from './approval.ts';
import type { ApprovalAnswer } from './fold.ts';
import type { WaitReason } from './waits.ts';

const LEAD: WaitReason = { kind: 'approval', who: 'lead' };
const APPROVED: ApprovalAnswer = { verdict: 'approved', by: 'lead', at: '2030-01-07T11:00:00.000Z', note: 'tests green' };

describe('approvalCleared (T684)', () => {
  it('clears an approval wait its giver approved, and nothing else', () => {
    const answered = testTask({ answer: APPROVED });
    assert.equal(approvalCleared(answered, LEAD), true);
    assert.equal(approvalCleared(testTask({ answer: { ...APPROVED, verdict: 'declined' } }), LEAD), false);
    assert.equal(approvalCleared(answered, { kind: 'approval', who: 'owner' }), false, "the lead's answer is not the owner's");
    assert.equal(approvalCleared(answered, { kind: 'decision', who: 'lead' }), false, 'a decision is not an approval');
    assert.equal(approvalCleared(testTask(), LEAD), false, 'unanswered');
  });
});

describe('leadApprovedTask (T684)', () => {
  const waiting = { status: 'waiting', owner: 'alpha', waits: [LEAD] } as const;

  it("finds the owner's waiting task that the lead approved", () => {
    const tasks = [testTask({ id: 'T1', ...waiting }), testTask({ id: 'T2', ...waiting, answer: APPROVED })];
    assert.equal(leadApprovedTask(tasks, 'alpha', 'lead')?.id, 'T2');
  });

  it("finds none in another owner's task, a decline, the owner's approval, or a task no longer waiting", () => {
    const tasks = [
      testTask({ id: 'T1', ...waiting, owner: 'bravo', answer: APPROVED }),
      testTask({ id: 'T2', ...waiting, answer: { ...APPROVED, verdict: 'declined' } }),
      testTask({ id: 'T3', ...waiting, waits: [{ kind: 'approval', who: 'owner' }], answer: { ...APPROVED, by: 'owner' } }),
      testTask({ id: 'T4', ...waiting, status: 'verifying', answer: APPROVED }),
    ];
    assert.equal(leadApprovedTask(tasks, 'alpha', 'lead'), undefined);
  });
});
