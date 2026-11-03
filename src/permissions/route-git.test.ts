import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGitCommit, matchesGitPush, type GitContext } from './route-git.ts';

const words = (line: string): string[] => line.split(' ');

describe('matchesGitCommit', () => {
  it('takes a commit with the allowed options, in clusters and long forms, and pathspecs', () => {
    for (const line of [
      'git commit -s -m msg',
      'git commit -asm msg',
      'git commit -q -F C:/s/msg.txt',
      'git commit --signoff --all --quiet --message msg',
      'git commit --message=msg --file=C:/s/msg.txt',
      'git -C C:/w commit -s -m msg',
      'git -C C:/w -C sub commit -s -m msg',
      'git commit -s -m msg src/a.ts src/b.ts',
      'git commit src/a.ts -m msg',
      'git commit -m msg -- -odd-name.ts',
      'git commit',
    ]) {
      assert.equal(matchesGitCommit(words(line)), true, line);
    }
  });

  it('takes no option off the allowlist: -n anywhere, a prefix git would take, --amend, -c, -C', () => {
    for (const line of [
      'git commit -n -m msg',
      'git commit -an -m msg',
      'git commit -nm msg',
      'git commit -ma msg',
      'git commit --no-verify -m msg',
      'git commit --no-veri -m msg',
      'git commit --no-signoff -m msg',
      'git commit --amend --no-edit',
      'git commit -C HEAD',
      'git commit -c HEAD',
      'git commit --all=x -m msg',
      'git commit --sign -m msg',
      'git commit -mfoo',
      'git commit - -m msg',
    ]) {
      assert.equal(matchesGitCommit(words(line)), false, line);
    }
  });

  it('takes a value only when it is there and cannot read as an option', () => {
    for (const line of ['git commit -m', 'git commit -s -m -n', 'git commit --message', 'git commit -F --no-verify']) {
      assert.equal(matchesGitCommit(words(line)), false, line);
    }
  });

  it('takes no global option but -C with a folder, and no other program or subcommand', () => {
    for (const line of [
      'git -c core.hooksPath=/x commit -m msg',
      'git --git-dir=/x commit -m msg',
      'git --work-tree /x commit -m msg',
      'git --exec-path=/x commit -m msg',
      'git --config-env=a=b commit -m msg',
      'git -C commit -m msg',
      'git -C -x commit -m msg',
      'git -C',
      '/usr/bin/git commit -m msg',
      'git push origin t1-x',
      'git',
    ]) {
      assert.equal(matchesGitCommit(words(line)), false, line);
    }
    assert.equal(matchesGitCommit([]), false);
  });
});

describe('matchesGitPush', () => {
  const asked: string[] = [];
  const context: GitContext = {
    ownsTask: async (task) => (asked.push(task), task === 'T1' || task === 'T3'),
    isRemote: async (folders, name) => (asked.push(`${folders.join('|')} ${name}`), name === 'origin' || name === 'up.stream'),
    pushesToSameName: async (folders, remote) => (asked.push(`same name ${folders.join('|')} ${remote}`), true),
    protectedBranches: ['main', 't3-release'],
  };
  const push = async (line: string, at: GitContext = context): Promise<boolean> => matchesGitPush(words(line), at);

  it('takes a push of an own task branch to a configured remote, with -u and -q', async () => {
    for (const line of ['git push origin t1-x', 'git push -u origin t1-x', 'git push -uq origin t1-x', 'git push --set-upstream --quiet up.stream T1', 'git push origin -u t1-a/b']) {
      assert.equal(await push(line), true, line);
    }
    asked.length = 0;
    assert.equal(await push('git -C C:/w -C sub push origin t1-x'), true);
    assert.deepEqual(asked, ['T1', 'C:/w|sub origin', 'same name C:/w|sub origin']);
  });

  it("takes no push git's config sends to another branch than its own name, such as its upstream main", async () => {
    const mapped: GitContext = { ...context, pushesToSameName: async () => false };
    for (const line of ['git push origin t1-x', 'git push -u origin t1-x', 'git -C C:/w push up.stream T1']) {
      assert.equal(await push(line, mapped), false, line);
    }
  });

  it('takes no force, delete, mirror, hook skip or other option', async () => {
    for (const option of ['-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--delete', '-d', '--prune', '--no-verify', '--receive-pack=x', '--exec=x', '--repo=x', '-o', '-uf', '--', '-']) {
      assert.equal(await push(`git push ${option} origin t1-x`), false, option);
    }
  });

  it('takes only one remote the repository names and one plain branch', async () => {
    for (const line of [
      'git push',
      'git push origin',
      'git push origin t1-x t1-y',
      'git push https://example.com/r.git t1-x',
      'git push ../other t1-x',
      'git push ext::sh t1-x',
      'git push fork t1-x',
      'git push origin t1-x:main',
      'git push origin +t1-x',
      'git push origin refs/heads/t1-x',
      'git push origin HEAD',
      'git push origin t1-x..t1-y',
      'git push origin t1-x@{0}',
    ]) {
      assert.equal(await push(line), false, line);
    }
  });

  it('takes only a branch of a task the caller owns, never a protected one, whatever its case', async () => {
    for (const branch of ['t2-x', 'feature-x', 'main', 'MAIN', 't3-release', 'T3-Release', 't9-x']) {
      assert.equal(await push(`git push origin ${branch}`), false, branch);
    }
  });

  it('asks about the task only once the line matches, about the remote only for an own task, and about where it lands only for a remote the repository names', async () => {
    asked.length = 0;
    await push('git push -f origin t1-x');
    await push('git push origin main');
    await push('git push https://example.com/r.git t1-x');
    assert.deepEqual(asked, []);
    assert.equal(await push('git push origin t2-x'), false);
    assert.deepEqual(asked, ['T2']);
    asked.length = 0;
    assert.equal(await push('git push fork t1-x'), false);
    assert.deepEqual(asked, ['T1', ' fork']);
  });
});
