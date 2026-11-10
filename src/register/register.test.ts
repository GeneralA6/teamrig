import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { KitConfig } from '../config/types.ts';
import type { SessionAddress } from '../core/address.ts';
import { NewerDataError } from '../core/jsonl.ts';
import { TEST_OWNER_CARD } from '../testing/card.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { testTask } from '../testing/task.ts';
import { EVENT_VERSION, TASK_LINE_VERSION } from './events.ts';
import { layoutPaths } from './layout.ts';
import { OWN_NUMBERS, type TaskNumbering } from './numbering.ts';
import { RegisterPolicy, type Verdict } from './policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register, type ElsewhereReader, type GoalTagsReader, type SkillCatalog, type WriteResult } from './register.ts';
import { readEvents } from './snapshot.ts';
import { JsonlEventLog } from './store.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from './tree.ts';

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

/** The tasks a team tree's other registers hold, fixed: counts the writes that read them. */
class FixedElsewhere implements ElsewhereReader {
  reads = 0;
  private readonly tasks: TasksElsewhere;

  constructor(tasks: TasksElsewhere) {
    this.tasks = tasks;
  }

  async read(): Promise<TasksElsewhere> {
    this.reads += 1;
    return this.tasks;
  }
}

/** A numbering shared with registers whose next number is `floor`: counts the creates it numbered. */
class FloorNumbering implements TaskNumbering {
  issued = 0;
  floor: number;

  constructor(floor: number) {
    this.floor = floor;
  }

  async issue<T>(write: (floor: number) => Promise<T>): Promise<T> {
    this.issued += 1;
    return write(this.floor);
  }
}

/** The goal tags of a team's goal records and those above it, fixed: counts the writes that read them (T1730). */
class FixedGoals implements GoalTagsReader {
  reads = 0;
  private readonly tags: ReadonlySet<string>;

  constructor(tags: readonly string[]) {
    this.tags = new Set(tags);
  }

  async read(): Promise<ReadonlySet<string>> {
    this.reads += 1;
    return this.tags;
  }
}

/** The goal records a register's writes read, and the config that says how they hold its tasks' goal tags. */
interface GoalSetup {
  readonly goals: GoalTagsReader;
  readonly config: KitConfig;
}

const NO_GOAL_SETUP: GoalSetup = { goals: NO_GOAL_RECORDS, config: testConfig() };

/** `above`: the parent team's lead, on a child team (T1140). */
function setup(
  initial: Readonly<Record<string, string>> = {},
  numbering: TaskNumbering = OWN_NUMBERS,
  elsewhere: ElsewhereReader = NOTHING_ELSEWHERE,
  above?: SessionAddress,
  { goals, config }: GoalSetup = NO_GOAL_SETUP,
) {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock(START);
  const mutex = new InlineMutex();
  const skills = new FakeSkills(['web-deploy']);
  const register = new Register({
    log: new JsonlEventLog(files, LOG),
    mutex,
    numbering,
    elsewhere,
    goals,
    clock,
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(config, above),
    skills,
    autoArchive: true,
  });
  return { files, clock, mutex, skills, register };
}

function written(verdict: Verdict<WriteResult>): WriteResult {
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
  return verdict.value;
}

