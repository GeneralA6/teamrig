import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { recordField, type JsonRecord } from '../core/guards.ts';
import { parseObject, VERSION_FIELD } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
import type { SizeBase } from '../register/events.ts';
import { layoutPaths } from '../register/layout.ts';
import { OWN_NUMBERS } from '../register/numbering.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register, type SkillCatalog } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { cachedWork, queuedWork, readTasks, readWork, WORK_CACHE_FILE, workWeightOf, workWeights, type WorkByPriority, type WorkTask } from './work.ts';

const { priorities } = DEFAULT_REGISTER;
/** An hour after the register's clock below: a task it finishes is done inside the like window. */
const NOW = Date.parse('2030-01-07T10:00:00.000Z');
/** Far before NOW's like window, so a task finished then measures no like task. */
const LONG_AGO = '2029-11-01T09:00:00.000Z';

/** A task as `queuedWork` reads it: unsized, of no class or type, its status set long ago unless `fields` say otherwise. */
function workTask(fields: Pick<WorkTask, 'id' | 'owner' | 'status' | 'priority'> & Partial<WorkTask>): WorkTask {
  return { statusAt: LONG_AGO, sizeBase: null, workClass: null, type: null, waits: [], ...fields };
}

/** Each session's weights by priority id, as `workWeights` maps them. */
function byPriority(weights: Readonly<Record<string, Readonly<Record<number, number>>>>): ReadonlyMap<string, WorkByPriority> {
  return new Map(Object.entries(weights).map(([session, each]) => [session, new Map(Object.entries(each).map(([id, weight]) => [Number(id), weight]))]));
}

