import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { pushOwnBranch } from './push.ts';

const SHA = 'abc1230000000000000000000000000000000000';

/** git with the checked-out branch and what origin's ls-remote lists for it. */
const gitWith = (branch: string, listed: string) =>
  mock.fn((...args: string[]): string => {
    if (args[0] === 'rev-parse') return branch;
    if (args[0] === 'ls-remote') return listed;
    if (args[0] === 'push') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  });

test('pushes a branch origin does not have yet as a plain push', () => {
  const git = gitWith('t629-one-hold', '');
  assert.equal(pushOwnBranch(git, 'main'), 't629-one-hold');
  assert.deepEqual(git.mock.calls.at(-1)?.arguments, ['push', '--quiet', 'origin', 'HEAD:refs/heads/t629-one-hold']);
  assert.deepEqual(git.mock.calls[1]?.arguments, ['ls-remote', '--heads', 'origin', 'refs/heads/t629-one-hold']);
});

test('replaces a branch pushed before only while origin still has the sha it listed', () => {
  const git = gitWith('t629-one-hold', `${SHA}\trefs/heads/t629-one-hold`);
  pushOwnBranch(git, 'main');
  assert.deepEqual(git.mock.calls.at(-1)?.arguments, ['push', '--quiet', `--force-with-lease=refs/heads/t629-one-hold:${SHA}`, 'origin', 'HEAD:refs/heads/t629-one-hold']);
});

test('never pushes main, master, the repo\'s own main or a detached HEAD', () => {
  for (const [branch, main] of [['main', 'main'], ['master', 'main'], ['trunk', 'trunk']] as const) {
    const git = gitWith(branch, '');
    assert.throws(() => pushOwnBranch(git, main), new RegExp(`^Error: REFUSED ${branch} is a branch changes merge into`));
    assert.ok(!git.mock.calls.some((call) => call.arguments[0] === 'push'));
  }
  assert.throws(() => pushOwnBranch(gitWith('HEAD', ''), 'main'), /REFUSED the repo dir has a detached HEAD/);
});
