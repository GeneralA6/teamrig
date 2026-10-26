import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { basename, resolve } from 'node:path';
import { teamPaths } from '../core/home.ts';
import { InboxDir } from '../inbox/store.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { sessionFilesOf } from './session-files.ts';

const PATHS = teamPaths(resolve('/', 'kit'), 'app', resolve('/', 'claude'));

describe('sessionFilesOf', () => {
  it("names each file and folder from the session's id alone", () => {
    for (const path of sessionFilesOf(PATHS, 'alpha')) {
      const name = basename(path);
      assert.ok(name === 'alpha' || name.startsWith('alpha.'), path);
    }
  });

  it('gives two sessions no path in common, and one session no path twice', () => {
    const alpha = sessionFilesOf(PATHS, 'alpha');
    const both = [...alpha, ...sessionFilesOf(PATHS, 'alphabet')];
    assert.equal(new Set(both).size, both.length);
    assert.equal(new Set(alpha).size, 18);
  });

  it('holds the file the inbox store writes a session its lines in', async () => {
    const files = new MemoryFiles();
    await new InboxDir(files, PATHS.inbox).append('alpha', 'a line');
    // The memory store keeps paths with forward slashes; resolved, they read as the platform writes them.
    const written = files.paths().map((path) => resolve(path));
    assert.equal(written.length, 1);
    assert.ok(sessionFilesOf(PATHS, 'alpha').includes(written[0] ?? ''), written.join(', '));
  });
});
