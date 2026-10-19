import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { AgedLogFile, splitByAge, type AgePolicy } from './aged-log.ts';
import type { Files } from './files.ts';

const LIVE = 'state/inbox-shown.jsonl';
const ARCHIVE = 'state/archive';
const NOW = '2030-01-20T10:00:00.000Z';
const ARCHIVE_FILE = join(ARCHIVE, 'inbox-shown-20300120.jsonl');
const POLICY: AgePolicy = { keepDays: 7, slackDays: 1 };

/** One record line for `key` written at `at`. */
function line(key: string, at: string): string {
  return `${JSON.stringify({ v: 1, key, at })}\n`;
}

/** The newest line for each key, by file order, as the dedup logs' readers take it. */
function newestByKey(text: string): Map<string, string> {
  const newest = new Map<string, string>();
  for (const raw of text.split('\n').filter((entry) => entry !== '')) {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'key' in parsed && typeof parsed.key === 'string') {
      newest.set(parsed.key, raw);
    }
  }
  return newest;
}

function logOn(files: Files, clock: FakeClock, mutex = new InlineMutex()): AgedLogFile {
  return new AgedLogFile({ files, mutex, clock }, { live: LIVE, archive: ARCHIVE, name: 'inbox-shown' }, POLICY);
}

describe('splitByAge', () => {
  const cutoff = Date.parse('2030-01-13T10:00:00Z');

  it('moves the leading records dated before the cutoff, and a damaged line among them', () => {
    const text = line('a', '2030-01-01T00:00:00Z') + 'torn {\n' + line('b', '2030-01-12T00:00:00Z') + line('c', '2030-01-14T00:00:00Z') + line('d', '2030-01-19T00:00:00Z');
    const split = splitByAge(text, cutoff);
    assert.equal(split.moved, line('a', '2030-01-01T00:00:00Z') + 'torn {\n' + line('b', '2030-01-12T00:00:00Z'));
    assert.equal(split.kept, line('c', '2030-01-14T00:00:00Z') + line('d', '2030-01-19T00:00:00Z'));
    assert.deepEqual([split.movedLines, split.keptLines], [3, 2]);
  });

  it('keeps an old record written after a newer one, so no key loses its newest record', () => {
    const text = line('a', '2030-01-01T00:00:00Z') + line('b', '2030-01-14T00:00:00Z') + line('a', '2030-01-02T00:00:00Z') + line('b', '2030-01-03T00:00:00Z');
    const split = splitByAge(text, cutoff);
    assert.equal(split.moved, line('a', '2030-01-01T00:00:00Z'));
    const kept = newestByKey(split.kept);
    for (const [key, newest] of newestByKey(text)) {
      assert.equal(kept.get(key), newest, `key ${key}`);
    }
  });

  it('moves nothing from an empty log or one whose first record is recent, and everything from an old one', () => {
    assert.deepEqual(splitByAge('', cutoff), { moved: '', movedLines: 0, kept: '', keptLines: 0 });
    const recent = line('a', '2030-01-14T00:00:00Z') + line('b', '2030-01-01T00:00:00Z');
    assert.equal(splitByAge(recent, cutoff).moved, '');
    const old = line('a', '2030-01-01T00:00:00Z') + line('b', '2030-01-02T00:00:00Z');
    assert.deepEqual(splitByAge(old, cutoff), { moved: old, movedLines: 2, kept: '', keptLines: 0 });
  });
});

describe('AgedLogFile', () => {
  it('appends under its lock and leaves the log alone while its oldest record is inside the keep days and slack', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const log = logOn(files, new FakeClock(NOW), mutex);
    await files.write(LIVE, line('a', '2030-01-12T11:00:00Z'));
    await log.append(line('b', NOW));
    assert.equal(await log.read(), line('a', '2030-01-12T11:00:00Z') + line('b', NOW));
    assert.equal(await files.read(ARCHIVE_FILE), undefined);
    assert.equal(mutex.runs, 1);
  });

  it('once its oldest record is past the keep days and slack, moves every record older than the keep days to the archive', async () => {
    const files = new MemoryFiles();
    const log = logOn(files, new FakeClock(NOW));
    const old = line('a', '2030-01-11T09:00:00Z') + line('b', '2030-01-13T09:00:00Z');
    const recent = line('c', '2030-01-13T11:00:00Z');
    await files.write(LIVE, old + recent);
    await log.append(line('d', NOW));
    assert.equal(await files.read(ARCHIVE_FILE), old);
    assert.equal(await log.read(), recent + line('d', NOW));
  });

  it('adds a later run of the same day to that day’s archive file', async () => {
    const files = new MemoryFiles();
    const clock = new FakeClock(NOW);
    const log = logOn(files, clock);
    await files.write(ARCHIVE_FILE, line('earlier', '2030-01-10T00:00:00Z'));
    await files.write(LIVE, line('a', '2030-01-11T09:00:00Z'));
    await log.append(line('b', NOW));
    assert.equal(await files.read(ARCHIVE_FILE), line('earlier', '2030-01-10T00:00:00Z') + line('a', '2030-01-11T09:00:00Z'));
  });

  it('keeps the append when the archive’s rewrite fails, the records then in both files, and the next write finishes it', async () => {
    const memory = new MemoryFiles();
    const faulty = new FaultyFiles(memory).fail('write', LIVE, systemError('EPERM'));
    const old = line('a', '2030-01-11T09:00:00Z');
    await memory.write(LIVE, old);
    await logOn(faulty, new FakeClock(NOW)).append(line('b', NOW));
    assert.equal(await memory.read(LIVE), old + line('b', NOW));
    assert.equal(await memory.read(ARCHIVE_FILE), old);
    await logOn(memory, new FakeClock(NOW)).append(line('c', NOW));
    assert.equal(await memory.read(LIVE), line('b', NOW) + line('c', NOW));
    assert.equal(await memory.read(ARCHIVE_FILE), old + old);
  });

  it('plans what an archive run would move without the lock and without writing', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const log = logOn(files, new FakeClock(NOW), mutex);
    const text = line('a', '2030-01-12T11:00:00Z') + line('b', NOW);
    await files.write(LIVE, text);
    const plan = await log.plan();
    assert.deepEqual(
      { name: plan.name, cutoff: plan.cutoff.toISOString(), moved: plan.split.movedLines, kept: plan.split.keptLines, archiveFile: plan.archiveFile },
      { name: 'inbox-shown', cutoff: '2030-01-13T10:00:00.000Z', moved: 1, kept: 1, archiveFile: ARCHIVE_FILE },
    );
    assert.equal(mutex.runs, 0);
    assert.equal(await files.read(LIVE), text);
    assert.equal(await files.read(ARCHIVE_FILE), undefined);
  });

  it('archives by hand under the lock whatever the slack, and writes nothing when nothing is old', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const log = logOn(files, new FakeClock(NOW), mutex);
    await files.write(LIVE, line('a', '2030-01-12T11:00:00Z') + line('b', NOW));
    const plan = await log.archive();
    assert.equal(plan.split.movedLines, 1);
    assert.equal(await files.read(ARCHIVE_FILE), line('a', '2030-01-12T11:00:00Z'));
    assert.equal(await log.read(), line('b', NOW));
    assert.equal((await log.archive()).split.moved, '');
    assert.equal(await files.read(ARCHIVE_FILE), line('a', '2030-01-12T11:00:00Z'));
    assert.equal(mutex.runs, 2);
  });
});
