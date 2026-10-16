import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { FakeWorktreeFiles, FakeWorktreeGit, type FakeGitAnswers, type FakeNode } from '../testing/fake-worktrees.ts';
import { NODE_WORKTREE_FILES } from './files.ts';
import { GIT_WORKTREES } from './git.ts';
import { carryOut, describePlan, planRemoval, type RemovalDecision, type RemovalPlan, type RemovalRequest, type WorktreePorts } from './remove.ts';

const MAIN = '/w/main';
const TOP = '/w/t4';
const MODULES = '/w/main/node_modules';
const LINK = '/w/t4/node_modules';

interface World {
  readonly files: FakeWorktreeFiles;
  readonly git: FakeWorktreeGit;
  readonly ports: WorktreePorts;
}

/**
 * A main checkout with two packages in its node_modules, and a clean linked worktree on branch t4 whose node_modules
 * is a link to it; git deletes the worktree's folder when it removes it.
 */
function world(answers: FakeGitAnswers = {}, nodes: Readonly<Record<string, FakeNode>> = {}): World {
  const files = new FakeWorktreeFiles({
    [`${MODULES}/pkg`]: { kind: 'folder' },
    [`${MODULES}/keep.txt`]: { kind: 'file' },
    [`${TOP}/src/index.ts`]: { kind: 'file' },
    [`${TOP}/.git`]: { kind: 'file' },
    [LINK]: { kind: 'link', target: MODULES },
    ...nodes,
  });
  const git = new FakeWorktreeGit(
    {
      top: TOP,
      worktrees: [
        { path: MAIN, branch: 'main', locked: undefined },
        { path: TOP, branch: 't4', locked: undefined },
      ],
      changes: [],
      tracked: ['src/index.ts'],
      defaultBase: 'origin/main',
      commitsNotOn: 0,
      ...answers,
    },
    () => files.delete(TOP),
  );
  return { files, git, ports: { git, files } };
}

function request(more: Partial<RemovalRequest> = {}): RemovalRequest {
  return { path: TOP, cwd: '/w', deleteBranch: false, base: undefined, ...more };
}

function planOf(decision: RemovalDecision): RemovalPlan {
  if (decision.kind === 'refused') {
    assert.fail(`refused: ${decision.reason}`);
  }
  return decision.plan;
}

async function refusal(decision: Promise<RemovalDecision>): Promise<string> {
  const settled = await decision;
  assert.equal(settled.kind, 'refused');
  return settled.kind === 'refused' ? settled.reason : '';
}

async function carried(plan: RemovalPlan, ports: WorktreePorts): Promise<string[]> {
  const lines: string[] = [];
  await carryOut(plan, ports, (line) => lines.push(line));
  return lines;
}

