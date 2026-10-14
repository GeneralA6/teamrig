import type { Task } from '../register/fold.ts';

/** An open tier-2 task owned by `alpha`, created by `lead` at 2030-01-07 09:00 UTC, with any field overridden. */
export function testTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T1',
    title: 'Add a health check',
    owner: 'alpha',
    source: 'lead',
    ref: null,
    tier: 2,
    due: null,
    goals: [],
    week: null,
    status: 'open',
    note: null,
    evidence: null,
    skill: null,
    createdAt: '2030-01-07T09:00:00.000Z',
    createdBy: 'lead',
    updatedAt: '2030-01-07T09:00:00.000Z',
    updatedBy: 'lead',
    assignedAt: '2030-01-07T09:00:00.000Z',
    ownerSeenAt: null,
    ...overrides,
  };
}