function errorOf<T>(verdict: Verdict<T>): string {
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
    assert.deepEqual(read.events.map((event) => event.v), [TASK_LINE_VERSION, TASK_LINE_VERSION]);
  });

  it('records the status change and returns the task after it', async () => {
    const { clock, register } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    clock.advance(60_000);
    const result = written(await register.setStatus('alpha', 'T1', { status: 'in-progress' }));
    assert.equal(result.task.status, 'in-progress');
    assert.equal(result.task.ownerSeenAt, '2030-01-07T09:01:00.000Z');
    assert.deepEqual(result.event, {
      v: TASK_LINE_VERSION,
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
    const result = written(await register.setStatus('alpha', 'T1', { status: 'verifying', note: 'shipped', proof: 'the nightly run', waits: [{ kind: 'time', at: '2030-01-08 22:00' }], due: '2030-01-09', followups: [] }));
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

  it('writes the size base an update is given only when it gives a size, and the task keeps it (T649)', async () => {
    const { register } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1, size: 1 }));
    const base = { day: '2030-01-07', w: 12_000_000 };
    const sized = written(await register.update('alpha', 'T1', { size: 0.5 }, undefined, base));
    assert.deepEqual([sized.event.type === 'update' ? sized.event.sizeBase : undefined, sized.task.sizeBase], [base, base]);
    const other = written(await register.update('alpha', 'T1', { priority: 2 }, undefined, { day: '2030-01-07', w: 13_000_000 }));
    assert.deepEqual([other.event.type === 'update' ? other.event.sizeBase : 'not an update', other.task.sizeBase], [undefined, base], 'a base with no size is not written');
    const cleared = written(await register.update('alpha', 'T1', { size: null }, undefined, base));
    assert.deepEqual([cleared.event.type === 'update' ? cleared.event.sizeBase : 'not an update', cleared.task.sizeBase], [undefined, null], 'clearing the size writes no base');
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

  it('refuses a write on a task that moved to another team, and still writes the others (T1144)', async () => {
    const created = { v: TASK_LINE_VERSION, type: 'create', id: 'T1', at: START, by: 'lead', task: { title: 'x', owner: 'alpha', source: 'owner', ref: null, priority: 1, due: null, goals: [], week: null } };
    const moved = { v: EVENT_VERSION, type: 'moved', id: 'T1', at: START, by: 'lead', to: 'web' };
    const text = `${JSON.stringify(created)}\n${JSON.stringify(moved)}\n`;
    const { files, register } = setup({ [LOG]: text });
    assert.equal(errorOf(await register.setStatus('alpha', 'T1', { status: 'in-progress' })), 'T1 moved to team web: only a session of team web changes it');
    assert.equal(files.get(LOG), text);
    const next = written(await register.add('lead', { title: 'Next', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    assert.equal(next.task.id, 'T2', 'the moved id stays taken');
  });

  it('moves tasks out under the lock: appends the events the move decides on, and nothing on a refusal (T1144)', async () => {
    const { files, mutex, register } = setup();
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 }));
    const before = files.get(LOG);
    const refused = await register.moveOut('lead', async (snapshot) => {
      assert.ok(snapshot.state.tasks.has('T1'));
      return { ok: false, error: 'not now' };
    });
    assert.deepEqual(refused, { ok: false, error: 'not now' });
    assert.equal(files.get(LOG), before);
    const runs = mutex.runs;
    const moved = await register.moveOut('lead', async () => ({ ok: true, value: [{ v: EVENT_VERSION, type: 'moved', id: 'T1', at: START, by: 'lead', to: 'web' }] }));
    assert.ok(moved.ok);
    assert.equal(moved.value.moved.get('T1'), 'web');
    assert.equal(moved.value.tasks.has('T1'), false);
    assert.equal(mutex.runs, runs + 1);
    assert.equal((await register.snapshot()).state.moved.get('T1'), 'web');
    const none = await register.moveOut('lead', async () => ({ ok: true, value: [] }));
    assert.ok(none.ok);
    assert.equal(files.get(LOG)?.split('\n').filter((line) => line !== '').length, 2);
  });

  it('refuses a move by a session off the roster, and one beside lines from a newer format', async () => {
    const { register } = setup();
    const never = async (): Promise<Verdict<readonly []>> => assert.fail('the move must not run');
    assert.match(errorOf(await register.moveOut('charlie', never)), /charlie/);
    const newer = `${JSON.stringify({ v: EVENT_VERSION + 1, type: 'create', id: 'T1' })}\n`;
    await assert.rejects(setup({ [LOG]: newer }).register.moveOut('lead', never), NewerDataError);
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
    const verdict = await register.ask('alpha', 'T1', ASK, { status: 'waiting', note: 'needs the new column', waits: [{ kind: 'decision', who: 'owner' }], card: { ...TEST_OWNER_CARD, whyAsk: 'the ordered column breaks the export' } });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
    assert.deepEqual(verdict.value.task.waits, [{ kind: 'decision', who: 'owner' }, { kind: 'task', id: 'T2' }]);
    assert.equal(verdict.value.task.note, 'needs the new column');
  });

  it('writes nothing when the ask or the status is refused', async () => {
    const { files, register } = await started();
    const log = files.get(LOG);
    assert.match(errorOf(await register.ask('alpha', 'T7', ASK, { status: 'waiting' })), /no task T7/);
    assert.equal(errorOf(await register.ask('bravo', 'T1', ASK, { status: 'waiting' })), 'only the owner (alpha) sets the status of T1');
    assert.match(errorOf(await register.ask('alpha', 'T1', ASK, { status: 'waiting', waits: [{ kind: 'approval', who: 'bravo' }] })), /^approval bravo: approval waits are for the lead \(lead\) and owner/);
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

describe('Register.addFromTeam', () => {
  it('writes the task as the asker, who is on no roster here, and lands it with the owner asked', async () => {
    const { files, register } = setup();
    const { task, event } = written(await register.addFromTeam('app/alpha', { title: 'Ship login', description: 'what and why', owner: 'bravo', source: 'app/alpha', priority: 1 }));
    assert.deepEqual([task.id, task.owner, task.source, task.createdBy, event.by], ['T1', 'bravo', 'app/alpha', 'app/alpha', 'app/alpha']);
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
    assert.match(errorOf(await register.add('app/lead', { title: 'Other', description: 'what and why', owner: 'lead', source: 'lead', priority: 1 })), /app.lead is not a session on this team/);
    assert.match(errorOf(await register.addFromTeam('app/lead', { title: 'Ship login', description: 'what and why', owner: 'lead', source: 'app/lead', priority: 1 })), /T1 already tracks this/);
  });
});

describe('Register.relayFromTeam (T2314)', () => {
  it("writes an owner's order as the relaying lead, on no roster here, sourced owner, and refuses an address source", async () => {
    const { files, register } = setup();
    const { task, event } = written(await register.relayFromTeam('app/lead', { title: 'Ship login', description: 'what and why', owner: 'bravo', source: 'owner', priority: 1 }));
    assert.deepEqual([task.id, task.owner, task.source, task.createdBy, event.by], ['T1', 'bravo', 'owner', 'app/lead', 'app/lead']);
    assert.equal(errorOf(await register.relayFromTeam('app/lead', { title: 'Other', description: 'what and why', owner: 'bravo', source: 'app/lead', priority: 1 })), "source app/lead is not owner: a relayed task is owner's order");
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
  });
});

describe('Register.noteFrom', () => {
  it('writes a note as the lead who asks the owner, on no roster here, and changes nothing else on the task', async () => {
    const { files, register } = setup();
    written(await register.add('lead', { title: 'Ship login', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 }));
    const { task, before, event } = written(await register.noteFrom('app/lead', 'T1', 'human decided: ship it'));
    assert.deepEqual([event.by, event.type === 'update' ? event.note : undefined], ['app/lead', 'human decided: ship it']);
    assert.deepEqual([task.owner, task.status, task.title, task.priority, task.note], [before?.owner, before?.status, before?.title, before?.priority, before?.note]);
    assert.match(errorOf(await register.update('app/lead', 'T1', {}, 'x')), /app.lead is not a session on this team/);
    assert.equal(errorOf(await register.noteFrom('app/lead', 'T1', ' ')), 'nothing to change: give a field or a --note');
    assert.equal(errorOf(await register.noteFrom('app/lead', 'T9', 'x')), 'no task T9');
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 2);
  });
});

describe('Register.triage and triageFrom (T2086)', () => {
  const INPUT = { title: 'Ship login', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 } as const;
  const BASE = { day: '2030-01-07', w: 12_000_000 };

  it('writes a confirmed row as the lead, goals included, with the size base', async () => {
    const { register } = setup();
    written(await register.add('lead', INPUT));
    const { task, event } = written(await register.triage('lead', 'T1', { workClass: 'Roadmap', goals: ['A1'], size: 1.5 }, BASE));
    assert.deepEqual([task.workClass, task.goals, task.size, task.sizeBase, event.by], ['Roadmap', ['A1'], 1.5, BASE, 'lead']);
  });

  it('carries no size base on a row that gives no size', async () => {
    const { register } = setup();
    written(await register.add('lead', INPUT));
    const { event } = written(await register.triage('alpha', 'T1', { workClass: 'Maintenance' }, BASE));
    assert.equal(event.type === 'update' ? event.sizeBase : 'not an update', undefined);
  });

  it('refuses a caller off the roster and one who neither owns nor leads the task, writing nothing', async () => {
    const { files, register } = setup();
    written(await register.add('lead', INPUT));
    assert.match(errorOf(await register.triage('app/lead', 'T1', { size: 1 })), /app.lead is not a session on this team/);
    assert.equal(errorOf(await register.triage('bravo', 'T1', { size: 1 })), 'only the owner (alpha) or the lead (lead) changes T1');
    assert.equal(readEvents(files.get(LOG) ?? '').events.length, 1);
  });

  it('writes as the lead above with triageFrom, on no roster here, the field rules still holding', async () => {
    const { register } = setup();
    written(await register.add('lead', INPUT));
    const { task, event } = written(await register.triageFrom('app/lead', 'T1', { workClass: 'Maintenance', goals: ['A1'] }));
    assert.deepEqual([task.workClass, task.goals, event.by], ['Maintenance', ['A1'], 'app/lead']);
    assert.match(errorOf(await register.triageFrom('app/lead', 'T1', { workClass: 'Chores' })), /Chores/);
    assert.equal(errorOf(await register.triageFrom('app/lead', 'T9', { size: 1 })), 'no task T9');
  });

  it('reads the goal records only for a row that names goals, and holds the tags to them', async () => {
    const goals = new FixedGoals(['A1']);
    const { register } = setup({}, OWN_NUMBERS, NOTHING_ELSEWHERE, undefined, { goals, config: testConfig({ register: { goals: 'checked' } }) });
    written(await register.add('lead', INPUT));
    written(await register.triage('lead', 'T1', { size: 1 }));
    assert.equal(goals.reads, 0);
    assert.match(errorOf(await register.triage('lead', 'T1', { goals: ['Z9'] })), /goal Z9 is not a goal record/);
    written(await register.triage('lead', 'T1', { goals: ['A1'] }));
    assert.equal(goals.reads, 2);
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

describe('Register in a shared numbering (T1139)', () => {
  const INPUT = { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 } as const;

  it('issues the floor when the other registers are ahead, its own next number once it is past them', async () => {
    const numbering = new FloorNumbering(40);
    const { register } = setup({}, numbering);
    assert.equal(written(await register.add('lead', INPUT)).task.id, 'T40');
    assert.equal(written(await register.add('lead', { ...INPUT, title: 'Next' })).task.id, 'T41');
    numbering.floor = 1;
    assert.equal(written(await register.add('lead', { ...INPUT, title: 'Last' })).task.id, 'T42');
    assert.equal(numbering.issued, 3);
  });

  it('numbers an asked task, a task from the parent lead and an imported issue the same way', async () => {
    const numbering = new FloorNumbering(10);
    const { register } = setup({}, numbering);
    written(await register.add('lead', INPUT));
    written(await register.setStatus('alpha', 'T10', { status: 'in-progress' }));
    numbering.floor = 50;
    const asked = await register.ask('alpha', 'T10', { owner: 'bravo', title: 'Land the schema change', due: '2030-01-10' }, { status: 'waiting' });
    assert.ok(asked.ok, asked.ok ? '' : asked.error);
    assert.deepEqual([asked.value.asked.id, asked.value.task.waits], ['T50', [{ kind: 'task', id: 'T50' }]]);
    numbering.floor = 60;
    assert.equal(written(await register.addFromTeam('app/lead', { ...INPUT, title: 'Ship login', owner: 'lead', source: 'app/lead' })).task.id, 'T60');
    numbering.floor = 70;
    assert.equal(written(await register.importAdd({ title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 })).task.id, 'T70');
    assert.equal(numbering.issued, 4);
  });

  it('takes no number for a write that creates no task, or a caller off the roster', async () => {
    const numbering = new FloorNumbering(5);
    const { register } = setup({}, numbering);
    written(await register.add('lead', INPUT));
    written(await register.setStatus('alpha', 'T5', { status: 'in-progress' }));
    written(await register.update('lead', 'T5', { priority: 2 }, undefined));
    assert.match(errorOf(await register.add('mallory', { ...INPUT, title: 'Other' })), /mallory is not a session on this team/);
    assert.equal(numbering.issued, 1);
  });
});

describe("Register beside its tree's other registers (T1139)", () => {
  const INPUT = { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'owner', priority: 1 } as const;
  const HELD: TasksElsewhere = new Map([['T7', { team: 'app', task: testTask({ id: 'T7', owner: 'lead', status: 'in-progress' }) }]]);

  it('reads the tasks held elsewhere with the working set only once an active task needs an id the working set lacks', async () => {
    const elsewhere = new FixedElsewhere(HELD);
    const { register } = setup({}, new FloorNumbering(8), elsewhere);
    written(await register.add('lead', INPUT));
    const byWrites = elsewhere.reads;
    const home = await register.snapshotWithElsewhere();
    assert.equal(home.snapshot.state.tasks.has('T8'), true);
    assert.equal(home.elsewhere, NO_TASKS_ELSEWHERE);
    assert.equal(elsewhere.reads, byWrites, 'a working set that needs nothing elsewhere reads one log');
    written(await register.setStatus('alpha', 'T8', { status: 'in-progress' }));
    written(await register.setStatus('alpha', 'T8', { status: 'waiting', waits: [{ kind: 'task', id: 'T7' }], note: 'needs the app login' }));
    const needing = await register.snapshotWithElsewhere();
    assert.equal(needing.elsewhere, HELD);
  });

  it('judges each write with the tasks held elsewhere, read once per write, and returns them with it', async () => {
    const elsewhere = new FixedElsewhere(HELD);
    const { register } = setup({}, new FloorNumbering(8), elsewhere);
    written(await register.add('lead', INPUT));
    written(await register.setStatus('alpha', 'T8', { status: 'in-progress' }));
    const waiting = written(await register.setStatus('alpha', 'T8', { status: 'waiting', waits: [{ kind: 'task', id: 'T7' }], note: 'needs the app login' }));
    assert.deepEqual(waiting.task.waits, [{ kind: 'task', id: 'T7' }]);
    assert.equal(waiting.elsewhere, HELD);
    assert.equal(elsewhere.reads, 3);
  });

  it("refuses to change another register's task, naming its team, and writes nothing", async () => {
    const { register, files } = setup({}, new FloorNumbering(8), new FixedElsewhere(HELD));
    const refusal = /^T7 is team app's task \(owner lead\): only a session of team app changes it$/;
    assert.match(errorOf(await register.setStatus('alpha', 'T7', { status: 'in-progress' })), refusal);
    assert.match(errorOf(await register.update('lead', 'T7', { priority: 1 }, undefined)), refusal);
    assert.match(errorOf(await register.approve('lead', 'T7', 'approved', undefined)), refusal);
    assert.equal(files.get(LOG), undefined);
  });
});

describe("Register: goal tags held to the team tree's goal records (T1730)", () => {
  const INPUT = { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'lead', priority: 2 } as const;
  const UNKNOWN_Z9 = 'goal Z9 is not a goal record of the team or a team above: teamrig goal list lists them';

  function checked(tags: readonly string[]) {
    const goals = new FixedGoals(tags);
    return { goals, ...setup({}, OWN_NUMBERS, NOTHING_ELSEWHERE, undefined, { goals, config: testConfig({ register: { goals: 'checked' } }) }) };
  }

  it('reads the goal records only for a write that names goals, once per write', async () => {
    const { goals, register } = checked(['A1']);
    written(await register.add('lead', INPUT));
    written(await register.update('alpha', 'T1', { priority: 1 }, 'sooner'));
    written(await register.update('alpha', 'T1', { goals: [], noGoal: true }, undefined));
    assert.equal(goals.reads, 0);
    written(await register.add('lead', { ...INPUT, title: 'Ship the docs', goals: ['A1'] }));
    written(await register.update('alpha', 'T1', { goals: ['A1'] }, undefined));
    written(await register.addFromTeam('app/lead', { ...INPUT, title: 'Ship login', source: 'app/lead', goals: ['A1'] }));
    assert.equal(goals.reads, 3);
  });

  it('refuses a goal tag no goal record holds, on add, update and a task from another team, and writes nothing', async () => {
    const { register, files } = checked(['A1']);
    assert.equal(errorOf(await register.add('lead', { ...INPUT, goals: ['Z9'] })), UNKNOWN_Z9);
    assert.equal(errorOf(await register.addFromTeam('app/lead', { ...INPUT, source: 'app/lead', goals: ['Z9'] })), UNKNOWN_Z9);
    assert.equal(files.get(LOG), undefined);
    written(await register.add('lead', INPUT));
    assert.equal(errorOf(await register.update('alpha', 'T1', { goals: ['Z9'] }, undefined)), UNKNOWN_Z9);
    assert.equal(written(await register.update('alpha', 'T1', { goals: ['A1'] }, undefined)).task.goals.join(','), 'A1');
  });

  it('reads no goal records for a caller off the roster', async () => {
    const { goals, register } = checked(['A1']);
    assert.match(errorOf(await register.add('mallory', { ...INPUT, goals: ['A1'] })), /mallory is not a session on this team/);
    assert.match(errorOf(await register.update('mallory', 'T1', { goals: ['A1'] }, undefined)), /mallory is not a session on this team/);
    assert.equal(goals.reads, 0);
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
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: START, by: 'lead', changes: {}, note: 'tests green, small commits', verdict: 'approved' });
    assert.deepEqual([task.status, task.note, task.answer?.verdict], ['waiting', 'branch t1, lands the fix', 'approved']);
  });

  it('writes nothing when the policy refuses it', async () => {
    const { files, register } = await asking();
    const before = files.get(LOG);
    assert.match(errorOf(await register.approve('alpha', 'T1', 'approved', 'mine')), /only the lead/);
    assert.equal(files.get(LOG), before);
  });
});

describe('Register.approveFrom (T1140)', () => {
  it("writes the parent team's lead's answer to the child lead's approval wait, on no roster here", async () => {
    const { files, register } = setup({}, OWN_NUMBERS, NOTHING_ELSEWHERE, { team: 'app', id: 'boss' });
    written(await register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'lead', source: 'lead', priority: 1 }));
    written(await register.setStatus('lead', 'T1', { status: 'waiting', waits: [{ kind: 'approval', who: 'app/boss' }], note: 'branch t1' }));
    assert.match(errorOf(await register.approve('app/boss', 'T1', 'approved', 'ok')), /app.boss is not a session on this team/);
    const { task, event } = written(await register.approveFrom('app/boss', 'T1', 'approved', 'tests green'));
    assert.deepEqual([event.by, task.status, task.answer?.by, task.answer?.verdict], ['app/boss', 'waiting', 'app/boss', 'approved']);
    const before = files.get(LOG);
    assert.equal(errorOf(await register.approveFrom('app/other', 'T1', 'approved', 'ok')), "only the parent team's lead (app/boss) answers an approval of lead's");
    assert.equal(errorOf(await register.approveFrom('app/boss', 'T9', 'approved', 'ok')), 'no task T9');
    assert.equal(files.get(LOG), before);
  });
});

describe('Register.audit and auditFrom: a hand step file pinned for a task (T2312)', () => {
  const PIN = { path: 'C:/steps/grant-read.ps1', sha256: 'b'.repeat(64) };

  it("writes the reviewer's audit as one update line that changes no field, the task keeping the pin", async () => {
    const { files, register } = setup({}, OWN_NUMBERS, NOTHING_ELSEWHERE, undefined, { goals: NO_GOAL_RECORDS, config: testConfig({ roles: { lead: 'lead', securityReviewer: 'bravo' } }) });
    written(await register.add('lead', { title: 'Grant the read', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 }));
    const appended = files.get(LOG)?.length ?? 0;
    const { task, event } = written(await register.audit('bravo', 'T1', PIN, 'read every line'));
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, [event]);
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: START, by: 'bravo', changes: {}, note: 'read every line', audit: PIN });
    assert.deepEqual(task.audits, [{ ...PIN, by: 'bravo', at: START }]);
    const before = files.get(LOG);
    assert.match(errorOf(await register.audit('alpha', 'T1', PIN, undefined)), /core rule 11/);
    assert.equal(files.get(LOG), before);
  });

  it('writes an audit from the reviewer on a team above, on no roster here', async () => {
    const config = testConfig({ roles: { lead: 'lead', securityReviewer: 'app/sec' } });
    const { files, register } = setup({}, OWN_NUMBERS, NOTHING_ELSEWHERE, { team: 'app', id: 'boss' }, { goals: NO_GOAL_RECORDS, config });
    written(await register.add('lead', { title: 'Grant the read', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 }));
    assert.match(errorOf(await register.audit('app/sec', 'T1', PIN, undefined)), /app.sec is not a session on this team/);
    const { task, event } = written(await register.auditFrom('app/sec', 'T1', PIN, undefined));
    assert.deepEqual([event.by, task.audits], ['app/sec', [{ ...PIN, by: 'app/sec', at: START }]]);
    const before = files.get(LOG);
    assert.match(errorOf(await register.auditFrom('app/boss', 'T1', PIN, undefined)), /^app\/boss does not audit a hand step of alpha's/);
    assert.equal(errorOf(await register.auditFrom('app/sec', 'T9', PIN, undefined)), 'no task T9');
    assert.equal(files.get(LOG), before);
  });
});

describe('Register.defer and deferFrom: a Later (T1295)', () => {
  const OWNER = { kind: 'decision', who: 'owner' } as const;
  const LATER = { kind: 'time', at: '2030-01-09 09:00' } as const;

  async function asking() {
    const kit = setup();
    written(await kit.register.add('lead', { title: 'Ship it', description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 }));
    written(await kit.register.setStatus('alpha', 'T1', { status: 'waiting', waits: [OWNER], note: 'ship the export', card: TEST_OWNER_CARD }));
    return kit;
  }

  it('writes a Later as one update line that changes no field and gives the task its waits, and brings it back', async () => {
    const { files, register } = await asking();
    const appended = files.get(LOG)?.length ?? 0;
    const { task, event } = written(await register.defer('lead', 'T1', '2030-01-09 09:00', 'after the demo'));
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, [event]);
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: START, by: 'lead', changes: {}, note: 'after the demo', waits: [OWNER, LATER] });
    assert.deepEqual([task.status, task.note, task.waits], ['waiting', 'ship the export', [OWNER, LATER]]);
    const back = written(await register.defer('alpha', 'T1', null, 'asks now'));
    assert.deepEqual([back.task.waits, back.task.note], [[OWNER], 'asks now']);
  });

  it('writes nothing when the policy refuses it, or the caller is on no roster here', async () => {
    const { files, register } = await asking();
    const before = files.get(LOG);
    assert.equal(errorOf(await register.defer('bravo', 'T1', '2030-01-09 09:00', 'n')), 'only the owner (alpha) or the lead (lead) puts T1 off');
    assert.equal(errorOf(await register.defer('alpha', 'T1', '2030-01-07 08:00', 'n')), 'time 01-07 08:00 UTC has passed: name a time to come');
    assert.match(errorOf(await register.defer('app/lead', 'T1', '2030-01-09 09:00', 'n')), /app.lead is not a session on this team/);
    assert.equal(errorOf(await register.defer('alpha', 'T9', '2030-01-09 09:00', 'n')), 'no task T9');
    assert.equal(files.get(LOG), before);
  });

  it('writes a Later by the lead above, on no roster here and past the caller check, still judged on its content', async () => {
    const { files, register } = await asking();
    const { task, event } = written(await register.deferFrom('app/lead', 'T1', '2030-01-09 09:00', 'human: after the demo'));
    assert.deepEqual([event.by, task.waits], ['app/lead', [OWNER, LATER]]);
    const before = files.get(LOG);
    assert.equal(errorOf(await register.deferFrom('app/lead', 'T1', '2030-01-09 09:00', ' ')), 'a Later needs --note: what owner said');
    assert.equal(files.get(LOG), before);
  });

  it('writes a Decided as one update line that drops the wait on the owner and marks the task decided (T1366)', async () => {
    const { files, register } = await asking();
    const appended = files.get(LOG)?.length ?? 0;
    const { task, event } = written(await register.decide('lead', 'T1', 'human decided: ship it'));
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, [event]);
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: START, by: 'lead', changes: {}, note: 'human decided: ship it', waits: [], decided: true });
    assert.deepEqual([task.status, task.note, task.waits, task.decided], ['waiting', 'ship the export', [], { by: 'lead', at: START, note: 'human decided: ship it' }]);
    const before = files.get(LOG);
    assert.equal(errorOf(await register.decide('lead', 'T1', 'again')), 'T1 waits on no decision or approval of owner: only such a card is decided');
    assert.equal(errorOf(await register.decide('bravo', 'T1', 'go')), 'only the owner (alpha) or the lead (lead) records a decision on T1');
    assert.match(errorOf(await register.decide('app/lead', 'T1', 'go')), /app.lead is not a session on this team/);
    assert.equal(files.get(LOG), before);
  });

  it('writes a Decided by the lead above, on no roster here and past the caller check, still judged on its content', async () => {
    const { files, register } = await asking();
    const before = files.get(LOG);
    assert.equal(errorOf(await register.decideFrom('app/lead', 'T1', ' ')), 'a Decided needs --note: what owner decided');
    assert.equal(files.get(LOG), before);
    const { task, event } = written(await register.decideFrom('app/lead', 'T1', 'human decided: ship it'));
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: START, by: 'app/lead', changes: {}, note: 'human decided: ship it', waits: [], decided: true });
    assert.equal(task.decided?.by, 'app/lead');
  });
});

