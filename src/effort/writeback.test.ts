import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EffortLevel } from '../config/types.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { effortLines, transcript } from '../testing/transcript-lines.ts';
import {
  effortChangeLine,
  effortChangeText,
  effortWriteback,
  formatWritebackMarks,
  parseWritebackMarks,
  withLaunchEffort,
  WritebackMarksStore,
  type WritebackDeps,
  type WritebackInput,
  type WrittenEffort,
} from './writeback.ts';

const CLAUDE = 'claude-1';
const PATH = 'D:/t/transcript.jsonl';
const MARKS = 'D:/t/marks';
const START = Date.parse('2026-11-11T10:00:00.000Z');

/** Files that count the transcript tail reads, so a test can tell a turn read none. */
class CountingFiles extends MemoryFiles {
  tails = 0;

  override readTail(path: string, maxBytes: number): Promise<string | undefined> {
    this.tails += 1;
    return super.readTail(path, maxBytes);
  }
}

interface World {
  readonly files: CountingFiles;
  readonly clock: FakeClock;
  readonly marks: WritebackMarksStore;
  readonly writes: EffortLevel[];
  readonly deps: WritebackDeps;
}

function world(options: { configChangedAt?: number; failWrite?: boolean } = {}): World {
  const files = new CountingFiles();
  const clock = new FakeClock(START);
  const marks = new WritebackMarksStore(files, MARKS);
  const writes: EffortLevel[] = [];
  const write = async (level: EffortLevel): Promise<WrittenEffort | undefined> => {
    if (options.failWrite === true) {
      throw new Error('the config has a problem');
    }
    writes.push(level);
    return { from: 'high', to: level, backup: 'D:/t/backups/effort-alpha.json' };
  };
  return { files, clock, marks, writes, deps: { files, clock, marks, configChangedAt: async () => options.configChangedAt, write } };
}

function typedAt(offsetMs: number, uuid: string, level: string): readonly string[] {
  return effortLines({ uuid, at: new Date(START + offsetMs).toISOString(), sessionId: CLAUDE, args: level, set: level });
}

function input(over: Partial<WritebackInput> = {}): WritebackInput {
  return { id: 'alpha', claude: CLAUDE, transcript: PATH, running: undefined, config: 'high', ...over };
}

async function looked(w: World, config: EffortLevel | null = 'high'): Promise<void> {
  await w.marks.save('alpha', { lastAt: START, uuid: undefined, config });
}

describe('effortWriteback', () => {
  it('at a session first look only marks the time, so an older /effort in a resumed transcript never applies', async () => {
    const w = world();
    await w.files.write(PATH, transcript(typedAt(-60_000, 'u1', 'low')));
    assert.equal(await effortWriteback(w.deps, input()), undefined);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START, uuid: undefined, config: 'high' });
  });

  it('writes back the newest level typed since, once', async () => {
    const w = world();
    await looked(w);
    await w.files.write(PATH, transcript([...typedAt(1_000, 'u1', 'low'), ...typedAt(2_000, 'u2', 'medium')]));
    const done = await effortWriteback(w.deps, input({ running: 'medium' }));
    assert.equal(done?.typed.uuid, 'u2');
    assert.deepEqual(w.writes, ['medium']);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START + 2_000, uuid: 'u2', config: 'medium' });
    assert.equal(await effortWriteback(w.deps, input({ running: 'medium', config: 'medium' })), undefined);
    assert.equal(await effortWriteback(w.deps, input({ running: 'low', config: 'medium' })), undefined);
    assert.deepEqual(w.writes, ['medium']);
  });

  it('reads no transcript while the turn runs at the config level', async () => {
    const w = world();
    await looked(w);
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'low')));
    assert.equal(await effortWriteback(w.deps, input({ running: 'high' })), undefined);
    assert.equal(w.files.tails, 0);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START, uuid: undefined, config: 'high' });
  });

  it('takes up without a write a typed level the session no longer runs at, or the one the config has', async () => {
    const w = world();
    await looked(w);
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'low')));
    assert.equal(await effortWriteback(w.deps, input({ running: 'max' })), undefined);
    assert.equal((await w.marks.read('alpha'))?.uuid, 'u1');
    await w.files.append(PATH, transcript(typedAt(2_000, 'u2', 'high')));
    assert.equal(await effortWriteback(w.deps, input({ running: 'max' })), undefined);
    assert.equal(await effortWriteback(w.deps, input()), undefined);
    assert.deepEqual(w.writes, []);
    assert.equal((await w.marks.read('alpha'))?.uuid, 'u2');
  });

  it('at a session end, which names no running level, writes the newest typed level', async () => {
    const w = world();
    await looked(w);
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'max')));
    assert.equal((await effortWriteback(w.deps, input()))?.written.to, 'max');
    assert.deepEqual(w.writes, ['max']);
  });

  it('passes over a level typed before the config changed the session, and writes one typed after', async () => {
    const w = world({ configChangedAt: START + 5_000 });
    await looked(w, 'high');
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'max')));
    assert.equal(await effortWriteback(w.deps, input({ running: 'max', config: 'low' })), undefined);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START + 5_000, uuid: undefined, config: 'low' });
    await w.files.append(PATH, transcript(typedAt(6_000, 'u2', 'medium')));
    assert.equal((await effortWriteback(w.deps, input({ running: 'medium', config: 'low' })))?.typed.uuid, 'u2');
    assert.deepEqual(w.writes, ['medium']);
  });

  it('marks the config change even on a turn that reads no transcript', async () => {
    const w = world({ configChangedAt: START + 5_000 });
    await looked(w, 'high');
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'high')));
    assert.equal(await effortWriteback(w.deps, input({ running: 'low', config: 'low' })), undefined);
    assert.equal(w.files.tails, 0);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START + 5_000, uuid: undefined, config: 'low' });
    // The old no-op /effort high never undoes the lead's change once the tab runs high again.
    assert.equal(await effortWriteback(w.deps, input({ running: 'high', config: 'low' })), undefined);
    assert.deepEqual(w.writes, []);
  });

  it('leaves the marks where they were when the write fails, so the next turn tries again', async () => {
    const w = world({ failWrite: true });
    await looked(w);
    await w.files.write(PATH, transcript(typedAt(1_000, 'u1', 'low')));
    await assert.rejects(effortWriteback(w.deps, input({ running: 'low' })), /problem/);
    assert.deepEqual(await w.marks.read('alpha'), { lastAt: START, uuid: undefined, config: 'high' });
  });
});

