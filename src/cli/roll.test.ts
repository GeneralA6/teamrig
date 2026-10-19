import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeIntegrateGit, MAIN_CHECKOUT } from '../testing/fake-integrate-git.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const COMMAND = ['node', 'tools/roll.js'];
const ROLLING = { ...TEAM, coordinator: { repos: { app: { mainCheckout: MAIN_CHECKOUT, roll: { targets: ['api'], command: COMMAND } } } } };
const ROLL = ['roll', '--session', 'alpha'];
/** A run outside the project folder and any checkout: its team comes from $TEAMRIG_TEAM. */
const ELSEWHERE = { cwd: '/elsewhere', env: { TEAMRIG_TEAM: 'app' } };
const BY_HAND = `a new roll finds nothing pending, so run \`node tools/roll.js\` in ${MAIN_CHECKOUT} by hand once it is fixed`;

interface World {
  readonly kit: CliHarness;
  readonly git: FakeIntegrateGit;
  readonly hooks: FakeHooks;
}

/** A team whose main checkout is two commits behind origin. */
function world(): World {
  const kit = new CliHarness(ROLLING);
  const git = new FakeIntegrateGit();
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

describe('teamrig roll', () => {
  it('pulls and rolls what was pushed, records the deploy and prints DONE', async () => {
    const { kit, git, hooks } = world();
    hooks.answer(COMMAND, { lines: ['rolled api on c2'], takesMs: 60_000 });
    assert.deepEqual(await kit.run(ROLL, { ...ELSEWHERE, integrateGit: git, hooks }), {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC 2 commits pending in app (c1..c2)',
        `2030-01-08 10:00:00 UTC clear; pulling 2 commits (c1..c2) into ${MAIN_CHECKOUT}`,
        `2030-01-08 10:00:00 UTC pulled ${MAIN_CHECKOUT} to c2`,
        '2030-01-08 10:00:00 UTC roll: node tools/roll.js',
        '2030-01-08 10:00:00 UTC   rolled api on c2',
        'DONE c1..c2 rolled: rolled api on c2',
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
      what: 'roll api',
      note: '2 commits; rolled api on c2',
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T10:01:00.000Z',
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the host lock is released');
  });

  it('is DONE with nothing run when nothing is pending', async () => {
    const { kit, git, hooks } = world();
    git.origin.set('main', 'base');
    assert.deepEqual(await kit.run(ROLL, { ...ELSEWHERE, integrateGit: git, hooks }), {
      code: 0,
      stdout: ["DONE nothing to roll: the app main checkout is at its origin's default branch (base)"],
      stderr: [],
    });
    assert.deepEqual([hooks.ran.length, ledgerOf(kit).length], [0, 0]);
  });

  it('waits out a quiet claim another session made with teamrig claim', async () => {
    const { kit, git, hooks } = world();
    const claim = ['claim', '--session', 'bravo', '--targets', 'api', '--metric', 'p95', '--why', 'cache probe', '--for', '5m'];
    assert.deepEqual(await kit.run(claim, ELSEWHERE), { code: 0, stdout: ['CLAIMED api until 2030-01-08 10:05 UTC'], stderr: [] });
    const result = await kit.run(ROLL, { ...ELSEWHERE, integrateGit: git, hooks });
    assert.equal(result.code, 0, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('2030-01-08 10:00:00 UTC waiting: quiet claim by bravo on api until 2030-01-08 10:05 UTC (p95)'));
    assert.ok(kit.clock.now() >= Date.parse('2030-01-08T10:05:00Z'), 'it rolled once the claim ended');
  });

  it('prints REFUSED for a repository it cannot roll and FAILED when the roll command fails', async () => {
    const refused = world();
    assert.deepEqual(await refused.kit.run([...ROLL, '--repo', 'site'], { ...ELSEWHERE, integrateGit: refused.git, hooks: refused.hooks }), {
      code: 2,
      stdout: ['REFUSED site is not in coordinator.repos (with a roll block: app)'],
      stderr: [],
    });
    const failing = world();
    failing.hooks.answer(COMMAND, { lines: ['kubectl: connection refused'], end: 1 });
    const result = await failing.kit.run(ROLL, { ...ELSEWHERE, integrateGit: failing.git, hooks: failing.hooks });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), `FAILED c1..c2 pulled, but the roll command exited 1: kubectl: connection refused; its owners fix forward or roll back, and ${BY_HAND}`);
  });
});
