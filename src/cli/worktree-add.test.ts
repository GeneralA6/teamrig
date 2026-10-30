import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeWorktreeFiles, FakeWorktreeGit, type FakeGitAnswers } from '../testing/fake-worktrees.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import { EXIT } from './runtime.ts';

const SETUP = ['node', 'tools/link-modules.ts'];
const MAIN = resolve('/w/main');
/** A session's project folder, where its team's pointer is, as a session in the team runs with. */
const IN_TEAM = { CLAUDE_PROJECT_DIR: APP };
/** The team's app repository, its worktrees in /w/wt and linked to its modules by SETUP. */
const LISTED = { ...TEAM, delivery: { repos: { app: { mainCheckout: '/w/main', worktreeFolder: '../wt', worktreeSetup: SETUP }, web: { mainCheckout: '/w/web' } } } };

/** A repository whose main checkout is /w/main, run from its worktree /w/t4, with origin/HEAD naming origin/main. */
function world(answers: FakeGitAnswers = {}): { git: FakeWorktreeGit; ports: WorktreePorts } {
  const git = new FakeWorktreeGit({
    worktrees: [
      { path: '/w/main', branch: 'main', locked: undefined },
      { path: '/w/t4', branch: 't4', locked: undefined },
    ],
    defaultBase: 'origin/main',
    branches: ['main', 't4'],
    ...answers,
  });
  return { git, ports: { git, files: new FakeWorktreeFiles() } };
}

describe('runCli: worktree add (T1305)', () => {
  it('adds the worktree in the main checkout’s .claude/worktrees and runs no setup, with no team set up', async () => {
    const { git, ports } = world();
    const path = join(MAIN, '.claude', 'worktrees', 't9-parser');
    const result = await new CliHarness(null, null).run(['worktree', 'add', 't9/parser'], { worktrees: ports, cwd: '/w/t4' });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(result.stdout, [`added the worktree ${path} on the new branch t9/parser, from origin/main as just fetched`, `OK added ${path}`]);
    assert.deepEqual(git.steps, [`fetch origin main in ${MAIN}`, `worktree add -b t9/parser ${path} origin/main in ${MAIN}`]);
  });

  it('takes the folder and setup of the repository delivery.repos lists by its main checkout', async () => {
    const { git, ports } = world();
    const hooks = new FakeHooks().answer(SETUP, { lines: ['linked node_modules'] });
    const path = resolve('/w/wt', 't9-parser');
    const result = await new CliHarness(LISTED).run(['worktree', 'add', 't9-parser'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(result.stdout.slice(1), ['linked node_modules', 'ran its setup node tools/link-modules.ts', `OK added ${path}`]);
    assert.deepEqual(git.steps.slice(1), [`worktree add -b t9-parser ${path} origin/main in ${MAIN}`]);
    assert.equal(hooks.ran[0]?.cwd, path);
    assert.equal(hooks.ran[0]?.env['TEAMRIG_MAIN_CHECKOUT'], MAIN);
  });

  it('adds to the repository --repo names from any folder, and refuses one the team does not list', async () => {
    const { git, ports } = world({ worktrees: undefined });
    const kit = new CliHarness(LISTED);
    const web = await kit.run(['worktree', 'add', 't9-page', '--repo', 'web'], { worktrees: ports, cwd: '/elsewhere', env: IN_TEAM });
    assert.equal(web.code, EXIT.ok, web.stdout.join('\n'));
    assert.deepEqual(git.steps.slice(1), [`worktree add -b t9-page ${join(resolve('/w/web'), '.claude', 'worktrees', 't9-page')} origin/main in ${resolve('/w/web')}`]);
    const unknown = await kit.run(['worktree', 'add', 't9-page', '--repo', 'docs'], { worktrees: ports, cwd: '/elsewhere', env: IN_TEAM });
    assert.equal(unknown.code, EXIT.refused);
    assert.deepEqual(unknown.stdout, ['REFUSED team app has no delivery.repos.docs: it lists app, web']);
  });

  it('refuses --repo outside a team, and a folder in no repository without it', async () => {
    const { git, ports } = world({ worktrees: undefined });
    const outside = await new CliHarness(null, null).run(['worktree', 'add', 't9-page', '--repo', 'web'], { worktrees: ports, cwd: '/elsewhere' });
    assert.equal(outside.code, EXIT.refused);
    assert.match(outside.stdout[0] ?? '', /^REFUSED --repo names a repository in a team's delivery.repos, and .* is in no team: run it in the repository instead$/);
    const loose = await new CliHarness(LISTED).run(['worktree', 'add', 't9-page'], { worktrees: ports, cwd: '/elsewhere', env: IN_TEAM });
    assert.equal(loose.code, EXIT.refused);
    assert.match(loose.stdout[0] ?? '', /^REFUSED .* is in no git repository: run it in one, or give --repo <name>$/);
    assert.deepEqual(git.steps, []);
  });

  it('refuses a branch that exists before any change, and fails a setup that fails, keeping the worktree', async () => {
    const taken = world({ branches: ['main', 't9-parser'] });
    const refused = await new CliHarness(LISTED).run(['worktree', 'add', 't9-parser'], { worktrees: taken.ports, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, [`REFUSED branch t9-parser already exists in ${MAIN}: give a new branch name`]);
    assert.deepEqual(taken.git.steps, []);
    const { ports } = world();
    const hooks = new FakeHooks().answer(SETUP, { end: 2 });
    const failed = await new CliHarness(LISTED).run(['worktree', 'add', 't9-parser'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(failed.code, EXIT.failed);
    assert.match(failed.stdout.at(-1) ?? '', /^FAILED its setup node tools\/link-modules.ts exited 2; the worktree stays at .*t9-parser: finish its setup by hand/);
  });
});
