import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import type { GitRun } from '../core/git-run.ts';
import { GIT_POINTER, pointerGitWith } from './pointer-git.ts';

/** A git that answers rev-parse with the exclude file, and each other query with the run its first word names. */
function fakeGit(runs: Readonly<Record<string, GitRun>>) {
  return pointerGitWith((_dir, args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '.git/info/exclude\n', stderr: '' } : (runs[args[0] ?? ''] ?? { status: 1, stdout: '', stderr: '' })));
}

const NO_ANSWER: GitRun = { status: null, stdout: '', stderr: '', unanswered: 'stopped by SIGTERM' };
const NOT: GitRun = { status: 1, stdout: '', stderr: '' };

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

  it('reads an ls-files that gives no answer, or one other than 0 or 1, as no-git, never as not tracked (#837)', () => {
    const pointer = join(tmpdir(), 'repo', '.teamrig.json');
    const fatal: GitRun = { status: 128, stdout: '', stderr: 'fatal: index file corrupt' };
    for (const run of [NO_ANSWER, fatal]) {
      assert.deepEqual(fakeGit({ 'ls-files': run, 'check-ignore': NOT }).state(pointer), { kind: 'no-git' }, String(run.status));
    }
    assert.deepEqual(fakeGit({ 'ls-files': NOT, 'check-ignore': NO_ANSWER }).state(pointer), { kind: 'no-git' });
    assert.deepEqual(fakeGit({ 'ls-files': NOT, 'check-ignore': NOT }).state(pointer), { kind: 'open', exclude: join(tmpdir(), 'repo', '.git', 'info', 'exclude') });
  });

  it('reads a rev-parse that gives no answer as no-git', () => {
    const pointer = pointerGitWith(() => NO_ANSWER);
    assert.deepEqual(pointer.state(join(tmpdir(), 'repo', '.teamrig.json')), { kind: 'no-git' });
  });

  it("reads the repository the pointer is in, never the one a caller's git hook names in GIT_DIR", () => {
    const repo = new TempRepo('pointer-own').init();
    const other = new TempRepo('pointer-other').init();
    const before = process.env['GIT_DIR'];
    try {
      repo.write('.teamrig.json', '{"team": "shop"}');
      repo.git('add', '.teamrig.json');
      repo.git('commit', '-q', '-m', 'pointer');
      process.env['GIT_DIR'] = join(other.dir, '.git');
      assert.deepEqual(GIT_POINTER.state(join(repo.dir, '.teamrig.json')), { kind: 'tracked' });
    } finally {
      if (before === undefined) {
        delete process.env['GIT_DIR'];
      } else {
        process.env['GIT_DIR'] = before;
      }
      repo.remove();
      other.remove();
    }
  });
});
