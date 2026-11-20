import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_NUMBERS } from '../register/numbering.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { SyncStep } from './plan.ts';
import { applySteps, closedSince } from './sync.ts';

const URL = 'https://github.com/acme/web/issues/7';

function register(): Register {
  return new Register({
    log: new JsonlEventLog(new MemoryFiles(), 'register/events.jsonl'),
    mutex: new InlineMutex(),
    numbering: OWN_NUMBERS,
    elsewhere: NOTHING_ELSEWHERE,
    goals: NO_GOAL_RECORDS,
    clock: new FakeClock('2030-01-08T10:00:00.000Z'),
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(testConfig()),
    skills: { exists: async () => false },
    autoArchive: true,
  });
}

describe('closedSince', () => {
  it('is the UTC day closedDays before now', () => {
    assert.equal(closedSince(new Date('2030-01-08T10:00:00Z'), 14), '2029-12-25');
    assert.equal(closedSince(new Date('2030-01-01T00:30:00Z'), 1), '2029-12-31');
  });
});

describe('applySteps', () => {
  it('writes each step through the register, reports a refused one and goes on', async () => {
    const steps: SyncStep[] = [
      { kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } },
      { kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } },
      { kind: 'update', ref: 'gh:acme/web#7', id: 'T1', changes: { title: 'Fix the login' }, note: 'title as on GitHub' },
      { kind: 'status', ref: 'gh:acme/web#7', id: 'T1', input: { status: 'done', note: 'closed on GitHub as completed', evidence: URL } },
    ];
    const writer = register();
    assert.deepEqual((await applySteps(writer, steps)).map((outcome) => outcome.result), [
      { ok: true, value: 'T1' },
      { ok: false, error: 'T1 already has ref gh:acme/web#7' },
      { ok: true, value: 'T1' },
      { ok: true, value: 'T1' },
    ]);
    const task = (await writer.snapshot()).state.tasks.get('T1');
    assert.deepEqual([task?.title, task?.status, task?.evidence, task?.updatedBy], ['Fix the login', 'done', URL, 'github']);
  });
});
