import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KIT_VERSION } from '../core/version.ts';
import { cleanTree, GIT_DIR } from '../testing/fake-trees.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { PASS_KEPT_MS, passOf, recordPass } from './push-pass.ts';

const FOLDER = join(GIT_DIR, 'teamrig', 'pre-push');
const CHECKS = 'npm run build && npm test';
const NOW = Date.parse('2030-01-08T10:00:00Z');
const HOUR = 3_600_000;

describe('push passes', () => {
  it('finds the pass recorded for the same tree and command line, with what passed and when', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree(), CHECKS, 'pre-push checks', NOW);
    assert.deepEqual(await passOf(files, cleanTree(), CHECKS, NOW + HOUR), {
      tree: 'a1b2c3d4',
      commit: 'c0ffee12345',
      command: CHECKS,
      what: 'pre-push checks',
      passedAt: '2030-01-08T10:00:00.000Z',
      kit: KIT_VERSION,
    });
    const names = await files.list(FOLDER);
    assert.equal(names.length, 1);
    assert.match(names[0] ?? '', /^a1b2c3d4-[0-9a-f]{16}\.json$/, "the tree id, then the start of the command line's hash");
  });

  it('finds none for another tree or another command line', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree(), CHECKS, 'pre-push checks', NOW);
    assert.equal(await passOf(files, cleanTree('ffff0000'), CHECKS, NOW), undefined);
    assert.equal(await passOf(files, cleanTree(), 'npm test', NOW), undefined);
  });

  it('finds a pass of another commit with the same tree, as a rebase onto the same content makes', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree('a1b2c3d4', 'old1234'), CHECKS, 'pre-push checks', NOW);
    assert.equal((await passOf(files, cleanTree('a1b2c3d4', 'new5678'), CHECKS, NOW))?.commit, 'old1234');
  });

  it('finds none once the pass is a day old, or stamped later than now', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree(), CHECKS, 'pre-push checks', NOW);
    assert.notEqual(await passOf(files, cleanTree(), CHECKS, NOW + PASS_KEPT_MS - 1), undefined);
    assert.equal(await passOf(files, cleanTree(), CHECKS, NOW + PASS_KEPT_MS), undefined);
    assert.equal(await passOf(files, cleanTree(), CHECKS, NOW - 1), undefined);
  });

  it('finds none in a pass file it cannot read', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree(), CHECKS, 'pre-push checks', NOW);
    const [name = ''] = await files.list(FOLDER);
    for (const text of ['{"tree":', '[]', JSON.stringify({ tree: 'a1b2c3d4', command: CHECKS })]) {
      await files.write(join(FOLDER, name), text);
      assert.equal(await passOf(files, cleanTree(), CHECKS, NOW), undefined, text);
    }
  });

  it('prunes the passes no longer fresh and those it cannot read when it records one, leaving other files', async () => {
    const files = new MemoryFiles();
    await recordPass(files, cleanTree('dead01'), CHECKS, 'pre-push checks', NOW - PASS_KEPT_MS);
    await recordPass(files, cleanTree('beef02'), CHECKS, 'pre-push checks', NOW - HOUR);
    await files.write(join(FOLDER, 'bad0-0123456789abcdef.json'), '{');
    await files.write(join(FOLDER, 'notes.txt'), 'kept');
    await recordPass(files, cleanTree(), CHECKS, 'pre-push checks', NOW);
    const kept = (await files.list(FOLDER)).map((name) => name.split('-')[0]).sort();
    assert.deepEqual(kept, ['a1b2c3d4', 'beef02', 'notes.txt']);
  });
});
