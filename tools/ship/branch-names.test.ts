import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { freeBranch } from './branch-names.ts';

/** git whose local branches and origin's heads are the names given. */
const gitWith = (local: readonly string[], remote: readonly string[]) =>
  mock.fn((...args: string[]): string => {
    const [command, , ...rest] = args;
    if (command === 'branch') return local.includes(rest[0] ?? '') ? `  ${rest[0] ?? ''}` : '';
    if (command === 'ls-remote') {
      const name = (rest[1] ?? '').replace('refs/heads/', '');
      return remote.includes(name) ? `abc\trefs/heads/${name}` : '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  });

test('names the stem with -2 when no branch has that name', () => {
  const git = gitWith([], []);
  assert.equal(freeBranch(git, 't1-change'), 't1-change-2');
  assert.deepEqual(
    git.mock.calls.map((call) => call.arguments),
    [
      ['branch', '--list', 't1-change-2'],
      ['ls-remote', '--heads', 'origin', 'refs/heads/t1-change-2'],
    ],
  );
});

test('skips a number taken here or on origin', () => {
  assert.equal(freeBranch(gitWith(['t1-change-2'], ['t1-change-3']), 't1-change'), 't1-change-4');
});
