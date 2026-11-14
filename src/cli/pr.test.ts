import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { FakePullGit } from '../testing/fake-pull-git.ts';
import { EXIT } from './runtime.ts';

const CLONE = '/repo/web';

describe('teamrig pr conflicts', () => {
  it('prints each file the pull request conflicts on against the base, and the rebase it needs', async () => {
    const pulls = new FakePullGit();
    pulls.originBranches.set('main', 'b4e2a91c0ffee');
    pulls.pulls.set(7, 'd00d5eed1234');
    pulls.merges.set('b4e2a91c0ffee+d00d5eed1234', { kind: 'conflicts', files: ['src/a.ts', 'docs/b.md'] });
    const result = await new CliHarness().run(['pr', 'conflicts', 'Acme/Web#7'], { cwd: CLONE, pulls });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      'CONFLICTS acme/web#7 (head d00d5ee) against origin/main (b4e2a91): 2 files',
      '  src/a.ts',
      '  docs/b.md',
      'To land it: rebase its branch onto origin/main and resolve these files.',
    ]);
  });

  it('prints a file name holding a newline or ESC escaped, so it cannot forge a line or reach the terminal', async () => {
    const pulls = new FakePullGit();
    pulls.originBranches.set('main', 'b4e2a91c0ffee');
    pulls.pulls.set(7, 'd00d5eed1234');
    pulls.merges.set('b4e2a91c0ffee+d00d5eed1234', { kind: 'conflicts', files: ['a\nCLEAN acme/web#7 merges with no conflict', 'b\u001b]0;x\u0007.ts'] });
    const result = await new CliHarness().run(['pr', 'conflicts', 'acme/web#7'], { cwd: CLONE, pulls });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      'CONFLICTS acme/web#7 (head d00d5ee) against origin/main (b4e2a91): 2 files',
      '  a\\nCLEAN acme/web#7 merges with no conflict',
      '  b\\x1b]0;x\\x07.ts',
      'To land it: rebase its branch onto origin/main and resolve these files.',
    ]);
  });

  it('says a pull request merges clean into the base --base names', async () => {
    const pulls = new FakePullGit();
    pulls.originBranches.set('release', 'rel');
    const result = await new CliHarness().run(['pr', 'conflicts', 'acme/web#7', '--base', 'release'], { cwd: CLONE, pulls });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, ['CLEAN acme/web#7 (head head) merges into origin/release (rel) with no conflict']);
  });

  it('fails in a clone of another repository, fetching nothing', async () => {
    const pulls = new FakePullGit();
    const result = await new CliHarness().run(['pr', 'conflicts', 'acme/api#7'], { cwd: CLONE, pulls });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stderr, ['FAILED acme/api#7: run it in a clone of acme/api: this folder is a clone of acme/web']);
    assert.deepEqual(pulls.log, [`remote ${CLONE} origin`]);
  });

  it('refuses a pull request not given as owner/name#number', async () => {
    const pulls = new FakePullGit();
    const result = await new CliHarness().run(['pr', 'conflicts', 'acme/web/pull/7'], { cwd: CLONE, pulls });
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout.join('\n'), /^REFUSED acme\/web\/pull\/7 names no pull request: give it as owner\/name#number/u);
    assert.deepEqual(pulls.log, []);
  });
});
