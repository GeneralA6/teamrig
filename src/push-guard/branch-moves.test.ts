import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BranchMoves, type BranchView } from './branch-moves.ts';
import type { GitInvocation } from './invocations.ts';
import type { MapChange } from './named-push.ts';
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

/** What the line may have changed of where a branch named alone pushes, after each command runs in `dir`. */
function changeAfter(commands: readonly string[], dir: string | undefined = CWD): MapChange {
  const moves = new BranchMoves(new Set(['main']));
  commands.forEach((command) => moves.observe(invocation(command, dir)));
  return moves.mapChange();
}

describe('BranchMoves: mapChange', () => {
  it('sees no change from a command that writes no push mapping', () => {
    const commands = ['status', 'config --get push.default', 'config user.name me', 'branch', 'branch --list t1-*', 'branch --show-current', 'branch --contains HEAD', 'remote -v', 'remote show origin', 'remote set-url origin x', 'checkout main', 'switch feature-x', 'worktree list'];
    for (const command of commands) {
      assert.equal(changeAfter([command]), 'none', command);
    }
    assert.equal(changeAfter([]), 'none');
  });

  it('sees an upstream change from a branch it makes or gives an upstream', () => {
    const commands = ['branch t1-x origin/main', 'branch -u origin/main', 'branch --set-upstream-to=origin/main', 'branch --unset-upstream', 'branch -m t1-y', 'branch -c t1-x t1-y', 'checkout -b hotfix', 'switch -c hotfix origin/main', 'switch --track origin/main', 'checkout -t origin/x', 'worktree add ../w -b t1-x origin/main'];
    for (const command of commands) {
      assert.equal(changeAfter([command]), 'upstream', command);
    }
  });

  it('sees a config change from a write of remote, push or branch keys, or a remote added, renamed or removed', () => {
    const commands = ['config push.default upstream', 'config branch.t1-x.merge refs/heads/main', 'config --add remote.origin.push refs/heads/*:refs/heads/main', 'remote add fork x', 'remote rename origin up', 'remote remove fork', 'remote rm fork'];
    for (const command of commands) {
      assert.equal(changeAfter([command]), 'config', command);
    }
  });

  it('keeps the widest change of the line, in a folder only known when it runs too', () => {
    assert.equal(changeAfter(['branch t1-x', 'status']), 'upstream');
    assert.equal(changeAfter(['config push.default upstream', 'branch t1-x']), 'config');
    assert.equal(changeAfter(['branch t1-x', 'config remote.origin.push x', 'status']), 'config');
    assert.equal(changeAfter(['branch t1-x'], undefined), 'upstream');
  });
});