describe('planRemoval and carryOut', () => {
  it('unlinks the node_modules link before git runs, removes the worktree and leaves the link target as it was', async () => {
    const { files, git, ports } = world();
    const plan = planOf(await planRemoval(request(), ports));
    assert.deepEqual(plan.links, [{ path: join(TOP, 'node_modules'), name: 'node_modules', target: resolve(MODULES), targetEntries: 2 }]);
    assert.equal(plan.branch, undefined);
    assert.deepEqual(git.excluded, [['node_modules']], 'what git sees through the link is no change of the worktree');
    const lines = await carried(plan, ports);
    assert.deepEqual(files.unlinked, [resolve(LINK)]);
    assert.deepEqual(git.steps, [`worktree remove ${TOP} in ${MAIN}`]);
    assert.deepEqual(lines, [
      `unlinked node_modules (the link only, to ${resolve(MODULES)})`,
      `removed the worktree ${TOP}`,
      `target ${resolve(MODULES)} untouched: 2 entries, as before`,
    ]);
    assert.equal(await files.kindOf(TOP), 'missing');
    assert.deepEqual((await files.entries(MODULES)).map((entry) => entry.name).sort(), ['keep.txt', 'pkg']);
  });

  it('deletes the branch after the worktree once every commit of it is on its base', async () => {
    const { git, ports } = world();
    const plan = planOf(await planRemoval(request({ deleteBranch: true }), ports));
    assert.deepEqual(plan.branch, { name: 't4', base: 'origin/main' });
    const lines = await carried(plan, ports);
    assert.deepEqual(git.steps, [`worktree remove ${TOP} in ${MAIN}`, `branch -D t4 in ${MAIN}`]);
    assert.equal(lines.at(-1), 'deleted branch t4: every commit of it is on origin/main');
  });

  it('compares the branch with the base given instead of origin/HEAD', async () => {
    const { git, ports } = world({ defaultBase: undefined });
    assert.deepEqual(planOf(await planRemoval(request({ deleteBranch: true, base: 'trunk' }), ports)).branch, { name: 't4', base: 'trunk' });
    assert.deepEqual(git.bases, ['trunk']);
  });

  it('tells a dry run every step it would take', async () => {
    const { files, git, ports } = world();
    const plan = planOf(await planRemoval(request({ deleteBranch: true }), ports));
    assert.deepEqual(describePlan(plan), [
      `would unlink node_modules (the link only; its target ${resolve(MODULES)} holds 2 entries)`,
      `would remove the worktree ${TOP}`,
      'would delete branch t4: every commit of it is on origin/main',
    ]);
    assert.deepEqual(files.unlinked, []);
    assert.deepEqual(git.steps, []);
  });

  it('unlinks every link in the tree, deep ones too, but never walks into a link or .git', async () => {
    const { ports } = world({}, {
      '/w/t4/packages/web/node_modules': { kind: 'link', target: MODULES },
      '/w/t4/.git/hooks': { kind: 'link', target: '/w/elsewhere' },
      '/w/elsewhere/node_modules': { kind: 'folder' },
    });
    const plan = planOf(await planRemoval(request(), ports));
    assert.deepEqual(plan.links.map((link) => link.name), ['node_modules', 'packages/web/node_modules']);
  });

  it('leaves a link git tracks to git, which removes its own links without following them', async () => {
    const { git, ports } = world({ tracked: ['src/index.ts', 'tools/bin'] }, { '/w/t4/tools/bin': { kind: 'link', target: '/w/bin' } });
    const plan = planOf(await planRemoval(request(), ports));
    assert.deepEqual(plan.links.map((link) => link.name), ['node_modules']);
    assert.deepEqual(git.excluded, [['node_modules']]);
  });

  it('removes a worktree with no links, and a node_modules git tracks', async () => {
    const { ports } = world({ tracked: ['node_modules/left-pad/index.js'] }, { [LINK]: { kind: 'folder' }, [`${LINK}/left-pad/index.js`]: { kind: 'file' } });
    const plan = planOf(await planRemoval(request(), ports));
    assert.deepEqual(plan.links, []);
    assert.deepEqual(await carried(plan, ports), [`removed the worktree ${TOP}`]);
  });

  it('counts a link whose target is missing as missing before and after', async () => {
    const { ports } = world({}, { [LINK]: { kind: 'link', target: '/w/gone' } });
    const plan = planOf(await planRemoval(request(), ports));
    assert.equal(plan.links[0]?.targetEntries, undefined);
    assert.equal((await carried(plan, ports)).at(-1), `target ${resolve('/w/gone')} untouched: missing, as before`);
  });

  describe('refuses before any change', () => {
    it('a path with no folder, a link or a file', async () => {
      const { ports } = world({}, { '/w/notes.txt': { kind: 'file' } });
      assert.equal(await refusal(planRemoval(request({ path: '/w/none' }), ports)), 'no folder at /w/none');
      assert.equal(await refusal(planRemoval(request({ path: LINK }), ports)), `${LINK} is a link, not a worktree folder`);
      assert.equal(await refusal(planRemoval(request({ path: '/w/notes.txt' }), ports)), '/w/notes.txt is a file, not a worktree folder');
    });

    it('a folder outside git, or one inside a worktree', async () => {
      assert.match(await refusal(planRemoval(request(), world({ top: undefined }).ports)), /is not in a git worktree/);
      assert.match(await refusal(planRemoval(request({ path: `${TOP}/src` }), world().ports)), /is inside the worktree \/w\/t4: give its top folder/);
    });

    it('the main checkout itself', async () => {
      const { files, git, ports } = world({ top: MAIN });
      assert.equal(await refusal(planRemoval(request({ path: MAIN }), ports)), `${MAIN} is the main checkout: only a linked worktree is removed`);
      assert.deepEqual(files.unlinked, []);
      assert.deepEqual(git.steps, []);
    });

    it('when git lists no worktrees, or not this one', async () => {
      assert.match(await refusal(planRemoval(request(), world({ worktrees: undefined }).ports)), /git cannot list the worktrees/);
      assert.match(await refusal(planRemoval(request(), world({ worktrees: [] }).ports)), /git cannot list the worktrees/);
      const onlyMain = world({ worktrees: [{ path: MAIN, branch: 'main', locked: undefined }] });
      assert.match(await refusal(planRemoval(request(), onlyMain.ports)), /git does not list \/w\/t4 as a worktree/);
    });

    it('a locked worktree, with its reason when it has one', async () => {
      const locked = (reason: string): World => world({ worktrees: [{ path: MAIN, branch: 'main', locked: undefined }, { path: TOP, branch: 't4', locked: reason }] });
      assert.equal(await refusal(planRemoval(request(), locked('').ports)), `${TOP} is locked: unlock it with git worktree unlock first`);
      assert.equal(await refusal(planRemoval(request(), locked('on a laptop').ports)), `${TOP} is locked (on a laptop): unlock it with git worktree unlock first`);
    });

    it('a run from inside the worktree', async () => {
      assert.match(await refusal(planRemoval(request({ cwd: `${TOP}/src` }), world().ports)), /this runs inside \/w\/t4/);
      assert.match(await refusal(planRemoval(request({ cwd: TOP }), world().ports)), /this runs inside/);
    });

    it('a real node_modules folder where a link should be, at the top or deep', async () => {
      const { files, git, ports } = world({}, { [LINK]: { kind: 'folder' }, [`${LINK}/pkg/index.js`]: { kind: 'file' } });
      assert.match(await refusal(planRemoval(request(), ports)), /^node_modules in \/w\/t4 is a real folder, not a link: removing the worktree would delete it\./);
      assert.deepEqual(files.unlinked, []);
      assert.deepEqual(git.steps, []);
      const deep = world({}, { '/w/t4/packages/web/node_modules/x.js': { kind: 'file' } });
      assert.match(await refusal(planRemoval(request(), deep.ports)), /^packages\/web\/node_modules in \/w\/t4 is a real folder/);
    });

    it('a link git tracks files under', async () => {
      const { ports } = world({ tracked: ['node_modules/pkg/index.js'] });
      assert.match(await refusal(planRemoval(request(), ports)), /node_modules in \/w\/t4 is a link, but git tracks files under it/);
    });

    it('when git cannot list tracked files or read the status', async () => {
      assert.match(await refusal(planRemoval(request(), world({ tracked: undefined }).ports)), /git cannot list the files it tracks/);
      assert.match(await refusal(planRemoval(request(), world({ changes: undefined }).ports)), /git cannot read the status/);
    });

    it('uncommitted changes or untracked files, naming the first few', async () => {
      assert.equal(await refusal(planRemoval(request(), world({ changes: ['src/index.ts'] }).ports)), `${TOP} has uncommitted changes or untracked files (src/index.ts): commit or remove them first`);
      const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      assert.match(await refusal(planRemoval(request(), world({ changes: many }).ports)), /\(a, b, c, d, e and 2 more\)/);
    });

    it('a branch delete with no branch, no base, a base git reads as an option or the base itself', async () => {
      const detached = world({ worktrees: [{ path: MAIN, branch: 'main', locked: undefined }, { path: TOP, branch: undefined, locked: undefined }] });
      assert.match(await refusal(planRemoval(request({ deleteBranch: true }), detached.ports)), /has no branch checked out \(a detached HEAD\)/);
      assert.match(await refusal(planRemoval(request({ deleteBranch: true }), world({ defaultBase: undefined }).ports)), /origin\/HEAD names no branch: give the branch it merged into with --base <ref>/);
      assert.match(await refusal(planRemoval(request({ deleteBranch: true, base: '--all' }), world().ports)), /--base --all reads as an option to git/);
      assert.match(await refusal(planRemoval(request({ deleteBranch: true, base: 't4' }), world().ports)), /t4 is the branch it merges into \(t4\): it is kept/);
      const onMain = world({ worktrees: [{ path: '/w/bare.git', branch: undefined, locked: undefined }, { path: TOP, branch: 'main', locked: undefined }] }, { '/w/bare.git/HEAD': { kind: 'file' } });
      assert.match(await refusal(planRemoval(request({ deleteBranch: true }), onMain.ports)), /main is the branch it merges into \(origin\/main\)/);
    });

    it('a branch delete when git cannot compare, or a commit is not on the base', async () => {
      assert.match(await refusal(planRemoval(request({ deleteBranch: true }), world({ commitsNotOn: undefined }).ports)), /git cannot compare t4 with origin\/main/);
      const { files, git, ports } = world({ commitsNotOn: 2 });
      assert.match(await refusal(planRemoval(request({ deleteBranch: true }), ports)), /t4 has 2 commit\(s\) whose change is not on origin\/main \(as of the last fetch\)/);
      assert.deepEqual(files.unlinked, []);
      assert.deepEqual(git.steps, []);
    });
  });

  describe('stops and says what was done', () => {
    it('before git runs when a link is still there after its unlink', async () => {
      const { files, git, ports } = world();
      files.stuck.add(resolve(LINK));
      const plan = planOf(await planRemoval(request(), ports));
      await assert.rejects(carried(plan, ports), /node_modules is still in \/w\/t4 after its unlink, so git was not run/);
      assert.deepEqual(git.steps, []);
    });

    it('when git refuses the removal, naming the links already gone', async () => {
      const failing = world({ removal: { ok: false, reason: "fatal: '/w/t4' contains modified or untracked files" } });
      const plan = planOf(await planRemoval(request(), failing.ports));
      await assert.rejects(carried(plan, failing.ports), /contains modified or untracked files \(its links are already gone: node_modules\)$/);
      const noLinks = world({ tracked: ['node_modules/a.js'], removal: { ok: false, reason: 'fatal: busy' } }, { [LINK]: { kind: 'folder' } });
      await assert.rejects(carried(planOf(await planRemoval(request(), noLinks.ports)), noLinks.ports), /^Error: git worktree remove \/w\/t4: fatal: busy$/);
    });

    it('when a link target changed during the removal', async () => {
      const files = new FakeWorktreeFiles({ [`${MODULES}/keep.txt`]: { kind: 'file' }, [`${MODULES}/pkg`]: { kind: 'folder' }, [LINK]: { kind: 'link', target: MODULES } });
      const git = new FakeWorktreeGit({}, () => files.delete(`${MODULES}/keep.txt`));
      const plan: RemovalPlan = { top: TOP, mainDir: MAIN, links: [{ path: resolve(LINK), name: 'node_modules', target: resolve(MODULES), targetEntries: 2 }], branch: undefined };
      await assert.rejects(carried(plan, { git, files }), /held 2 entries before and 1 entry after the removal/);
    });

    it('when the branch delete fails after the removal', async () => {
      const { ports } = world({ deletion: { ok: false, reason: "error: branch 't4' not found" } });
      const plan = planOf(await planRemoval(request({ deleteBranch: true }), ports));
      await assert.rejects(carried(plan, ports), /the worktree is removed, but git branch -D t4: error: branch 't4' not found/);
    });
  });
});

