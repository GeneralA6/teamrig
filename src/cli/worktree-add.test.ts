import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
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

describe('runCli: worktree add --task names the branch by delivery.branches (T2690)', () => {
  /** Team app with T1, alpha's task "Parse the input (T0)", and T2, a bug filed as Maintenance with issue #933. */
  async function teamWorld(config: JsonRecord = LISTED): Promise<CliHarness> {
    const kit = new CliHarness(config);
    for (const fields of [
      ['--title', 'Parse the input (T0)'],
      ['--title', 'Login loop', '--type', 'bug', '--class', 'Maintenance', '--ref', 'gh:acme/app#933'],
    ]) {
      const added = await kit.run(['add', '--session', 'lead', '--owner', 'alpha', '--description', 'Do it.', '--priority', 'p1', ...fields]);
      assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    }
    return kit;
  }

  it("makes a task's branch feat/<id>-<slug> and a bug's fix/..., the folder named after it", async () => {
    const kit = await teamWorld();
    const { git, ports } = world();
    const hooks = new FakeHooks().answer(SETUP, { lines: [] });
    const feat = await kit.run(['worktree', 'add', '--task', 'T1'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(feat.code, EXIT.ok, feat.stdout.join('\n'));
    const fix = await kit.run(['worktree', 'add', '--task', 'T2'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(fix.code, EXIT.ok, fix.stdout.join('\n'));
    assert.deepEqual(
      git.steps.filter((step) => step.startsWith('worktree add')),
      [`worktree add -b feat/t1-parse-the-input ${resolve('/w/wt', 'feat-t1-parse-the-input')} origin/main in ${MAIN}`, `worktree add -b fix/t2-login-loop ${resolve('/w/wt', 'fix-t2-login-loop')} origin/main in ${MAIN}`],
    );
  });

  it("takes --type, the work class's branch type and the team's own pattern", async () => {
    const branches = { pattern: '{session}/{type}/{id}-gh{issue}', classes: { Maintenance: 'chore' } };
    const kit = await teamWorld({ ...LISTED, delivery: { ...LISTED.delivery, branches } });
    const { git, ports } = world();
    const hooks = new FakeHooks().answer(SETUP, { lines: [] });
    const chore = await kit.run(['worktree', 'add', '--task', 'T2'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(chore.code, EXIT.ok, chore.stdout.join('\n'));
    const docs = await kit.run(['worktree', 'add', '--task', 'T2', '--type', 'docs'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(docs.code, EXIT.ok, docs.stdout.join('\n'));
    assert.deepEqual(
      git.steps.filter((step) => step.startsWith('worktree add')).map((step) => step.split(' ')[3]),
      ['alpha/chore/t2-gh933', 'alpha/docs/t2-gh933'],
    );
    const noIssue = await kit.run(['worktree', 'add', '--task', 'T1'], { worktrees: ports, hooks, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(noIssue.code, EXIT.refused);
    assert.deepEqual(noIssue.stdout, ['REFUSED the branch pattern {session}/{type}/{id}-gh{issue} names {issue}, which this task has none of: give a branch name instead']);
  });

  it('refuses a task the register lacks, and --task outside a team, before any change', async () => {
    const { git, ports } = world();
    const missing = await (await teamWorld()).run(['worktree', 'add', '--task', 'T9'], { worktrees: ports, cwd: '/w/t4', env: IN_TEAM });
    assert.equal(missing.code, EXIT.refused);
    assert.deepEqual(missing.stdout, ["REFUSED team app's register has no T9"]);
    const outside = await new CliHarness(null, null).run(['worktree', 'add', '--task', 'T1'], { worktrees: ports, cwd: '/w/t4' });
    assert.equal(outside.code, EXIT.refused);
    assert.match(outside.stdout[0] ?? '', /^REFUSED --task names a task on a team's register, and .* is in no team: give a branch name instead$/);
    assert.deepEqual(git.steps, []);
  });

  it('takes a branch name or --task, not both, --type only with --task, and a branch type and task id as typed', async () => {
    const kit = await teamWorld();
    const { git, ports } = world();
    for (const argv of [
      ['worktree', 'add', 't9-x', '--task', 'T1'],
      ['worktree', 'add', 't9-x', '--type', 'fix'],
      ['worktree', 'add', '--task', 'T1', '--type', 'Fix/x'],
      ['worktree', 'add', '--task', 'twelve'],
    ]) {
      const result = await kit.run(argv, { worktrees: ports, cwd: '/w/t4', env: IN_TEAM });
      assert.equal(result.code, EXIT.usage, argv.join(' '));
    }
    assert.deepEqual(git.steps, []);
  });
});
