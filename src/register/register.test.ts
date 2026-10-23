import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { TEST_CARD } from '../testing/card.ts';
import { TimeZone } from '../core/zone.ts';
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
    zone: TimeZone.UTC,
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
    const first = written(await register.add('lead', { title: 'First', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    const second = written(await register.add('lead', { title: 'Second', description: 'what and why', owner: 'bravo', source: 'lead', priority: 2 }));

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
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
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

  it('writes a verify-by date as an update before the verifying status, in one append', async () => {
    const { files, register } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    written(await register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    const appended = files.get(LOG)?.length ?? 0;
    const result = written(await register.setStatus('alpha', 'T1', { status: 'verifying', note: 'shipped', proof: 'the nightly run', due: '2030-01-09', followups: [] }));
    assert.deepEqual([result.task.status, result.task.due, result.task.proof], ['verifying', '2030-01-09', 'the nightly run']);
    const lines = readEvents((files.get(LOG) ?? '').slice(appended)).events;
    assert.deepEqual(
      lines.map((event) => event.type),
      ['update', 'status'],
    );
    assert.deepEqual(lines[1], result.event);
    assert.deepEqual(lines[0]?.type === 'update' ? lines[0].changes : undefined, { due: '2030-01-09' });
  });

  it('checks a cited skill against the catalog, but never `none`', async () => {
    const { register, skills } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    const close = { status: 'done' as const, note: 'shipped', evidence: 'abc1234', followups: [] };

    assert.match(errorOf(await register.setStatus('alpha', 'T1', { ...close, skill: ' web-build ' })), /no skill named web-build/);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, skill: 'none' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build']);
    assert.equal((await register.setStatus('alpha', 'T1', { ...close, note: 'again', skill: 'web-deploy' })).ok, true);
    assert.deepEqual(skills.asked, ['web-build', 'web-deploy']);
  });

  it('lets the lead reassign, which restarts the pick-up clock', async () => {
    const { clock, register } = setup();
    const added = written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    assert.equal(added.before, null, 'a new task has no before');
    clock.advance(3_600_000);
    const result = written(await register.update('lead', 'T1', { owner: 'bravo' }, 'alpha is out'));
    assert.equal(result.task.owner, 'bravo');
    assert.equal(result.before?.owner, 'alpha', 'the write names the owner it took the task from');
    assert.equal(result.task.assignedAt, '2030-01-07T10:00:00.000Z');
    assert.equal(result.task.ownerSeenAt, null);
  });

  it("keeps one pin per owner: a new pin first unpins the owner's earlier one, in the same append (T637)", async () => {
    const { files, register } = setup();
    for (const title of ['First', 'Second', 'Third']) {
      written(await register.add('lead', { title, description: 'what and why', owner: 'alpha', source: 'owner', priority: 2 }));
    }
    written(await register.add('lead', { title: 'Elsewhere', description: 'what and why', owner: 'bravo', source: 'owner', priority: 2 }));
    written(await register.update('lead', 'T4', { pin: 'lead' }, undefined));
    assert.equal(written(await register.update('lead', 'T1', { pin: 'lead' }, undefined)).task.pin, 'lead', "bravo's pin is no rival");
    const appended = files.get(LOG)?.length ?? 0;
    const moved = written(await register.update('lead', 'T2', { pin: 'lead' }, 'first now'));
    assert.equal(moved.task.pin, 'lead');
    const lines = readEvents((files.get(LOG) ?? '').slice(appended)).events;
    assert.deepEqual(
      lines.map((event) => (event.type === 'update' ? [event.id, event.changes, event.note] : [event.id])),
      [['T1', { pin: null }, 'the pin moved to T2'], ['T2', { pin: 'lead' }, 'first now']],
    );
    assert.deepEqual(lines[1], moved.event);
    const before = files.get(LOG)?.length ?? 0;
    assert.equal(written(await register.update('lead', 'T2', { pin: null }, undefined)).task.pin, null);
    assert.equal(readEvents((files.get(LOG) ?? '').slice(before)).events.length, 1, 'an unpin moves nothing');
    written(await register.update('lead', 'T3', { pin: 'lead' }, undefined));
    assert.equal(written(await register.update('lead', 'T3', { owner: 'bravo' }, undefined)).task.pin, null, 'handing it on clears it');
    assert.match(errorOf(await register.update('alpha', 'T1', { pin: 'alpha' }, undefined)), /alpha does not pin its own T1/);
  });

  it('refuses unknown callers before taking the lock, and leaves the log alone on any refusal', async () => {
    const { files, mutex, register } = setup();
    assert.match(errorOf(await register.add('charlie', { title: 'x', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 })), /charlie/);
    assert.equal(mutex.runs, 0);
    assert.match(errorOf(await register.setStatus('alpha', 'T7', { status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], note: 'x' })), /no task T7/);
    assert.match(errorOf(await register.update('alpha', 'T7', { priority: 2 }, undefined)), /no task T7/);
    assert.match(errorOf(await register.add('lead', { title: 'x', description: 'what and why', owner: 'alpha', source: 'owner', priority: 9 })), /priority p9/);
    assert.equal(files.get(LOG), undefined);
  });

  it('refuses to write beside lines from a newer format', async () => {
    const newer = `${JSON.stringify({ v: EVENT_VERSION + 1, type: 'create', id: 'T1' })}\n`;
    const { files, register } = setup({ [LOG]: newer });
    await assert.rejects(register.add('lead', { title: 'x', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }), NewerDataError);
    assert.equal(files.get(LOG), newer);
  });

  it('writes beside a status from a newer teamrig, keeps the line and skips archiving the log', async () => {
    const created = { v: EVENT_VERSION, type: 'create', id: 'T1', at: START, by: 'lead', task: { title: 'x', owner: 'alpha', source: 'owner', ref: null, priority: 1, due: null, goals: [], week: null } };
    const future = { v: EVENT_VERSION, type: 'status', id: 'T1', at: START, by: 'alpha', status: 'paused', note: 'n' };
    const text = `${JSON.stringify(created)}\n${JSON.stringify(future)}\n`;
    const { files, register } = setup({ [LOG]: text });
    const result = written(await register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    assert.equal(result.task.status, 'in-progress');
    assert.ok(files.get(LOG)?.startsWith(text));
  });

  it('reads a snapshot without the lock', async () => {
    const { mutex, register } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    const runs = mutex.runs;
    const { state, read } = await register.snapshot();
    assert.equal(mutex.runs, runs);
    assert.equal(state.tasks.size, 1);
    assert.equal(read.unreadable, 0);
  });
});

describe('Register.ask', () => {
  const ASK = { owner: 'bravo', title: 'Land the schema change', due: '2030-01-10' };

  async function started() {
    const kit = setup();
    written(await kit.register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1, goals: ['launch'] }));
    written(await kit.register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    return kit;
  }

  it('adds the asked task and sets the caller waiting on it, in one append under one lock', async () => {
    const { files, mutex, register } = await started();
    const appended = files.get(LOG)?.length ?? 0;
    const runs = mutex.runs;
    const verdict = await register.ask('alpha', 'T1', ASK, { status: 'waiting' });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
    const { asked, task, before, events, event } = verdict.value;
    assert.deepEqual(
      [asked.id, asked.owner, asked.source, asked.priority, asked.due, asked.goals, asked.status],
      ['T2', 'bravo', 'alpha', 1, '2030-01-10', ['launch'], 'open'],
    );
    assert.deepEqual([task.id, task.status, task.waits, task.note], ['T1', 'waiting', [{ kind: 'task', id: 'T2' }], 'Land the schema change']);
    assert.equal(before?.status, 'in-progress');
    assert.equal(mutex.runs, runs + 1);
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, events);
    assert.deepEqual(events.map((written) => `${written.type} ${written.id}`), ['create T2', 'status T1']);
    assert.equal(event, events[1]);
  });

  it('keeps the reasons and note given, the asked task last', async () => {
    const { register } = await started();
    const verdict = await register.ask('alpha', 'T1', ASK, { status: 'waiting', note: 'needs the new column', waits: [{ kind: 'decision', who: 'owner' }], card: { ...TEST_CARD, whyAsk: 'the ordered column breaks the export' } });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
    assert.deepEqual(verdict.value.task.waits, [{ kind: 'decision', who: 'owner' }, { kind: 'task', id: 'T2' }]);
    assert.equal(verdict.value.task.note, 'needs the new column');
  });

  it('writes nothing when the ask or the status is refused', async () => {
    const { files, register } = await started();
    const log = files.get(LOG);
    assert.match(errorOf(await register.ask('alpha', 'T7', ASK, { status: 'waiting' })), /no task T7/);
    assert.equal(errorOf(await register.ask('bravo', 'T1', ASK, { status: 'waiting' })), 'only the owner (alpha) sets the status of T1');
    assert.match(errorOf(await register.ask('alpha', 'T1', ASK, { status: 'waiting', waits: [{ kind: 'approval', who: 'bravo' }] })), /^approval bravo: decision and approval waits/);
    assert.match(errorOf(await register.ask('alpha', 'T1', ASK, { status: 'waiting', skill: 'web-deploy' })), /--skill goes only with done/);
    assert.equal(files.get(LOG), log);
  });
});

