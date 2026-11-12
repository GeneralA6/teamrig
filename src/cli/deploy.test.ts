import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { FakeStarterWatch } from '../testing/fake-starter-watch.ts';
import { heldBy, otherRuns } from '../testing/held-lock.ts';
import { EXIT } from './runtime.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const COMMAND = ['node', 'tools/deploy.js'];
const DEPLOYING = { ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploy: { targets: ['api'], command: COMMAND } } } } };
const DEPLOY = ['deploy', '--session', 'alpha'];
/** A run outside the project folder and any checkout: its team comes from $TEAMRIG_TEAM. */
const ELSEWHERE = { cwd: '/elsewhere', env: { TEAMRIG_TEAM: 'app' } };
const BY_HAND = `a new deploy finds nothing pending, so run \`node tools/deploy.js\` in ${MAIN_CHECKOUT} by hand once it is fixed`;

interface World {
  readonly kit: CliHarness;
  readonly git: FakeMergeGit;
  readonly hooks: FakeHooks;
}

/** A team whose main checkout is two commits behind origin. */
function world(): World {
  const kit = new CliHarness(DEPLOYING);
  const git = new FakeMergeGit();
  git.origin.set('main', 'c2');
  git.ancestry.add('base>c2');
  git.landed = ['c1', 'c2'];
  return { kit, git, hooks: new FakeHooks(kit.clock) };
}

