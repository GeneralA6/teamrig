import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { renderPlan } from './plan.ts';

describe('renderPlan', () => {
  it('renders the week by priority with each status', () => {
    const config = testConfig({ register: { priorities: [{ id: 1, name: 'Keep it running' }, { id: 2, name: 'Build' }] } }).register;
    const week = '2030-01-07';
    const tasks = [
      testTask({ id: 'T1', week, priority: 2, status: 'done', evidence: 'abc1234' }),
      testTask({ id: 'T2', week, priority: 1, source: 'owner', due: '2030-01-08', goals: ['G1'] }),
      testTask({ id: 'T3', week, priority: 2, status: 'blocked', note: 'waiting on disk' }),
      testTask({ id: 'T4', week, priority: 2, status: 'dropped', note: 'merged into T1' }),
      testTask({ id: 'T5', week, priority: 2, status: 'in-progress' }),
      testTask({ id: 'T6', week: '2030-01-14' }),
    ];
    assert.equal(
      renderPlan(tasks, week, new Date('2030-01-07T08:00:00Z'), config),
      [
        '# Week plan 2030-01-07',
        '',
        '5 tasks: 1 done, 1 dropped, 3 to do. From the task register at 2030-01-07 08:00 UTC.',
        '',
        '## p1: Keep it running',
        '',
        '- [ ] **T2** Add a health check (alpha · due 01-08 · owner order · G1)',
        '',
        '## p2: Build',
        '',
        '- [x] **T1** Add a health check (alpha · from lead) done: abc1234',
        '- [ ] **T3** Add a health check (alpha · from lead) **blocked:** waiting on disk',
        '- [ ] **T4** ~~Add a health check~~ (alpha · from lead) dropped: merged into T1',
        '- [ ] **T5** Add a health check (alpha · from lead) (in progress)',
      ].join('\n'),
    );
  });
});