describe('workWeights', () => {
  it("weighs each owner by its top open or in-progress task alone, under that task's priority", () => {
    const weights = workWeights(
      [
        { owner: 'alpha', status: 'in-progress', priority: 3 },
        { owner: 'alpha', status: 'open', priority: 1 },
        { owner: 'alpha', status: 'done', priority: 0 },
        { owner: 'bravo', status: 'waiting', priority: 1 },
        { owner: 'bravo', status: 'verifying', priority: 2 },
        { owner: 'charlie', status: 'open', priority: 4 },
      ],
      priorities,
    );
    // p1..p5 weigh 5..1: alpha's open p1 outranks its in-progress p3, and its done p0 is no queued work.
    assert.deepEqual(weights, byPriority({ alpha: { 1: 5 }, charlie: { 4: 2 } }));
  });

  it('weighs a session with 40 queued tasks of a priority as one with a single task of it', () => {
    const backlog = Array.from({ length: 40 }, () => ({ owner: 'alpha', status: 'open' as const, priority: 2 }));
    const weights = workWeights([...backlog, { owner: 'bravo', status: 'open', priority: 2 }], priorities);
    assert.deepEqual(weights, byPriority({ alpha: { 2: 4 }, bravo: { 2: 4 } }));
  });

  it('takes the lower priority id as the top of two tasks that weigh the same, as an unlisted priority and the last level do', () => {
    // An unlisted priority weighs 1, as p5 does.
    assert.deepEqual(workWeights([{ owner: 'alpha', status: 'open', priority: 9 }, { owner: 'alpha', status: 'open', priority: 5 }], priorities), byPriority({ alpha: { 5: 1 } }));
    assert.deepEqual(workWeights([{ owner: 'alpha', status: 'open', priority: 9 }], priorities), byPriority({ alpha: { 9: 1 } }));
  });

  it("weighs teamrig's p0 above the configured top level, whatever levels the config lists", () => {
    assert.deepEqual(workWeights([{ owner: 'alpha', status: 'open', priority: 0 }], priorities), byPriority({ alpha: { 0: 6 } }));
    assert.deepEqual(workWeights([{ owner: 'alpha', status: 'open', priority: 0 }], [{ id: 2, name: 'b' }]), byPriority({ alpha: { 0: 2 } }));
  });

  it('ranks the priorities by id whatever their order in the config', () => {
    const weights = workWeights([{ owner: 'alpha', status: 'open', priority: 2 }], [{ id: 3, name: 'c' }, { id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    assert.deepEqual(weights, byPriority({ alpha: { 2: 2 } }));
  });
});

describe('workWeightOf', () => {
  it("weighs a session's work whole, summed over its priorities", () => {
    assert.equal(workWeightOf(new Map([[1, 5], [3, 3]])), 8);
  });

  it('is 0 for a session with no queued work', () => {
    assert.equal(workWeightOf(undefined), 0);
    assert.equal(workWeightOf(new Map()), 0);
  });
});

describe('queuedWork', () => {
  it("lists each owner's open and in-progress p0 tasks beside the weights", () => {
    const work = queuedWork(
      [
        workTask({ id: 'T1', owner: 'alpha', status: 'open', priority: 0 }),
        workTask({ id: 'T2', owner: 'alpha', status: 'in-progress', priority: 0 }),
        workTask({ id: 'T3', owner: 'alpha', status: 'open', priority: 1 }),
        workTask({ id: 'T4', owner: 'bravo', status: 'waiting', priority: 0 }),
        workTask({ id: 'T5', owner: 'bravo', status: 'done', priority: 0 }),
        workTask({ id: 'T6', owner: 'charlie', status: 'open', priority: 2 }),
      ],
      priorities,
      NOW,
    );
    assert.deepEqual([...work.urgent], [['alpha', ['T1', 'T2']]]);
    // p0..p5 weigh 6..1; each session weighs its top task alone.
    assert.deepEqual(work.weights, byPriority({ alpha: { 0: 6 }, charlie: { 2: 4 } }));
  });

  it("lists each session's answers another session waits on: its queued task a waiter names, and a waiter's approval or decision asked of it (T2656)", () => {
    const work = queuedWork(
      [
        workTask({ id: 'T1', owner: 'alpha', status: 'open', priority: 3 }),
        workTask({ id: 'T2', owner: 'bravo', status: 'waiting', priority: 2, waits: [{ kind: 'task', id: 'T1' }] }),
        workTask({ id: 'T3', owner: 'charlie', status: 'waiting', priority: 2, waits: [{ kind: 'task', id: 'T1' }, { kind: 'approval', who: 'lead' }] }),
        workTask({ id: 'T4', owner: 'bravo', status: 'waiting', priority: 1, waits: [{ kind: 'decision', who: 'lead' }] }),
      ],
      priorities,
      NOW,
    );
    // T1 is named by two waiters but listed once; the lead's answers are the waiting tasks themselves.
    assert.deepEqual([...work.awaited], [['alpha', ['T1']], ['lead', ['T3', 'T4']]]);
  });

  it('lists no answer for a needed task that is itself waiting or finished, a wait on its own owner, or a waiter no longer waiting', () => {
    const work = queuedWork(
      [
        workTask({ id: 'T1', owner: 'alpha', status: 'waiting', priority: 3, waits: [{ kind: 'time', at: '2030-01-08 10:00' }] }),
        workTask({ id: 'T2', owner: 'alpha', status: 'done', priority: 3 }),
        workTask({ id: 'T3', owner: 'alpha', status: 'open', priority: 3 }),
        workTask({ id: 'T4', owner: 'bravo', status: 'waiting', priority: 2, waits: [{ kind: 'task', id: 'T1' }, { kind: 'task', id: 'T2' }, { kind: 'task', id: 'T9' }] }),
        workTask({ id: 'T5', owner: 'alpha', status: 'waiting', priority: 2, waits: [{ kind: 'task', id: 'T3' }] }),
        workTask({ id: 'T6', owner: 'lead', status: 'waiting', priority: 2, waits: [{ kind: 'decision', who: 'lead' }] }),
        workTask({ id: 'T7', owner: 'bravo', status: 'in-progress', priority: 2, waits: [{ kind: 'task', id: 'T3' }] }),
      ],
      priorities,
      NOW,
    );
    assert.deepEqual([...work.awaited], []);
  });

  it('keeps the size base of every sized task, a finished one too, and only of those', () => {
    const open = { day: '2030-01-07', w: 5 };
    const finished = { day: '2030-01-06', w: 0 };
    const work = queuedWork(
      [
        workTask({ id: 'T1', owner: 'alpha', status: 'open', priority: 1, sizeBase: open }),
        workTask({ id: 'T2', owner: 'alpha', status: 'done', priority: 1, sizeBase: finished }),
        workTask({ id: 'T3', owner: 'alpha', status: 'open', priority: 1 }),
      ],
      priorities,
      NOW,
    );
    assert.deepEqual([...work.sizeBases], [['T1', open], ['T2', finished]]);
  });

  it('keeps the tasks done inside the like window, with only what the medians read of them', () => {
    const lately = '2030-01-06T09:00:00.000Z';
    const work = queuedWork(
      [
        workTask({ id: 'T1', owner: 'alpha', status: 'done', priority: 1, statusAt: lately, workClass: 'Roadmap', type: 'bug', sizeBase: { day: '2030-01-06', w: 5 } }),
        workTask({ id: 'T2', owner: 'alpha', status: 'done', priority: 1 }),
        workTask({ id: 'T3', owner: 'alpha', status: 'dropped', priority: 1, statusAt: lately }),
        workTask({ id: 'T4', owner: 'bravo', status: 'open', priority: 2, statusAt: lately }),
        workTask({ id: 'T5', owner: 'bravo', status: 'done', priority: 2, statusAt: lately }),
      ],
      priorities,
      NOW,
    );
    // T2 was done before the window, T3 dropped and T4 is not finished: none sizes finished work.
    assert.deepEqual(work.likeTasks, [
      { id: 'T1', status: 'done', statusAt: lately, workClass: 'Roadmap', type: 'bug' },
      { id: 'T5', status: 'done', statusAt: lately, workClass: null, type: null },
    ]);
  });
});

describe('readTasks', () => {
  const PATH = '/kit/teams/app/state/events.jsonl';

  it('tells a register with no tasks from one that cannot be read', async () => {
    assert.deepEqual(await readTasks(new MemoryFiles(), PATH), []);
    const files = new FaultyFiles(new MemoryFiles({ [PATH]: '' })).fail('read', PATH, systemError('EIO'));
    assert.equal(await readTasks(files, PATH), undefined);
  });
});

describe('readWork', () => {
  const PATH = '/kit/teams/app/state/events.jsonl';

  it('is empty for a missing register', async () => {
    assert.deepEqual([...(await readWork(new MemoryFiles(), PATH, priorities, NOW)).weights], []);
  });

  it('is empty when the register cannot be read, so the split falls back to shares', async () => {
    const files = new FaultyFiles(new MemoryFiles({ [PATH]: '' })).fail('read', PATH, systemError('EIO'));
    assert.deepEqual([...(await readWork(files, PATH, priorities, NOW)).weights], []);
  });
});

describe('cachedWork', () => {
  const PATH = '/kit/teams/app/state/events.jsonl';
  const CACHE = `/kit/teams/app/state/usage/${WORK_CACHE_FILE}`;
  const { tail, snapshot } = layoutPaths(PATH);
  const BOTH = [['alpha', new Map([[1, 5]])], ['bravo', new Map([[3, 3]])]];
  const CHARLIE = ['charlie', new Map([[2, 4]])];

  class NoSkills implements SkillCatalog {
    async exists(): Promise<boolean> {
      return false;
    }
  }

  /** Adds an open task to the register over `files`, each under a title of its own (the register refuses a duplicate). */
  type AddTask = (owner: string, priority: number) => Promise<void>;
  /** Sizes a task of the register over `files`, writing `base` as its update does. */
  type SizeTask = (id: string, base: SizeBase) => Promise<void>;
  /** Sets a task of the register over `files` done, by its owner, at the register's clock. */
  type FinishTask = (owner: string, id: string) => Promise<void>;
  /** Starts a task of the register over `files` and sets it waiting, by its owner, on the task `on`. */
  type WaitTask = (owner: string, id: string, on: string) => Promise<void>;

  interface Team {
    readonly files: MemoryFiles;
    readonly add: AddTask;
    readonly size: SizeTask;
    readonly finish: FinishTask;
    readonly wait: WaitTask;
  }

  function registerOn(files: MemoryFiles): Omit<Team, 'files'> {
    const register = new Register({
      log: new JsonlEventLog(files, PATH),
      mutex: new InlineMutex(),
      numbering: OWN_NUMBERS,
      elsewhere: NOTHING_ELSEWHERE,
      goals: NO_GOAL_RECORDS,
      clock: new FakeClock('2030-01-07T09:00:00.000Z'),
      policy: new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie'] })),
      skills: new NoSkills(),
      zone: TimeZone.UTC,
      autoArchive: false,
    });
    let added = 0;
    return {
      add: async (owner, priority) => {
        added += 1;
        const verdict = await register.add('lead', { title: `Ship part ${added}`, description: 'what and why', owner, source: 'lead', priority });
        assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
      },
      size: async (id, base) => {
        const verdict = await register.update('lead', id, { size: 1 }, undefined, base);
        assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
      },
      finish: async (owner, id) => {
        const verdict = await register.setStatus(owner, id, { status: 'done', note: 'shipped', evidence: 'abc1234', skill: 'none', followups: [] });
        assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
      },
      wait: async (owner, id, on) => {
        // The register lets only a started task wait on another; an open one is planned after it instead.
        const started = await register.setStatus(owner, id, { status: 'in-progress' });
        assert.ok(started.ok, started.ok ? '' : started.error);
        const verdict = await register.setStatus(owner, id, { status: 'waiting', note: 'needs it first', waits: [{ kind: 'task', id: on }] });
        assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
      },
    };
  }

  /** A register over `files` holding an open p1 task of alpha's and a p3 one of bravo's. */
  async function team(files: MemoryFiles = new MemoryFiles()): Promise<Team> {
    const register = registerOn(files);
    await register.add('alpha', 1);
    await register.add('bravo', 3);
    return { files, ...register };
  }

  /** The same files with every read of the register failing: only a cache hit still answers. */
  function unreadable(files: MemoryFiles): FaultyFiles {
    return new FaultyFiles(files).fail('read', tail, systemError('EIO')).fail('read', snapshot, systemError('EIO'));
  }

  /** The cache file as a record; it must hold one. */
  function cacheIn(files: MemoryFiles): JsonRecord {
    const cache = parseObject(files.get(CACHE) ?? '');
    assert.ok(cache !== undefined, 'the cache is written');
    return cache;
  }

  function keyIn(files: MemoryFiles): JsonRecord {
    const key = recordField(cacheIn(files), 'key');
    assert.ok(key !== undefined, 'the cache holds its key');
    return key;
  }

  it('replays the register on a miss and keeps the reading with what it was read from', async () => {
    const { files } = await team();
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], BOTH);
    assert.deepEqual(cacheIn(files), {
      [VERSION_FIELD]: 7,
      key: { tail: await files.stamp(tail), snapshot: null, priorities: [1, 2, 3, 4, 5] },
      work: { alpha: { 1: 5 }, bravo: { 3: 3 } },
      urgent: {},
      awaited: {},
      sizeBases: {},
      likeTasks: [],
    });
  });

  it('keeps the tasks done inside the like window in the cache and answers them from there, so a hook replays no register for the medians', async () => {
    const { files, finish } = await team();
    await finish('alpha', 'T1');
    const done = { id: 'T1', status: 'done', statusAt: '2030-01-07T09:00:00.000Z', workClass: null, type: null };
    assert.deepEqual((await cachedWork(files, PATH, CACHE, priorities, NOW)).likeTasks, [done]);
    assert.deepEqual(cacheIn(files)['likeTasks'], [done]);
    assert.deepEqual((await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).likeTasks, [done]);
  });

  it("keeps each sized task's base in the cache and answers it from there, so a hook replays no register for it", async () => {
    const { files, size } = await team();
    const base = { day: '2030-01-07', w: 1_500 };
    await size('T1', base);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).sizeBases], [['T1', base]]);
    assert.deepEqual(cacheIn(files)['sizeBases'], { T1: base });
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).sizeBases], [['T1', base]]);
  });

  it("keeps each session's p0 ids in the cache and answers them from it", async () => {
    const { files, add } = await team();
    await add('charlie', 0);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).urgent], [['charlie', ['T3']]]);
    assert.deepEqual(cacheIn(files)['urgent'], { charlie: ['T3'] });
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).urgent], [['charlie', ['T3']]]);
  });

  it("keeps each session's answers awaited in the cache and answers them from it (T2656)", async () => {
    const { files, wait } = await team();
    await wait('bravo', 'T2', 'T1');
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).awaited], [['alpha', ['T1']]]);
    assert.deepEqual(cacheIn(files)['awaited'], { alpha: ['T1'] });
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).awaited], [['alpha', ['T1']]]);
  });

  it('answers from the cache while the register and the priorities are unchanged, without reading the register', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities, NOW);
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).weights], BOTH);
  });

  it('reads the register again after a write to it', async () => {
    const { files, add } = await team();
    await cachedWork(files, PATH, CACHE, priorities, NOW);
    await add('charlie', 2);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], [...BOTH, CHARLIE]);
  });

  it('reads the register again after a rotation, which rewrites its tail and its snapshot', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities, NOW);
    await rotateRegister(files, PATH, { now: new Date('2030-01-08T09:00:00.000Z') });
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], BOTH);
    const key = keyIn(files);
    assert.deepEqual([key['tail'], key['snapshot']], [await files.stamp(tail), await files.stamp(snapshot)]);
    assert.notEqual(key['snapshot'], null);
  });

  it('weighs the work again when the priorities change', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities, NOW);
    const three = [{ id: 1, name: 'high' }, { id: 2, name: 'medium' }, { id: 3, name: 'low' }];
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, three, NOW)).weights], [['alpha', new Map([[1, 3]])], ['bravo', new Map([[3, 1]])]]);
  });

  /** The cache a call just wrote, its key matching the register, made over by `damage`. */
  type Damage = (cache: JsonRecord, key: JsonRecord) => string;
  const DAMAGES: readonly (readonly [string, Damage])[] = [
    ['damaged', (cache) => JSON.stringify(cache).slice(0, -2)],
    ['in another format', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 8, work: {} })],
    ['in the sixth format, with no answers awaited', (cache) => JSON.stringify({ [VERSION_FIELD]: 6, key: cache['key'], work: {}, urgent: {}, sizeBases: {}, likeTasks: [] })],
    ['without its answers awaited', (cache) => JSON.stringify({ ...cache, work: {}, awaited: 'none' })],
    ['with answers awaited that are not text', (cache) => JSON.stringify({ ...cache, work: {}, awaited: { alpha: [5] } })],
    ['in the fifth format, with no like tasks', (cache) => JSON.stringify({ [VERSION_FIELD]: 5, key: cache['key'], work: {}, urgent: {}, sizeBases: {} })],
    ['in the fourth format, with no size bases', (cache) => JSON.stringify({ [VERSION_FIELD]: 4, key: cache['key'], work: {}, urgent: {} })],
    ['in the third format, every queued task weighed', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 3, work: { alpha: { 1: 10 }, bravo: { 3: 3 } } })],
    ['in the second format, one weight per session', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 2, work: { alpha: 5, bravo: 3 } })],
    ['in the first format, with no p0 ids', (cache) => JSON.stringify({ [VERSION_FIELD]: 1, key: cache['key'], work: {} })],
    ['without its p0 ids', (cache) => JSON.stringify({ ...cache, urgent: 'none' })],
    ['with p0 ids that are not text', (cache) => JSON.stringify({ ...cache, urgent: { alpha: [5] } })],
    ['without its size bases', (cache) => JSON.stringify({ ...cache, work: {}, sizeBases: 'none' })],
    ['with a size base that is not one', (cache) => JSON.stringify({ ...cache, work: {}, sizeBases: { T1: { day: 'today', w: -1 } } })],
    ['without its like tasks', (cache) => JSON.stringify({ ...cache, work: {}, likeTasks: 'none' })],
    ['with a like task that is not one', (cache) => JSON.stringify({ ...cache, work: {}, likeTasks: [{ id: 5 }] })],
    ['with a like task of a type that is not one', (cache) => JSON.stringify({ ...cache, work: {}, likeTasks: [{ id: 'T1', status: 'done', statusAt: '2030-01-07T09:00:00.000Z', workClass: null, type: 7 }] })],
    ['without its key', (cache) => JSON.stringify({ ...cache, key: 'none' })],
    ['without its work', (cache) => JSON.stringify({ ...cache, work: 'none' })],
    ['with one weight for a session, not one per priority', (cache) => JSON.stringify({ ...cache, work: { alpha: 5 } })],
    ['with a weight that is not a number', (cache) => JSON.stringify({ ...cache, work: { alpha: { 1: 'five' } } })],
    ['with a priority id that is not a whole number', (cache) => JSON.stringify({ ...cache, work: { alpha: { p1: 5 } } })],
    ['with a priority id written other than as its number', (cache) => JSON.stringify({ ...cache, work: { alpha: { '01': 5 } } })],
    ['with a tail stamp that is not text', (cache, key) => JSON.stringify({ ...cache, key: { ...key, tail: 7 } })],
    ['with a snapshot stamp that is not text', (cache, key) => JSON.stringify({ ...cache, key: { ...key, snapshot: 7 } })],
    ['with priorities that are not numbers', (cache, key) => JSON.stringify({ ...cache, key: { ...key, priorities: ['p1'] } })],
  ];
  for (const [what, damage] of DAMAGES) {
    it(`reads the register again and rewrites a cache ${what}`, async () => {
      const { files } = await team();
      await cachedWork(files, PATH, CACHE, priorities, NOW);
      await files.write(CACHE, damage(cacheIn(files), keyIn(files)));
      assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], BOTH);
      assert.deepEqual(cacheIn(files)['work'], { alpha: { 1: 5 }, bravo: { 3: 3 } });
    });
  }

  it('takes the stamps before it reads, so a write that lands just after the read is read on the next call', async () => {
    /** Runs a write right after the next read of the register's tail returns. */
    class WriteAfterRead extends MemoryFiles {
      private pending: (() => Promise<void>) | undefined;

      afterNextTailRead(write: () => Promise<void>): void {
        this.pending = write;
      }

      override async read(path: string): Promise<string | undefined> {
        const text = await super.read(path);
        const write = this.pending;
        if (write !== undefined && normalisePath(path) === normalisePath(tail)) {
          this.pending = undefined;
          await write();
        }
        return text;
      }
    }
    const files = new WriteAfterRead();
    const { add } = await team(files);
    files.afterNextTailRead(() => add('charlie', 2));
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], BOTH);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities, NOW)).weights], [...BOTH, CHARLIE]);
  });

  it('is empty and caches nothing when the register cannot be read', async () => {
    const { files } = await team();
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities, NOW)).weights], []);
    assert.equal(files.get(CACHE), undefined);
  });

  it('reads the register uncached when a stamp cannot be taken', async () => {
    const { files } = await team();
    const faulty = new FaultyFiles(files).fail('stamp', snapshot, systemError('EIO'));
    assert.deepEqual([...(await cachedWork(faulty, PATH, CACHE, priorities, NOW)).weights], BOTH);
    assert.equal(files.get(CACHE), undefined);
  });

  it('takes a cache that cannot be read for a missing one, and still answers when the cache cannot be written', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities, NOW);
    await files.write(CACHE, JSON.stringify({ ...cacheIn(files), work: {} }));
    const faulty = new FaultyFiles(files).fail('read', CACHE, systemError('EIO')).fail('write', CACHE, systemError('EACCES'));
    assert.deepEqual([...(await cachedWork(faulty, PATH, CACHE, priorities, NOW)).weights], BOTH);
    assert.deepEqual(cacheIn(files)['work'], {});
  });
});
