import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_CLI } from './git.ts';

describe('GIT_CLI', () => {
  it('reads the branch of a new repository, with no push target yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamrig-git-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir, stdio: 'ignore' });
      assert.equal(GIT_CLI.branch(dir), 'trunk');
      assert.equal(GIT_CLI.pushTarget(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads as unknown where git cannot run', () => {
    const missing = join(tmpdir(), 'teamrig-no-such-folder');
    assert.equal(GIT_CLI.branch(missing), undefined);
    assert.equal(GIT_CLI.pushTarget(missing), undefined);
  });
});