describe('writeback marks', () => {
  it('reads back what it writes, and a damaged or other-format file as none', () => {
    const marks = { lastAt: START, uuid: 'u1', config: null };
    assert.deepEqual(parseWritebackMarks(formatWritebackMarks(marks)), marks);
    assert.equal(parseWritebackMarks('{"v":2,"lastAt":1,"config":null}'), undefined);
    assert.equal(parseWritebackMarks('{"v":1,"lastAt":1,"config":"auto"}'), undefined);
    assert.equal(parseWritebackMarks('{"v":1,"lastAt'), undefined);
  });
});

describe('withLaunchEffort', () => {
  it('sets only the session effort, keeping every other key', () => {
    const file = { version: 9, sessions: ['alpha', 'bravo'], launch: { alpha: { model: 'opus', effort: 'high', project: 'D:/app' }, bravo: { effort: 'low' } } };
    assert.deepEqual(withLaunchEffort(file, 'alpha', 'medium'), {
      version: 9,
      sessions: ['alpha', 'bravo'],
      launch: { alpha: { model: 'opus', effort: 'medium', project: 'D:/app' }, bravo: { effort: 'low' } },
    });
    assert.deepEqual(file.launch.alpha.effort, 'high');
  });

  it('makes the launch entry, and the launch block, when there is none', () => {
    assert.deepEqual(withLaunchEffort({ sessions: ['alpha'] }, 'alpha', 'low'), { sessions: ['alpha'], launch: { alpha: { effort: 'low' } } });
    assert.deepEqual(withLaunchEffort({ launch: { bravo: {} } }, 'alpha', 'low'), { launch: { bravo: {}, alpha: { effort: 'low' } } });
  });

  it('reads no prototype key as an entry of the session', () => {
    const next = withLaunchEffort({ launch: {} }, 'constructor', 'low');
    assert.deepEqual(next['launch'], { constructor: { effort: 'low' } });
  });
});

describe('effort change lines', () => {
  const change = { typed: { uuid: 'u1', at: START, level: 'low' as const }, written: { from: undefined, to: 'low' as const, backup: 'D:/t/b.json' } };

  it('logs who, from, to, the typed entry and the old config copy', () => {
    assert.deepEqual(JSON.parse(effortChangeLine(START + 1_000, 'alpha', CLAUDE, change)), {
      v: 1,
      at: '2026-11-11T10:00:01.000Z',
      session: 'alpha',
      from: null,
      to: 'low',
      claude: CLAUDE,
      uuid: 'u1',
      typedAt: '2026-11-11T10:00:00.000Z',
      backup: 'D:/t/b.json',
    });
  });

  it('tells the leader on the team clock', () => {
    assert.equal(effortChangeText('alpha', 'app', change, TimeZone.UTC), 'alpha effort unset -> low (a typed /effort at 10:00 UTC), written to its launch entry in the app config');
  });
});
