import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CliHarness } from '../testing/cli-harness.ts';
import { FakeWorktreeFiles, FakeWorktreeGit, type FakeGitAnswers } from '../testing/fake-worktrees.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import { EXIT } from './runtime.ts';

const MODULES = '/w/main/node_modules';

/** A clean worktree at /w/t4 on branch t4, whose node_modules links to the main checkout's two packages. */
function worktrees(answers: FakeGitAnswers = {}): { files: FakeWorktreeFiles; git: FakeWorktreeGit; ports: WorktreePorts } {
  const files = new FakeWorktreeFiles({
    [`${MODULES}/pkg`]: { kind: 'folder' },
    [`${MODULES}/keep.txt`]: { kind: 'file' },
    '/w/t4/src/index.ts': { kind: 'file' },
    '/w/t4/node_modules': { kind: 'link', target: MODULES },
  });
  const git = new FakeWorktreeGit(
    {
      top: '/w/t4',
      worktrees: [
        { path: '/w/main', branch: 'main', locked: undefined },
        { path: '/w/t4', branch: 't4', locked: undefined },
      ],
      changes: [],
      tracked: ['src/index.ts'],
      defaultBase: 'origin/main',
      commitsNotOn: 0,
      ...answers,
    },
    () => files.delete('/w/t4'),
  );
  return { files, git, ports: { git, files } };
}

describe('runCli: worktree remove', () => {
  it('unlinks the link, removes the worktree and its merged branch, with no team set up', async () => {
    const { git, ports } = worktrees();
    const result = await new CliHarness(null, null).run(['worktree', 'remove', '/w/t4', '--delete-branch'], { worktrees: ports });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      `unlinked node_modules (the link only, to ${resolve(MODULES)})`,
      'removed the worktree /w/t4',
      `target ${resolve(MODULES)} untouched: 2 entries, as before`,
      'deleted branch t4: every commit of it is on origin/main',
      'OK removed /w/t4',
    ]);
    assert.deepEqual(git.steps, ['worktree remove /w/t4 in /w/main', 'branch -D t4 in /w/main']);
  });

  it('prints the steps of a dry run and changes nothing', async () => {
    const { files, git, ports } = worktrees();
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4', '--dry-run'], { worktrees: ports });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      `would unlink node_modules (the link only; its target ${resolve(MODULES)} holds 2 entries)`,
      'would remove the worktree /w/t4',
      'dry run: nothing changed',
    ]);
    assert.deepEqual(files.unlinked, []);
    assert.deepEqual(git.steps, []);
  });

  it('refuses an unsafe removal before any change', async () => {
    const { files, git, ports } = worktrees({ changes: ['src/index.ts'] });
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, ['REFUSED /w/t4 has uncommitted changes or untracked files (src/index.ts): commit or remove them first']);
    assert.deepEqual(files.unlinked, []);
    assert.deepEqual(git.steps, []);
  });

  it('resolves a relative path against the folder it runs in', async () => {
    const { ports } = worktrees();
    const result = await new CliHarness().run(['worktree', 'remove', 't4', '--dry-run'], { worktrees: ports, cwd: '/w' });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
  });

  it('fails when git refuses the removal, naming what was done', async () => {
    const { ports } = worktrees({ removal: { ok: false, reason: 'fatal: busy' } });
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stderr.join('\n'), /git worktree remove \/w\/t4: fatal: busy \(its links are already gone: node_modules\)/);
  });

  it('needs a path, and --base only with --delete-branch', async () => {
    const kit = new CliHarness();
    assert.equal((await kit.run(['worktree', 'remove'])).code, EXIT.usage);
    const base = await kit.run(['worktree', 'remove', '/w/t4', '--base', 'main'], { worktrees: worktrees().ports });
    assert.equal(base.code, EXIT.usage);
    assert.match(base.stderr.join('\n'), /--base names the branch to check against for --delete-branch/);
  });
});
