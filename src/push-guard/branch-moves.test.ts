import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BranchMoves, type BranchView } from './branch-moves.ts';
import type { GitInvocation } from './invocations.ts';
import { parseShell } from './tokenizer.ts';

const CWD = '/work/app';

/** The git invocation `git <command>` makes in `dir`. */
function invocation(command: string, dir: string | undefined): GitInvocation {
  const [sub, ...args] = parseShell(command, 'bash').commands[0]?.words ?? [];
  return { dir, subcommand: sub?.text ?? '', args, configOverride: false };
}

/** The view of `dir` after each command runs in {@link CWD}. */
function viewAfter(commands: readonly string[], dir = CWD): BranchView {
  const moves = new BranchMoves(new Set(['main']));
  commands.forEach((command) => moves.observe(invocation(command, CWD)));
  return moves.view(dir);
}

const REPO: BranchView = { kind: 'repo' };
const UNKNOWN: BranchView = { kind: 'unknown' };
const branch = (name: string, target: 'read' | 'same' | 'unknown'): BranchView => ({ kind: 'branch', branch: name, target });

describe('BranchMoves: checkout and switch', () => {
  it('starts from the repository', () => {
    assert.deepEqual(viewAfter([]), REPO);
    assert.deepEqual(viewAfter(['status', 'commit -m x']), REPO);
  });

  it('reads a switch to an existing branch, and trusts checkout only for a protected name', () => {
    assert.deepEqual(viewAfter(['checkout main']), branch('main', 'read'));
    assert.deepEqual(viewAfter(['switch feature-x']), branch('feature-x', 'read'));
    assert.deepEqual(viewAfter(['checkout feature-x']), UNKNOWN);
    assert.deepEqual(viewAfter(['checkout --conflict merge main']), branch('main', 'read'));
    assert.deepEqual(viewAfter(['switch --track main']), branch('main', 'unknown'));
  });

  it('reads a new branch, which has no upstream unless it starts from one', () => {
    assert.deepEqual(viewAfter(['switch -c hotfix']), branch('hotfix', 'same'));
    assert.deepEqual(viewAfter(['switch --create=hotfix']), branch('hotfix', 'same'));
    assert.deepEqual(viewAfter(['checkout -b hotfix']), branch('hotfix', 'same'));
    assert.deepEqual(viewAfter(['checkout -B hotfix']), branch('hotfix', 'same'));
    assert.deepEqual(viewAfter(['switch -c hotfix origin/main']), branch('hotfix', 'unknown'));
    assert.deepEqual(viewAfter(['switch -c "$B"']), UNKNOWN);
  });

  it('moves nothing on a file checkout or a bare checkout', () => {
    for (const command of ['checkout -- main', 'checkout -p main', 'checkout main file.txt', 'checkout']) {
      assert.deepEqual(viewAfter([command]), REPO, command);
    }
  });

  it('cannot follow a detach, the previous branch or a branch only known when it runs', () => {
    for (const command of ['checkout -', 'checkout --detach', 'switch -d HEAD~1', 'checkout "$B"']) {
      assert.deepEqual(viewAfter([command]), UNKNOWN, command);
    }
  });
});

describe('BranchMoves: other moves', () => {
  it('cannot follow a renamed or re-targeted branch, a two-operand rebase or a bisect', () => {
    for (const command of ['branch -m new', 'branch --set-upstream-to=origin/main', 'rebase origin/main feature', 'bisect start']) {
      assert.deepEqual(viewAfter([command]), UNKNOWN, command);
    }
    assert.deepEqual(viewAfter(['branch feature']), REPO);
    assert.deepEqual(viewAfter(['rebase origin/main']), REPO);
  });

  it('cannot follow a config change of remotes, push or branches, in any folder', () => {
    assert.deepEqual(viewAfter(['config branch.feature.merge refs/heads/main']), UNKNOWN);
    assert.deepEqual(viewAfter(['config branch.feature.merge refs/heads/main'], '/elsewhere'), UNKNOWN);
    assert.deepEqual(viewAfter(['config --get branch.feature.merge']), REPO);
    assert.deepEqual(viewAfter(['config user.name me']), REPO);
  });
});

describe('BranchMoves: folders', () => {
  it('keeps a view per folder, and makes every other folder unknown on a move', () => {
    const moves = new BranchMoves(new Set(['main']));
    moves.observe(invocation('checkout main', '/a'));
    assert.deepEqual(moves.view('/a'), branch('main', 'read'));
    assert.deepEqual(moves.view('/b'), UNKNOWN);
    moves.observe(invocation('switch -c x', '/b'));
    assert.deepEqual(moves.view('/a'), UNKNOWN);
    assert.deepEqual(moves.view('/b'), branch('x', 'same'));
  });

  it('makes every view unknown on a move in a folder only known when it runs', () => {
    const moves = new BranchMoves(new Set(['main']));
    moves.observe(invocation('checkout main', undefined));
    assert.deepEqual(moves.view(CWD), UNKNOWN);
  });
});
