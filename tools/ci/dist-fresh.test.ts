import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGit } from '../lib/fake-git.ts';
import { DIST_DIR, staleDistEntries } from './dist-fresh.ts';

const STATUS = `status --porcelain --untracked-files=all -- ${DIST_DIR}`;

describe('staleDistEntries', () => {
  it('reports nothing when the rebuilt dist matches the commit', async () => {
    assert.deepEqual(await staleDistEntries(new FakeGit({ [STATUS]: '' })), []);
  });

  it('reports changed, added and deleted dist files', async () => {
    const status = ` M ${DIST_DIR}/a.js\n?? ${DIST_DIR}/b.js\n D ${DIST_DIR}/c.js\n`;
    assert.deepEqual(await staleDistEntries(new FakeGit({ [STATUS]: status })), [
      ` M ${DIST_DIR}/a.js`,
      `?? ${DIST_DIR}/b.js`,
      ` D ${DIST_DIR}/c.js`,
    ]);
  });
});
