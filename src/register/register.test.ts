import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { EVENT_VERSION } from './events.ts';
import { layoutPaths } from './layout.ts';
import { RegisterPolicy, type Verdict } from './policy.ts';
import { Register, type SkillCatalog, type WriteResult } from './register.ts';
import { readEvents } from './snapshot.ts';
import { JsonlEventLog } from './store.ts';

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
    autoArchive: true,
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
  it('numbers new tasks and appends one line in the current format per write', async () => {
    const { files, register } = setup();
    const first = written(await register.add('lead', { title: 'First', owner: 'alpha', source: 'owner', priority: 1 }));
    const second = written(await register.add('lead', { title: 'Second', owner: 'bravo', source: 'lead', priority: 2 }));

    assert.equal(first.task.id, 'T1');
    assert.equal(second.task.id, 'T2');
    assert.equal(second.task.status, 'open');
    assert.equal(second.task.createdAt, START);
    const read = readEvents(files.get(LOG) ?? '');
    assert.deepEqual(read.events, [first.event, second.event]);
    assert.deepEqual(read.events.map((event) => event.v), [EVENT_VERSION, EVENT_VERSION]);
  });

  it('records the status change and returns the task after it', async () => {
    const { clock, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', priority: 1 }));
    clock.advance(60_000);
    const result = written(await register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    assert.equal(result.task.status, 'in-progress');
    assert.equal(result.task.ownerSeenAt, '2030-01-07T09:01:00.000Z');
    assert.deepEqual(result.event, {
      v: EVENT_VERSION,
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
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', priority: 1 }));
    const close = { status: 'done' as const, note: 'shipped', evidence: 'abc1234' };

    assert.match(errorOf(await register.setStatus('alpha', 'T1', { ...close, skill: ' web-build ' })), /no skill named web-build/);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, skill: 'none' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build']);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, note: 'again', skill: 'web-deploy' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build', 'web-deploy']);
  });

  it('lets the lead reassign, which restarts the pick-up clock', async () => {
    const { clock, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', priority: 1 }));
    clock.advance(3_600_000);
    const result = written(await register.update('lead', 'T1', { owner: 'bravo' }, 'alpha is out'));
    assert.equal(result.task.owner, 'bravo');
    assert.equal(result.task.assignedAt, '2030-01-07T10:00:00.000Z');
    assert.equal(result.task.ownerSeenAt, null);
  });

  it('refuses unknown callers before taking the lock, and leaves the log alone on any refusal', async () => {
    const { files, mutex, register } = setup();
    assert.match(errorOf(await register.add('charlie', { title: 'x', owner: 'alpha', source: 'owner', priority: 1 })), /charlie/);
    assert.equal(mutex.runs, 0);
    assert.match(errorOf(await register.setStatus('alpha', 'T7', { status: 'blocked', note: 'x' })), /no task T7/);
    assert.match(errorOf(await register.update('alpha', 'T7', { priority: 2 }, undefined)), /no task T7/);
    assert.match(errorOf(await register.add('lead', { title: 'x', owner: 'alpha', source: 'owner', priority: 9 })), /priority p9/);
    assert.equal(files.get(LOG), undefined);
  });

  it('refuses to write beside lines from a newer format', async () => {
    const newer = `${JSON.stringify({ v: EVENT_VERSION + 1, type: 'create', id: 'T1' })}\n`;
    const { files, register } = setup({ [LOG]: newer });
    await assert.rejects(register.add('lead', { title: 'x', owner: 'alpha', source: 'owner', priority: 1 }), NewerDataError);
    assert.equal(files.get(LOG), newer);
  });

  it('reads a snapshot without the lock', async () => {
    const { mutex, register } = setup();
    written(await register.add('lead', { title: 'Ship it', owner: 'alpha', source: 'owner', priority: 1 }));
    const runs = mutex.runs;
    const { state, read } = await register.snapshot();
    assert.equal(mutex.runs, runs);
    assert.equal(state.tasks.size, 1);
    assert.equal(read.unreadable, 0);
  });
});

describe('Register on a rotated log', () => {
  async function rotated() {
    const world = setup();
    const { clock, files, register } = world;
    written(await register.add('lead', { title: 'Old', owner: 'alpha', source: 'owner', priority: 1 }));
    written(await register.setStatus('alpha', 'T1', { status: 'done', note: 'shipped', evidence: 'abc1234', skill: 'none' }));
    written(await register.add('lead', { title: 'Open', owner: 'alpha', source: 'owner', priority: 1 }));
    clock.advance(10 * 86_400_000);
    await rotateRegister(files, LOG, { now: new Date(clock.now()) });
    return world;
  }

  it('writes after the marker, numbering on from the whole history', async () => {
    const { files, register } = await rotated();
    const added = written(await register.add('lead', { title: 'New', owner: 'bravo', source: 'lead', priority: 2 }));
    assert.equal(added.task.id, 'T3');
    const changed = written(await register.setStatus('alpha', 'T2', { status: 'in-progress' }));
    assert.equal(changed.task.title, 'Open');
    const tail = readEvents(files.get(LOG) ?? '');
    assert.deepEqual([tail.rotatedAfter, tail.events.map((event) => event.id)], [1, ['T3', 'T2']]);
    assert.equal(readEvents(files.get(layoutPaths(LOG).segment(1)) ?? '').events.length, 3);
  });

  it('reads the working set, and the whole history on demand', async () => {
    const { register } = await rotated();
    const working = await register.snapshot();
    assert.deepEqual([[...working.state.tasks.keys()], working.retired], [['T2'], { count: 1, lastWeek: null }]);
    const history = await register.history();
    assert.deepEqual([[...history.state.tasks.keys()], history.retired], [['T1', 'T2'], null]);
  });

  it('names a retired task as archived instead of changing it, and an id never handed out as unknown', async () => {
    const { files, register } = await rotated();
    const before = files.get(LOG);
    assert.equal(errorOf(await register.setStatus('alpha', 'T1', { status: 'open' })), 'no task T1 in the working set: if it was finished long ago it is archived (teamrig show T1)');
    assert.equal(errorOf(await register.update('lead', 'T9', { priority: 2 }, undefined)), 'no task T9');
    assert.equal(files.get(LOG), before);
  });

  it('refuses to write when a newer teamrig wrote the snapshot', async () => {
    const { files, register } = await rotated();
    await files.write(layoutPaths(LOG).snapshot, `${JSON.stringify({ v: 9, type: 'snapshot' })}
`);
    await assert.rejects(register.add('lead', { title: 'x', owner: 'alpha', source: 'owner', priority: 1 }), NewerDataError);
    const { read } = await register.snapshot();
    assert.deepEqual([read.newer, read.newestVersion], [1, 9]);
  });
});

describe('Register.addFromParent', () => {
  it('writes the task as the parent lead, who is on no roster here, and lands it with the lead', async () => {
    const { files, register } = setup();
    const { task, event } = written(await register.addFromParent('app/lead', { title: 'Ship login', owner: 'lead', source: 'app/lead', priority: 1 }));
    assert.deepEqual([task.id, task.owner, task.source, task.createdBy, event.by], ['T1', 'lead', 'app/lead', 'app/lead', 'app/lead']);
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
    assert.match(errorOf(await register.add('app/lead', { title: 'Other', owner: 'lead', source: 'lead', priority: 1 })), /app.lead is not a session on this team/);
    assert.match(errorOf(await register.addFromParent('app/lead', { title: 'Ship login', owner: 'lead', source: 'app/lead', priority: 1 })), /T1 already tracks this/);
  });
});