function ledgerOf(kit: CliHarness): unknown[] {
  return (kit.files.get(LEDGER) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('teamrig deploy', () => {
  it('pulls and deploys what was pushed, records the deploy and prints DONE', async () => {
    const { kit, git, hooks } = world();
    hooks.answer(COMMAND, { lines: ['deployed api on c2'], takesMs: 60_000 });
    assert.deepEqual(await kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: git, hooks }), {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC 2 commits pending in app (c1..c2)',
        `2030-01-08 10:00:02 UTC clear; pulling 2 commits (c1..c2) into ${MAIN_CHECKOUT}`,
        `2030-01-08 10:00:02 UTC pulled ${MAIN_CHECKOUT} to c2`,
        '2030-01-08 10:00:02 UTC deploy: node tools/deploy.js',
        '2030-01-08 10:00:02 UTC   deployed api on c2',
        'DONE c1..c2 deployed: deployed api on c2',
      ],
      stderr: [],
    });
    assert.deepEqual([hooks.ran[0]?.env['TEAMRIG_TEAM'], hooks.ran[0]?.env['TEAMRIG_SESSION']], ['app', 'alpha']);
    assert.deepEqual(ledgerOf(kit).at(-1), {
      type: 'deploy',
      kind: 'deploy',
      session: 'alpha',
      repo: 'app',
      range: 'c1..c2',
      what: 'deploy api',
      note: '2 commits; deployed api on c2',
      startedAt: '2030-01-08T10:00:02.000Z',
      rolledAt: '2030-01-08T10:01:02.000Z',
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the host lock is released');
  });

  it('is DONE with nothing run when nothing is pending', async () => {
    const { kit, git, hooks } = world();
    git.origin.set('main', 'base');
    assert.deepEqual(await kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: git, hooks }), {
      code: 0,
      stdout: ["DONE nothing to deploy: the app main checkout is at its origin's default branch (base)"],
      stderr: [],
    });
    assert.deepEqual([hooks.ran.length, ledgerOf(kit).length], [0, 0]);
  });

  it('waits out a deploy freeze another session made with teamrig freeze', async () => {
    const { kit, git, hooks } = world();
    const freeze = ['freeze', '--session', 'bravo', '--targets', 'api', '--metric', 'p95', '--why', 'cache probe', '--for', '5m'];
    assert.deepEqual(await kit.run(freeze, ELSEWHERE), { code: 0, stdout: ['FROZEN api until 2030-01-08 10:05 UTC'], stderr: [] });
    const result = await kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: git, hooks });
    assert.equal(result.code, 0, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('2030-01-08 10:00:00 UTC waiting: deploy freeze by bravo on api until 2030-01-08 10:05 UTC (p95)'));
    assert.ok(kit.clock.now() >= Date.parse('2030-01-08T10:05:00Z'), 'it deployed once the freeze ended');
  });

  it('prints REFUSED for a repository it cannot deploy and FAILED when the deploy command fails', async () => {
    const refused = world();
    assert.deepEqual(await refused.kit.run([...DEPLOY, '--repo', 'site'], { ...ELSEWHERE, mergeGit: refused.git, hooks: refused.hooks }), {
      code: 2,
      stdout: ['REFUSED site is not in delivery.repos (with a deploy block: app)'],
      stderr: [],
    });
    const failing = world();
    failing.hooks.answer(COMMAND, { lines: ['kubectl: connection refused'], end: 1 });
    const result = await failing.kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: failing.git, hooks: failing.hooks });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), `FAILED c1..c2 pulled, but the deploy command exited 1: kubectl: connection refused; its owners fix forward or roll back, and ${BY_HAND}`);
  });

  it('kills the deploy command once the shell that started it ended, records exit 129 and frees the lock', async () => {
    const { kit, git, hooks } = world();
    const starters = new FakeStarterWatch();
    hooks.answer(COMMAND, { takesMs: 60_000, during: async () => starters.end() });
    const result = await kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: git, hooks, starters });
    assert.equal(result.code, 1);
    assert.match(result.stdout.at(-1) ?? '', /^FAILED c1..c2 pulled, but the deploy command was killed when its launching shell ended/);
    assert.ok(JSON.stringify(ledgerOf(kit)).includes('"exitCode":129'), 'the deploy step is recorded as exit 129');
    assert.deepEqual([kit.files.get(LOCK), starters.openWatches], [undefined, 0]);
  });

  it('deploys the targets --targets names with the command after --, pulling nothing, and records a deploy of them', async () => {
    const { kit, git, hooks } = world();
    const restart = ['node', 'tools/restart.js', 'api'];
    hooks.answer(restart, { lines: ['restarted api'], takesMs: 30_000 });
    const deploy = [...DEPLOY, '--targets', 'api', '--what', 'rotate the db credential', '--', ...restart];
    assert.deepEqual(await kit.run(deploy, { ...ELSEWHERE, mergeGit: git, hooks }), {
      code: 0,
      stdout: ['2030-01-08 10:00:02 UTC clear; deploying api of app: node tools/restart.js api', '2030-01-08 10:00:02 UTC   restarted api', 'DONE deployed api of app: restarted api'],
      stderr: [],
    });
    assert.deepEqual([hooks.commands, hooks.ran[0]?.cwd, hooks.ran[0]?.env['TEAMRIG_VERB'], git.heads.get(MAIN_CHECKOUT)], [[restart.join(' ')], '/elsewhere', 'redeploy', 'base']);
    assert.deepEqual(ledgerOf(kit).at(-1), {
      type: 'deploy',
      kind: 'deploy',
      session: 'alpha',
      repo: 'app',
      range: 'at base',
      what: 'deploy api',
      note: 'rotate the db credential; restarted api',
      startedAt: '2030-01-08T10:00:02.000Z',
      rolledAt: '2030-01-08T10:00:32.000Z',
      targets: ['api'],
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the host lock is released');
  });

  it('refuses teamrig roll, its old name, with the new one and exit 64, pulling and running nothing', async () => {
    const { kit, git, hooks } = world();
    const result = await kit.run(['roll', '--session', 'alpha'], { ...ELSEWHERE, mergeGit: git, hooks });
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'roll was renamed: use deploy']);
    assert.deepEqual([hooks.ran.length, ledgerOf(kit).length, git.log, git.heads.get(MAIN_CHECKOUT)], [0, 0, [], 'base']);
  });

  it('reads a deploy only with --targets, --what and a command after --, each missing one a usage error', async () => {
    const { kit, git, hooks } = world();
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--targets', 'api', '--what', 'rotate'], 'no command to run after --'],
      [['--targets', 'api', '--', 'node', 'tools/restart.js'], '--what is required'],
      [['--', 'node', 'tools/restart.js'], '--what and a command after -- make a deploy: name the targets it restarts with --targets <a,b>'],
      [['--what', 'rotate'], '--what and a command after -- make a deploy: name the targets it restarts with --targets <a,b>'],
    ];
    for (const [extra, message] of cases) {
      const result = await kit.run([...DEPLOY, ...extra], { ...ELSEWHERE, mergeGit: git, hooks });
      assert.equal(result.code, 64, extra.join(' '));
      assert.equal(result.stderr[0]?.split('\n')[0], message, extra.join(' '));
    }
    assert.deepEqual([hooks.ran.length, ledgerOf(kit).length], [0, 0]);
  });

  it('stops waiting for the host lock once the shell that started it ended, deploying nothing and leaving the lock to its holder', async () => {
    const { kit, git, hooks } = world();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch();
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end();
    };
    const result = await kit.run(DEPLOY, { ...ELSEWHERE, mergeGit: git, hooks, starters, sleep, sessionProcesses: otherRuns() });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), "STOPPED before the host lock was free: nothing ran; re-run the same command in the background with no human's OK, unless you or the human stopped it on purpose");
    assert.equal(result.stdout.at(-2), '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: no one waits for it any more');
    assert.deepEqual([hooks.ran, kit.files.get(LOCK), starters.openWatches], [[], heldBy(), 0]);
  });

  it('refuses at once under a live queued step, which it would wait on while the step waits for it, deploying nothing', async () => {
    const { kit, git, hooks } = world();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch();
    const env = { ...ELSEWHERE.env, TEAMRIG_HOST_LOCK: 'other' };
    const result = await kit.run(DEPLOY, { ...ELSEWHERE, env, mergeGit: git, hooks, starters, sessionProcesses: otherRuns() });
    const refusal = result.stdout.at(-1) ?? '';
    assert.equal(result.code, 2);
    assert.ok(refusal.startsWith('REFUSED teamrig deploy takes the whole host lock itself, so under the queued step of '), refusal);
    assert.ok(refusal.endsWith('run teamrig deploy without teamrig queue, as it waits in the host lock\'s line on its own'), refusal);
    assert.deepEqual([hooks.ran, kit.files.get(LOCK), ledgerOf(kit), starters.openWatches], [[], heldBy(), [], 0]);
  });
});
