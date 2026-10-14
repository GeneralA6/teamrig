import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { RegisterPolicy, type Verdict } from './policy.ts';
import { Register, type SkillCatalog, type WriteResult } from './register.ts';
import { JsonlEventLog, readEvents } from './store.ts';

const LOG = 'register/events.jsonl';
const START = '2030-01-07T09:00:00.000Z';

class FakeSkills implements SkillCatalog {
  readonly asked: string[] = [];
  private readonly names: ReadonlySet<string>;

  constructor(names: readonly string[]) {
    this.names = new Set(names);
  }

  async exists(name: string): Promise<boolean> {
    this.asked.push(name);
    return this.names.has(name);
  }
}

function setup(initial: Readonly<Record<string, string>> = {}) {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock(START);
  const mutex = new InlineMutex();
  const skills = new FakeSkills(['web-deploy']);
  const register = new Register({
    log: new JsonlEventLog(files, LOG),
    mutex,
    clock,
    policy: new RegisterPolicy(testConfig()),
    skills,
  });
  return { files, clock, mutex, skills, register };
}

function written(verdict: Verdict<WriteResult>): WriteResult {
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
  return verdict.value;
}

function errorOf(verdict: Verdict<WriteResult>): string {
  return verdict.ok ? 'allowed' : verdict.error;
}

describe('Register', () => {
  it('numbers new tasks and appends one v1 line per write', async () => {
    const { files, register } = setup();
    const first = written(await register.add('lead', { title: 'First', owner: 'alpha', source: 'owner', tier: 1 }));
    const second = written(await register.add('lead', { title: 'Second', owner: 'bravo', source: 'lead', tier: 2 }));

    assert.equal(first.task.id, 'T1');
    assert.equal(second.task.id, 'T2');
    assert.equal(second.task.status, 'open');
    assert.equal(second.task.createdAt, START);
    const read = readEvents(files.get(LOG) ?? '');
    assert.deepEqual(read.events, [first.event, second.event]);
    assert.deepEqual(read.events.map((event) => event.v), [1, 1]);
  });

  it('records the status change and returns the task after it', async () => {
    const { clock, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', tier: 1 }));
    clock.advance(60_000);
    const result = written(await register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    assert.equal(result.task.status, 'in-progress');
    assert.equal(result.task.ownerSeenAt, '2030-01-07T09:01:00.000Z');
    assert.deepEqual(result.event, {
      v: 1,
      type: 'status',
      id: 'T1',
      at: '2030-01-07T09:01:00.000Z',
      by: 'alpha',
      status: 'in-progress',
      note: null,
      evidence: null,
      skill: null,
    });
  });

  it('checks a cited skill against the catalog, but never `none`', async () => {
    const { register, skills } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', tier: 1 }));
    const close = { status: 'done' as const, note: 'shipped', evidence: 'abc1234' };

    assert.match(errorOf(await register.setStatus('alpha', 'T1', { ...close, skill: ' web-build ' })), /no skill named web-build/);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, skill: 'none' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build']);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, note: 'again', skill: 'web-deploy' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build', 'web-deploy']);
  });

  it('lets the lead reassign, which restarts the pick-up clock', async () => {
    const { clock, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', tier: 1 }));
    clock.advance(3_600_000);
    const result = written(await register.update('lead', 'T1', { owner: 'bravo' }, 'alpha is out'));
    assert.equal(result.task.owner, 'bravo');
    assert.equal(result.task.assignedAt, '2030-01-07T10:00:00.000Z');
    assert.equal(result.task.ownerSeenAt, null);
  });

  it('refuses unknown callers before taking the lock, and leaves the log alone on any refusal', async () => {
    const { files, mutex, register } = setup();
    assert.match(errorOf(await register.add('charlie', { title: 'x', owner: 'alpha', source: 'owner', tier: 1 })), /charlie/);
    assert.equal(mutex.runs, 0);
    assert.match(errorOf(await register.setStatus('alpha', 'T7', { status: 'blocked', note: 'x' })), /no task T7/);
    assert.match(errorOf(await register.update('alpha', 'T7', { tier: 2 }, undefined)), /no task T7/);
    assert.match(errorOf(await register.add('lead', { title: 'x', owner: 'alpha', source: 'owner', tier: 9 })), /tier 9/);
    assert.equal(files.get(LOG), undefined);
  });

  it('refuses to write beside lines from a newer format', async () => {
    const newer = `${JSON.stringify({ v: 2, type: 'create', id: 'T1' })}\n`;
    const { files, register } = setup({ [LOG]: newer });
    await assert.rejects(register.add('lead', { title: 'x', owner: 'alpha', source: 'owner', tier: 1 }), NewerDataError);
    assert.equal(files.get(LOG), newer);
  });

  it('reads a snapshot without the lock', async () => {
    const { mutex, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', tier: 1 }));
    const runs = mutex.runs;
    const { state, read } = await register.snapshot();
    assert.equal(mutex.runs, runs);
    assert.equal(state.tasks.size, 1);
    assert.equal(read.unreadable, 0);
  });
});