/** A repo on `main` whose gitignored node_modules holds two packages, and a linked worktree on `feat` that links to it. */
function realWorld(prefix: string): { repo: TempRepo; worktree: string; modules: string } {
  const repo = new TempRepo(prefix).init();
  repo.git('checkout', '-q', '-b', 'main');
  repo.write('.gitignore', 'node_modules/\n');
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'first');
  repo.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  repo.write('node_modules/keep.txt', 'keep\n');
  const worktree = join(repo.outside, 'feat');
  repo.git('worktree', 'add', '-q', '-b', 'feat', worktree);
  const modules = realpathSync.native(join(repo.dir, 'node_modules'));
  symlinkSync(modules, join(worktree, 'node_modules'), 'junction');
  return { repo, worktree, modules };
}

const REAL: WorktreePorts = { git: GIT_WORKTREES, files: NODE_WORKTREE_FILES };

describe('removing a real worktree with a real node_modules link', () => {
  it('unlinks the link, removes the worktree and its merged branch, and keeps every file the link pointed to', async () => {
    const { repo, worktree, modules } = realWorld('wt-real');
    try {
      writeFileSync(join(worktree, 'src', 'b.ts'), 'export const b = 2;\n');
      repo.git('-C', worktree, 'add', '-A');
      repo.git('-C', worktree, 'commit', '-q', '-m', 'b');
      repo.git('merge', '-q', '--ff-only', 'feat');
      const plan = planOf(await planRemoval({ path: worktree, cwd: repo.dir, deleteBranch: true, base: 'main' }, REAL));
      assert.deepEqual(plan.links.map((link) => [link.name, realpathSync.native(link.target), link.targetEntries]), [['node_modules', modules, 2]]);
      const lines = await carried(plan, REAL);
      assert.equal(lines.length, 4);
      assert.equal(existsSync(worktree), false);
      assert.deepEqual(readdirSync(modules).sort(), ['keep.txt', 'pkg']);
      assert.equal(readFileSync(join(modules, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
      assert.equal(repo.git('branch', '--list', 'feat'), '');
      assert.equal(repo.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
    } finally {
      repo.remove();
    }
  });

  it('refuses the main checkout, a real node_modules folder and an unmerged branch, and changes nothing', async () => {
    const { repo, worktree, modules } = realWorld('wt-real-refuse');
    try {
      assert.match(await refusal(planRemoval({ path: repo.dir, cwd: repo.outside, deleteBranch: false, base: undefined }, REAL)), /is the main checkout/);
      writeFileSync(join(worktree, 'src', 'b.ts'), 'export const b = 2;\n');
      repo.git('-C', worktree, 'add', '-A');
      repo.git('-C', worktree, 'commit', '-q', '-m', 'b');
      assert.match(await refusal(planRemoval({ path: worktree, cwd: repo.dir, deleteBranch: true, base: 'main' }, REAL)), /feat has 1 commit\(s\) whose change is not on main/);
      writeFileSync(join(worktree, 'scratch.txt'), 'draft\n');
      assert.match(await refusal(planRemoval({ path: worktree, cwd: repo.dir, deleteBranch: false, base: undefined }, REAL)), /has uncommitted changes or untracked files \(scratch\.txt\)/);
      assert.equal(await NODE_WORKTREE_FILES.kindOf(join(worktree, 'node_modules')), 'link', 'the link stays until every check passes');

      await NODE_WORKTREE_FILES.unlinkLink(join(worktree, 'node_modules'));
      mkdirSync(join(worktree, 'node_modules', 'own'), { recursive: true });
      assert.match(await refusal(planRemoval({ path: worktree, cwd: repo.dir, deleteBranch: false, base: undefined }, REAL)), /node_modules in .* is a real folder, not a link/);
      assert.ok(existsSync(join(worktree, 'node_modules', 'own')));
      assert.deepEqual(readdirSync(modules).sort(), ['keep.txt', 'pkg']);
    } finally {
      repo.remove();
    }
  });
});
