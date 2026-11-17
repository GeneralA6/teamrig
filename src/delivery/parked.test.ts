import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { claimParked, formatParked, hasParked, park, PARKED_FORMAT, parkedDirOf, parkedPathOf, parseParked, type ParkedStep } from './parked.ts';

const DETACHED = resolve('/', 'deploys', 'detached');
const DIR = parkedDirOf(DETACHED);
const STEP: ParkedStep = {
  v: PARKED_FORMAT,
  id: '20300108-100000-4242',
  team: 'app',
  session: 'alpha',
  what: 'build api',
  log: join(DETACHED, '20300108-100000-4242.log'),
  argv: ['queue', '--detached-run', '20300108-100000-4242', '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'],
  cwd: resolve('/', 'work', 'api'),
  env: { PATH: '/usr/bin', TEAMRIG_SESSION: 'alpha' },
  parkedAt: '2030-01-08T10:00:00.000Z',
};
const LATER: ParkedStep = { ...STEP, id: '20300108-100500-4343', what: 'test api', parkedAt: '2030-01-08T10:05:00.000Z' };

describe('the parked step', () => {
  it('reads back what it wrote, in the parked folder of the detached folder', () => {
    assert.deepEqual(parseParked(formatParked(STEP)), STEP);
    assert.equal(parkedPathOf(DIR, STEP.id), join(DETACHED, 'parked', '20300108-100000-4242.parked.json'));
  });

  it('writes the fields of format 1: a field added is a new format (CONTRIBUTING, Stored files)', () => {
    const written: unknown = JSON.parse(formatParked(STEP));
    assert.deepEqual(fieldPaths(written), ['argv[]', 'cwd', 'env.PATH', 'env.TEAMRIG_SESSION', 'id', 'log', 'parkedAt', 'session', 'team', 'v', 'what']);
  });

  it('reads no step from a torn file, another format, a missing field or an env value that is not text', () => {
    assert.equal(parseParked('{"v":1,'), undefined);
    assert.equal(parseParked(JSON.stringify({ ...STEP, v: 2 })), undefined);
    assert.equal(parseParked(JSON.stringify({ ...STEP, cwd: undefined })), undefined);
    assert.equal(parseParked(JSON.stringify({ ...STEP, argv: ['queue', 7] })), undefined);
    assert.equal(parseParked(JSON.stringify({ ...STEP, env: { PATH: 7 } })), undefined);
  });
});

describe('parking and claiming', () => {
  it('claims every parked step once, oldest first, and leaves the folder empty', async () => {
    const files = new MemoryFiles();
    await park(files, DIR, LATER);
    await park(files, DIR, STEP);
    assert.equal(await hasParked(files, DIR), true);
    const claimed = await claimParked(files, DIR);
    assert.deepEqual(claimed, { steps: [STEP, LATER], unreadable: [] });
    assert.equal(await hasParked(files, DIR), false);
    assert.deepEqual(await claimParked(files, DIR), { steps: [], unreadable: [] });
  });

  it('takes no step another claim removed first', async () => {
    const files = new MemoryFiles();
    await park(files, DIR, STEP);
    const racing = {
      list: (dir: string) => files.list(dir),
      read: (path: string) => files.read(path),
      // The other dispatcher's removal lands between this one's read and its own removal.
      remove: async (path: string) => (await files.remove(path)) && (await files.remove(path)),
    };
    assert.deepEqual(await claimParked(racing, DIR), { steps: [], unreadable: [] });
  });

  it('names a file that is no parked step and leaves it, ignoring other files and a write not yet renamed', async () => {
    const torn = parkedPathOf(DIR, '20300108-100000-1');
    const files = new MemoryFiles({ [torn]: '{"v":1,', [join(DIR, 'notes.txt')]: 'x', [`${parkedPathOf(DIR, 'x')}.12.1.tmp`]: '{' });
    assert.equal(await hasParked(files, DIR), true);
    assert.deepEqual(await claimParked(files, DIR), { steps: [], unreadable: [torn] });
    assert.equal(files.get(torn), '{"v":1,');
    assert.equal(await hasParked(files, DIR, new Set([torn])), false, 'a file already found no step keeps no dispatcher running');
  });

  it('finds nothing in a folder that does not exist', async () => {
    const files = new MemoryFiles();
    assert.equal(await hasParked(files, DIR), false);
    assert.deepEqual(await claimParked(files, DIR), { steps: [], unreadable: [] });
  });
});
