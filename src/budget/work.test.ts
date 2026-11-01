import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { recordField, type JsonRecord } from '../core/guards.ts';
import { parseObject, VERSION_FIELD } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
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
import { cachedWork, queuedWork, readWork, WORK_CACHE_FILE, workWeightOf, workWeights, type WorkByPriority } from './work.ts';

const { priorities } = DEFAULT_REGISTER;

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
        { id: 'T1', owner: 'alpha', status: 'open', priority: 0 },
        { id: 'T2', owner: 'alpha', status: 'in-progress', priority: 0 },
        { id: 'T3', owner: 'alpha', status: 'open', priority: 1 },
        { id: 'T4', owner: 'bravo', status: 'waiting', priority: 0 },
        { id: 'T5', owner: 'bravo', status: 'done', priority: 0 },
        { id: 'T6', owner: 'charlie', status: 'open', priority: 2 },
      ],
      priorities,
    );
    assert.deepEqual([...work.urgent], [['alpha', ['T1', 'T2']]]);
    // p0..p5 weigh 6..1; each session weighs its top task alone.
    assert.deepEqual(work.weights, byPriority({ alpha: { 0: 6 }, charlie: { 2: 4 } }));
  });
});

describe('readWork', () => {
  const PATH = '/kit/teams/app/state/events.jsonl';

  it('is empty for a missing register', async () => {
    assert.deepEqual([...(await readWork(new MemoryFiles(), PATH, priorities)).weights], []);
  });

  it('is empty when the register cannot be read, so the split falls back to shares', async () => {
    const files = new FaultyFiles(new MemoryFiles({ [PATH]: '' })).fail('read', PATH, systemError('EIO'));
    assert.deepEqual([...(await readWork(files, PATH, priorities)).weights], []);
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

  function registerOn(files: MemoryFiles): AddTask {
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
    return async (owner, priority) => {
      added += 1;
      const verdict = await register.add('lead', { title: `Ship part ${added}`, description: 'what and why', owner, source: 'lead', priority });
      assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
    };
  }

  /** A register over `files` holding an open p1 task of alpha's and a p3 one of bravo's. */
  async function team(files: MemoryFiles = new MemoryFiles()): Promise<{ readonly files: MemoryFiles; readonly add: AddTask }> {
    const add = registerOn(files);
    await add('alpha', 1);
    await add('bravo', 3);
    return { files, add };
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
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], BOTH);
    assert.deepEqual(cacheIn(files), {
      [VERSION_FIELD]: 4,
      key: { tail: await files.stamp(tail), snapshot: null, priorities: [1, 2, 3, 4, 5] },
      work: { alpha: { 1: 5 }, bravo: { 3: 3 } },
      urgent: {},
    });
  });

  it("keeps each session's p0 ids in the cache and answers them from it", async () => {
    const { files, add } = await team();
    await add('charlie', 0);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).urgent], [['charlie', ['T3']]]);
    assert.deepEqual(cacheIn(files)['urgent'], { charlie: ['T3'] });
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities)).urgent], [['charlie', ['T3']]]);
  });

  it('answers from the cache while the register and the priorities are unchanged, without reading the register', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities);
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities)).weights], BOTH);
  });

  it('reads the register again after a write to it', async () => {
    const { files, add } = await team();
    await cachedWork(files, PATH, CACHE, priorities);
    await add('charlie', 2);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], [...BOTH, CHARLIE]);
  });

  it('reads the register again after a rotation, which rewrites its tail and its snapshot', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities);
    await rotateRegister(files, PATH, { now: new Date('2030-01-08T09:00:00.000Z') });
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], BOTH);
    const key = keyIn(files);
    assert.deepEqual([key['tail'], key['snapshot']], [await files.stamp(tail), await files.stamp(snapshot)]);
    assert.notEqual(key['snapshot'], null);
  });

  it('weighs the work again when the priorities change', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities);
    const three = [{ id: 1, name: 'high' }, { id: 2, name: 'medium' }, { id: 3, name: 'low' }];
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, three)).weights], [['alpha', new Map([[1, 3]])], ['bravo', new Map([[3, 1]])]]);
  });

  /** The cache a call just wrote, its key matching the register, made over by `damage`. */
  type Damage = (cache: JsonRecord, key: JsonRecord) => string;
  const DAMAGES: readonly (readonly [string, Damage])[] = [
    ['damaged', (cache) => JSON.stringify(cache).slice(0, -2)],
    ['in another format', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 5, work: {} })],
    ['in the third format, every queued task weighed', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 3, work: { alpha: { 1: 10 }, bravo: { 3: 3 } } })],
    ['in the second format, one weight per session', (cache) => JSON.stringify({ ...cache, [VERSION_FIELD]: 2, work: { alpha: 5, bravo: 3 } })],
    ['in the first format, with no p0 ids', (cache) => JSON.stringify({ [VERSION_FIELD]: 1, key: cache['key'], work: {} })],
    ['without its p0 ids', (cache) => JSON.stringify({ ...cache, urgent: 'none' })],
    ['with p0 ids that are not text', (cache) => JSON.stringify({ ...cache, urgent: { alpha: [5] } })],
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
      await cachedWork(files, PATH, CACHE, priorities);
      await files.write(CACHE, damage(cacheIn(files), keyIn(files)));
      assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], BOTH);
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
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], BOTH);
    assert.deepEqual([...(await cachedWork(files, PATH, CACHE, priorities)).weights], [...BOTH, CHARLIE]);
  });

  it('is empty and caches nothing when the register cannot be read', async () => {
    const { files } = await team();
    assert.deepEqual([...(await cachedWork(unreadable(files), PATH, CACHE, priorities)).weights], []);
    assert.equal(files.get(CACHE), undefined);
  });

  it('reads the register uncached when a stamp cannot be taken', async () => {
    const { files } = await team();
    const faulty = new FaultyFiles(files).fail('stamp', snapshot, systemError('EIO'));
    assert.deepEqual([...(await cachedWork(faulty, PATH, CACHE, priorities)).weights], BOTH);
    assert.equal(files.get(CACHE), undefined);
  });

  it('takes a cache that cannot be read for a missing one, and still answers when the cache cannot be written', async () => {
    const { files } = await team();
    await cachedWork(files, PATH, CACHE, priorities);
    await files.write(CACHE, JSON.stringify({ ...cacheIn(files), work: {} }));
    const faulty = new FaultyFiles(files).fail('read', CACHE, systemError('EIO')).fail('write', CACHE, systemError('EACCES'));
    assert.deepEqual([...(await cachedWork(faulty, PATH, CACHE, priorities)).weights], BOTH);
    assert.deepEqual(cacheIn(files)['work'], {});
  });
});