describe("Register: the owner's Note and Next from the pane (T1298)", () => {
  async function threeOfAlpha() {
    const kit = setup();
    for (const title of ['First', 'Second', 'Third']) {
      written(await kit.register.add('lead', { title, description: 'what and why', owner: 'alpha', source: 'lead', priority: 2 }));
    }
    written(await kit.register.add('lead', { title: 'Elsewhere', description: 'what and why', owner: 'bravo', source: 'lead', priority: 2 }));
    written(await kit.register.update('lead', 'T1', { pin: 'lead' }, undefined));
    written(await kit.register.update('lead', 'T4', { pin: 'lead' }, undefined));
    return kit;
  }

  it('writes a Note as the owner, on no roster here, as one update line that changes no field', async () => {
    const { files, register } = await threeOfAlpha();
    assert.match(errorOf(await register.update('owner', 'T2', {}, 'x')), /owner is not a session on this team/);
    const appended = files.get(LOG)?.length ?? 0;
    const { task, before, event } = written(await register.ownerNote('T2', 'look at the export first'));
    assert.deepEqual(readEvents((files.get(LOG) ?? '').slice(appended)).events, [event]);
    assert.deepEqual(event, { v: TASK_LINE_VERSION, type: 'update', id: 'T2', at: START, by: 'owner', changes: {}, note: 'look at the export first' });
    assert.deepEqual([task.status, task.pin, task.note, task.updatedBy], [before?.status, before?.pin, before?.note, 'owner'], "the Note stays in the history; the task's note is its session's");
  });

  it("pins a task as the owner's after unpinning its owner's earlier pin, in one append, leaving other owners' pins", async () => {
    const { files, register } = await threeOfAlpha();
    const appended = files.get(LOG)?.length ?? 0;
    const { task, state, event } = written(await register.ownerNext('T2'));
    const lines = readEvents((files.get(LOG) ?? '').slice(appended)).events;
    assert.deepEqual(
      lines.map((line) => (line.type === 'update' ? [line.id, line.by, line.changes, line.note] : [line.id])),
      [['T1', 'owner', { pin: null }, 'the pin moved to T2'], ['T2', 'owner', { pin: 'owner' }, null]],
    );
    assert.deepEqual(lines[1], event);
    assert.deepEqual([task.pin, state.tasks.get('T1')?.pin, state.tasks.get('T4')?.pin], ['owner', null, 'lead']);
  });

  it('writes nothing when the policy refuses a Note or a Next, or the task is not here', async () => {
    const { files, register } = await threeOfAlpha();
    written(await register.ownerNext('T2'));
    written(await register.setStatus('alpha', 'T3', { status: 'in-progress' }));
    const before = files.get(LOG);
    assert.equal(errorOf(await register.ownerNext('T2')), 'T2 is next already: owner put it there; a Note tells alpha more');
    assert.equal(errorOf(await register.ownerNext('T3')), 'T3 is in progress: alpha has it in hand already');
    assert.equal(errorOf(await register.ownerNote('T2', ' ')), 'a Note needs --text: what owner tells alpha');
    assert.equal(errorOf(await register.ownerNote('T9', 'x')), 'no task T9');
    assert.equal(files.get(LOG), before);
  });

  it("previews a Next without the lock or a write: the task and its owner's pins it moves down, or the same refusal", async () => {
    const { files, mutex, register } = await threeOfAlpha();
    const before = files.get(LOG);
    const runs = mutex.runs;
    const preview = await register.ownerNextPreview('T2');
    assert.ok(preview.ok, preview.ok ? '' : preview.error);
    assert.deepEqual([preview.value.task.id, preview.value.moves.map((task) => task.id)], ['T2', ['T1']]);
    const alone = await register.ownerNextPreview('T4');
    assert.deepEqual(alone.ok ? alone.value.moves : undefined, [], "bravo's only pin is the task itself");
    written(await register.setStatus('alpha', 'T3', { status: 'in-progress' }));
    const afterStart = files.get(LOG);
    assert.equal(errorOf(await register.ownerNextPreview('T3')), 'T3 is in progress: alpha has it in hand already');
    assert.deepEqual([files.get(LOG) === afterStart, before !== afterStart, mutex.runs], [true, true, runs + 1], 'only the start took the lock');
  });
});
