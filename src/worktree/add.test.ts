import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeWorktreeFiles, FakeWorktreeGit, type FakeGitAnswers } from '../testing/fake-worktrees.ts';
import { createWorktree, MAIN_CHECKOUT_ENV, type AddEnd, type AddRequest } from './add.ts';
import { branchNameProblem } from './branch-name.ts';

const SETUP = ['node', 'tools/link-modules.ts'];
const REQUEST: AddRequest = { branch: 't9/parser', mainDir: '/w/main', folder: '/w/wt', setup: SETUP, env: { PATH: '/bin' } };
const PATH = join('/w/wt', 't9-parser');

/** A repository whose origin/HEAD names origin/main, with only main as a local branch, and nothing in /w/wt yet. */
function world(answers: FakeGitAnswers = {}): { git: FakeWorktreeGit; files: FakeWorktreeFiles; hooks: FakeHooks } {
  return { git: new FakeWorktreeGit({ defaultBase: 'origin/main', branches: ['main'], ...answers }), files: new FakeWorktreeFiles(), hooks: new FakeHooks() };
}

async function add(ports: ReturnType<typeof world>, request: Partial<AddRequest> = {}): Promise<{ end: AddEnd; said: string[] }> {
  const said: string[] = [];
  const end = await createWorktree({ ...REQUEST, ...request }, ports, (line) => said.push(line));
  return { end, said };
}

describe('createWorktree (T1305)', () => {
  it('adds the worktree on a new branch from the fetched default branch and runs the setup in it, naming the main checkout', async () => {
    const ports = world();
    ports.hooks.answer(SETUP, { lines: ['linked node_modules'] });
    const { end, said } = await add(ports);
    assert.deepEqual(end, { kind: 'added', path: PATH });
    assert.deepEqual(ports.git.steps, ['fetch origin main in /w/main', `worktree add -b t9/parser ${PATH} origin/main in /w/main`]);
    assert.deepEqual(said, [
      `added the worktree ${PATH} on the new branch t9/parser, from origin/main as just fetched`,
      'linked node_modules',
      'ran its setup node tools/link-modules.ts',
    ]);
    const [run] = ports.hooks.ran;
    assert.equal(run?.cwd, PATH);
    assert.deepEqual(run?.env, { PATH: '/bin', [MAIN_CHECKOUT_ENV]: '/w/main' });
  });

  it('runs nothing after the add when the repository has no setup', async () => {
    const ports = world();
    const { end, said } = await add(ports, { setup: undefined });
    assert.deepEqual(end, { kind: 'added', path: PATH });
    assert.equal(said.length, 1);
    assert.deepEqual(ports.hooks.ran, []);
  });

  it('refuses before any change: a folder already there, no default branch, a branch that exists or one git cannot tell', async () => {
    const cases: readonly [string, ReturnType<typeof world>, RegExp][] = [
      ['folder', { ...world(), files: new FakeWorktreeFiles({ [PATH]: { kind: 'folder' } }) }, /t9-parser is already there: give another branch name/],
      ['no origin/HEAD', world({ defaultBase: undefined }), /origin\/HEAD in \/w\/main names no default branch to start from: run git remote set-head origin --auto there/],
      ['no branch part', world({ defaultBase: 'origin' }), /names no default branch/],
      ['branch exists', world({ branches: ['main', 't9/parser'] }), /^branch t9\/parser already exists in \/w\/main: give a new branch name$/],
      ['cannot tell', world({ branches: undefined }), /^git could not tell whether branch t9\/parser exists in \/w\/main$/],
    ];
    for (const [label, ports, reason] of cases) {
      const { end } = await add(ports);
      assert.equal(end.kind, 'refused', label);
      assert.match(end.kind === 'refused' ? end.reason : '', reason, label);
      assert.deepEqual(ports.git.steps, [], label);
      assert.deepEqual(ports.hooks.ran, [], label);
    }
  });

  it('refuses a name that is no branch name, which would also name its folder', async () => {
    for (const branch of ['', '-x', '.x', 'a..b', 'a//b', 'a/.b', 'a/', 'a.', 'a.lock', 'a b', 'a\\b', 'a:b', '../x']) {
      const ports = world();
      const { end } = await add(ports, { branch });
      assert.equal(end.kind, 'refused', branch);
      assert.match(end.kind === 'refused' ? end.reason : '', /expected a branch name/, branch);
      assert.deepEqual(ports.git.steps, [], branch);
    }
    for (const branch of ['t12-parser', 'feature/T12.x_y', 'a.b/c-d']) {
      assert.equal(branchNameProblem(branch), undefined, branch);
    }
  });

  it("fails a fetch with nothing made, and a git worktree add with git's reason", async () => {
    const offline = world({ fetching: { ok: false, reason: 'fatal: unable to access origin' } });
    assert.deepEqual((await add(offline)).end, { kind: 'failed', reason: 'git fetch origin main in /w/main: fatal: unable to access origin; nothing was made' });
    assert.deepEqual(offline.git.steps, ['fetch origin main in /w/main']);
    const taken = world({ adding: { ok: false, reason: "fatal: 't9/parser' is not a valid branch name" } });
    assert.deepEqual((await add(taken)).end, { kind: 'failed', reason: "git worktree add in /w/main: fatal: 't9/parser' is not a valid branch name" });
    assert.deepEqual(taken.hooks.ran, []);
  });

  it('fails a setup that does not exit 0 or cannot start, leaving the worktree in place', async () => {
    const failing = world();
    failing.hooks.answer(SETUP, { end: 3 });
    assert.deepEqual((await add(failing)).end, {
      kind: 'failed',
      reason: `its setup node tools/link-modules.ts exited 3; the worktree stays at ${PATH}: finish its setup by hand, or teamrig worktree remove ${PATH} --delete-branch`,
    });
    const missing = world();
    missing.hooks.answer(SETUP, { end: { kind: 'notStarted', error: 'ENOENT' } });
    const { end } = await add(missing);
    assert.match(end.kind === 'failed' ? end.reason : '', /^its setup node tools\/link-modules.ts could not start \(ENOENT\); the worktree stays at /);
  });
});
