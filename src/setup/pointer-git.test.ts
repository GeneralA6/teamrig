import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { GIT_POINTER } from './pointer-git.ts';

describe('GIT_POINTER', () => {
  it('reads a folder git cannot run in as no-git', () => {
    assert.deepEqual(GIT_POINTER.state(join(tmpdir(), 'teamrig-no-such-folder', '.teamrig.json')), { kind: 'no-git' });
  });

  it('names the exclude file for a pointer git neither tracks nor ignores, at the root or below it', () => {
    const repo = new TempRepo('pointer-open').init();
    try {
      const exclude = join(repo.dir, '.git', 'info', 'exclude');
      repo.write('app/readme.md', 'app');
      assert.deepEqual(GIT_POINTER.state(join(repo.dir, '.teamrig.json')), { kind: 'open', exclude });
      assert.deepEqual(GIT_POINTER.state(join(repo.dir, 'app', '.teamrig.json')), { kind: 'open', exclude });
    } finally {
      repo.remove();
    }
  });

  it('reads a committed pointer as tracked, and one a .gitignore covers as ignored', () => {
    const repo = new TempRepo('pointer-kept').init();
    try {
      repo.write('.teamrig.json', '{"team": "shop"}');
      repo.git('add', '.teamrig.json');
      repo.git('commit', '-q', '-m', 'pointer');
      assert.deepEqual(GIT_POINTER.state(join(repo.dir, '.teamrig.json')), { kind: 'tracked' });
      repo.write('app/.gitignore', '.teamrig.json\n');
      assert.deepEqual(GIT_POINTER.state(join(repo.dir, 'app', '.teamrig.json')), { kind: 'ignored' });
    } finally {
      repo.remove();
    }
  });

  it("names the main checkout's exclude file for a pointer in a linked worktree", () => {
    const repo = new TempRepo('pointer-worktree').init();
    try {
      repo.git('commit', '-q', '--allow-empty', '-m', 'base');
      const linked = join(repo.outside, 'linked');
      repo.git('worktree', 'add', '-q', linked);
      assert.deepEqual(GIT_POINTER.state(join(linked, '.teamrig.json')), { kind: 'open', exclude: join(repo.dir, '.git', 'info', 'exclude') });
    } finally {
      repo.remove();
    }
  });
});