describe('Register on a rotated log', () => {
  async function rotated() {
    const world = setup();
    const { clock, files, register } = world;
    written(await register.add('lead', { title: 'Old', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    written(await register.setStatus('alpha', 'T1', { status: 'done', note: 'shipped', evidence: 'abc1234', skill: 'none', followups: [] }));
    written(await register.add('lead', { title: 'Open', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    clock.advance(10 * 86_400_000);
    await rotateRegister(files, LOG, { now: new Date(clock.now()) });
    return world;
  }

  it('writes after the marker, numbering on from the whole history', async () => {
    const { files, register } = await rotated();
    const added = written(await register.add('lead', { title: 'New', description: 'what and why', owner: 'bravo', source: 'lead', priority: 2 }));
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
    await assert.rejects(register.add('lead', { title: 'x', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }), NewerDataError);
    const { read } = await register.snapshot();
    assert.deepEqual([read.newer, read.newestVersion], [1, 9]);
  });
});

describe('Register.addFromParent', () => {
  it('writes the task as the parent lead, who is on no roster here, and lands it with the lead', async () => {
    const { files, register } = setup();
    const { task, event } = written(await register.addFromParent('app/lead', { title: 'Ship login', description: 'what and why', owner: 'lead', source: 'app/lead', priority: 1 }));
    assert.deepEqual([task.id, task.owner, task.source, task.createdBy, event.by], ['T1', 'lead', 'app/lead', 'app/lead', 'app/lead']);
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
    assert.match(errorOf(await register.add('app/lead', { title: 'Other', description: 'what and why', owner: 'lead', source: 'lead', priority: 1 })), /app.lead is not a session on this team/);
    assert.match(errorOf(await register.addFromParent('app/lead', { title: 'Ship login', description: 'what and why', owner: 'lead', source: 'app/lead', priority: 1 })), /T1 already tracks this/);
  });
});

describe('Register, the GitHub import', () => {
  const ISSUE = { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 };
  const URL = 'https://github.com/acme/web/issues/7';

  it('writes its own tasks as github, under the lock, and keeps each issue to one task', async () => {
    const { files, register } = setup();
    const { task, event } = written(await register.importAdd(ISSUE));
    assert.deepEqual([task.id, task.source, task.ref, task.owner, task.createdBy, event.by], ['T1', 'github', 'gh:acme/web#7', 'bravo', 'github', 'github']);
    assert.equal(errorOf(await register.importAdd(ISSUE)), 'T1 already has ref gh:acme/web#7');
    const renamed = written(await register.importUpdate('T1', { title: 'Fix the login', priority: 1 }, 'title changed on GitHub'));
    assert.deepEqual([renamed.task.title, renamed.task.priority, renamed.event.by], ['Fix the login', 1, 'github']);
    const closed = written(await register.importStatus('T1', { status: 'done', note: 'closed on GitHub as completed', evidence: URL }));
    assert.deepEqual([closed.task.status, closed.task.evidence, closed.task.skill, closed.event.by], ['done', URL, null, 'github']);
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 3);
  });

  it('leaves a team task alone, and is no session that may write through the team path', async () => {
    const { files, register } = setup();
    written(await register.add('lead', { title: 'Ship login', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1, ref: 'gh:acme/web#7' }));
    assert.equal(errorOf(await register.importStatus('T1', { status: 'done', evidence: URL })), 'T1 is not a GitHub task (source lead): the import changes only its own');
    assert.equal(errorOf(await register.importUpdate('T1', { title: 'Other' }, 'x')), 'T1 is not a GitHub task (source lead): the import changes only its own');
    assert.match(errorOf(await register.setStatus('github', 'T1', { status: 'done', evidence: URL, skill: 'none' })), /github is not a session on this team/);
    assert.match(errorOf(await register.importStatus('T9', { status: 'open' })), /T9/);
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
  });
});

describe('Register.approve (T684)', () => {
  async function asking() {
    const kit = setup();
    written(await kit.register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    written(await kit.register.setStatus('alpha', 'T1', { status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }], note: 'branch t1, lands the fix' }));
    return kit;
  }

  it("writes the lead's answer as one update line that changes no field", async () => {
    const { files, register } = await asking();
    const appended = files.get(LOG)?.length ?? 0;
    const { task, event } = written(await register.approve('lead', 'T1', 'approved', 'tests green, small commits'));
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, [event]);
    assert.deepEqual(event, { v: EVENT_VERSION, type: 'update', id: 'T1', at: START, by: 'lead', changes: {}, note: 'tests green, small commits', verdict: 'approved' });
    assert.deepEqual([task.status, task.note, task.answer?.verdict], ['waiting', 'branch t1, lands the fix', 'approved']);
  });

  it('writes nothing when the policy refuses it', async () => {
    const { files, register } = await asking();
    const before = files.get(LOG);
    assert.match(errorOf(await register.approve('alpha', 'T1', 'approved', 'mine')), /only the lead/);
    assert.equal(files.get(LOG), before);
  });
});
