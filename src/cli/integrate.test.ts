import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatSnapshot } from '../budget/snapshot.ts';
import { KIT_VERSION } from '../core/version.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeIntegrateGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-integrate-git.ts';
import { FakeStarterWatch } from '../testing/fake-starter-watch.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { heldBy, otherRuns } from '../testing/held-lock.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const MINUTE = 60_000;
const SESSION_ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const DEPLOYING = { ...TEAM, coordinator: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-api'] } } } };
const INTEGRATE = ['integrate', '--session', 'alpha'];
/** A run in the worktree, outside the project folder: its team comes from $TEAMRIG_TEAM. */
const IN_WORKTREE = { cwd: WORKTREE, env: { TEAMRIG_TEAM: 'app' } };

interface World {
  readonly kit: CliHarness;
  readonly git: FakeIntegrateGit;
  readonly steps: FakeSteps;
}

/** A team whose push takes 2 minutes and lands, as git push does when origin takes it. */
function world(config: Readonly<Record<string, unknown>> = DEPLOYING): World {
  const kit = new CliHarness(config);
  const git = new FakeIntegrateGit();
  const steps = new FakeSteps(kit.clock).ends(0, 2 * MINUTE).whileRunning(async (request) => {
    git.pushed('main', git.heads.get(request.cwd) ?? '');
  });
  return { kit, git, steps };
}

function ledgerOf(kit: CliHarness): unknown[] {
  return (kit.files.get(LEDGER) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('teamrig integrate', () => {
  it('lands the branch of the current folder, records the push and the deploy it starts, and prints DONE', async () => {
    const { kit, git, steps } = world();
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps });
    assert.deepEqual(result, {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC pushing feat (rebased) to main; the pre-push hook runs now',
        '2030-01-08 10:02:00 UTC deleted feat on origin',
        '2030-01-08 10:02:00 UTC deleted the local feat',
        `2030-01-08 10:02:00 UTC next: teamrig worktree remove "${WORKTREE}"`,
        'DONE pushed rebased to main; cloud-api deploy on push',
      ],
      stderr: [],
    });
    assert.equal(steps.ran[0]?.cwd, WORKTREE);
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'integrate app: push feat to main', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [
      start,
      { ...start, endedAt: '2030-01-08T10:02:00.000Z', exitCode: 0 },
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'alpha',
        repo: 'app',
        range: 'rebased',
        what: 'integrate feat',
        note: 'pushed to main; cloud-api deploy on push, not watched by teamrig',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:02:00.000Z',
      },
    ]);
  });

  it('keeps the branch on origin and here with --keep-remote and --no-delete-local', async () => {
    const { kit, git, steps } = world();
    const result = await kit.run([...INTEGRATE, '--keep-remote', '--no-delete-local'], { ...IN_WORKTREE, integrateGit: git, steps });
    assert.equal(result.code, 0);
    assert.ok(!git.log.some((line) => line.startsWith('deleteRemoteBranch') || line.startsWith('detach')));
    assert.equal(result.stdout.at(-2), `2030-01-08 10:02:00 UTC next: teamrig worktree remove "${WORKTREE}" --delete-branch`);
  });

  it('prints FAILED and exits 1 when the push does not land', async () => {
    const { kit, git, steps } = world();
    steps.ends(1).whileRunning(async () => undefined);
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), "FAILED the push exited 1; origin's main is at base, not at rebased");
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
  });

  it('kills the push once the shell that started it ended, records exit 129, frees the lock and pushes no more', async () => {
    const { kit, git, steps } = world();
    const starters = new FakeStarterWatch();
    steps.whileRunning(async () => {
      git.pushed('main', 'moved');
      starters.end();
    });
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps, starters });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, "FAILED the push was killed when its launching shell ended (exit 129); origin's main is at moved, not at rebased"]);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'integrate app: push feat to main', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:00:00.000Z', exitCode: 129 }]);
    assert.deepEqual([steps.ran.length, kit.files.get(LOCK), starters.openWatches], [1, undefined, 0]);
  });

  it('stops waiting for the host lock once the shell that started it ended, pushing nothing and leaving the lock to its holder', async () => {
    const { kit, git, steps } = world();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch();
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end();
    };
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps, starters, sleep, sessionProcesses: otherRuns() });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), 'STOPPED before the host lock was free: nothing ran');
    assert.equal(result.stdout.at(-2), '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: no one waits for it any more');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER), starters.openWatches], [[], heldBy(), undefined, 0]);
  });

  it('prints WAITING with the merge command’s last line and exits 75 when the command waits, pushing nothing', async () => {
    const MERGE = ['node', 'merge.ts'];
    const { kit, git, steps } = world({ ...TEAM, coordinator: { repos: { app: { mainCheckout: MAIN_CHECKOUT, merge: { command: MERGE } } } } });
    const hooks = new FakeHooks(kit.clock).answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] });
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps, hooks });
    assert.equal(result.code, 75);
    assert.equal(result.stdout.at(-2), `2030-01-08 10:00:00 UTC next: run teamrig integrate again in ${WORKTREE} once feat is merged`);
    assert.equal(result.stdout.at(-1), 'WAITING https://forge/pr/7');
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
    assert.ok(kit.files.get(join(TEAM_HOME, 'state', 'deploys', 'pending-merges', 'app%2Ffeat.json'))?.includes('"note": "https://forge/pr/7"'));
  });

  it('refuses a folder outside git', async () => {
    const { kit, git, steps } = world();
    assert.deepEqual(await kit.run(INTEGRATE, { cwd: APP, integrateGit: git, steps }), { code: 2, stdout: [`REFUSED ${APP} is not in a git checkout`], stderr: [] });
  });

  it('refuses in the blackout before the reset the status line last reported', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, budget: { statusSnapshotDir: 'live' }, coordinator: { ...DEPLOYING.coordinator, schedule: { resetBlackoutHours: 4 } } });
    const snapshot = formatSnapshot({
      ts: '2030-01-08T09:55:00.000Z',
      sessionId: SESSION_ID,
      cwd: APP,
      agentName: null,
      model: null,
      rateLimits: { fiveHour: null, sevenDay: { usedPct: 90, resetsAt: Date.parse('2030-01-08T12:00:00Z') } },
      rateLimitsSince: null,
      rateLimitsAfter: null,
      costUsd: null,
      contextUsedPct: null,
      contextInputTokens: null,
    });
    await kit.files.write(join(TEAM_HOME, 'live', `${SESSION_ID}.json`), snapshot);
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps });
    assert.deepEqual(result.stdout, ['REFUSED deploy blackout before the weekly token reset: no deploy from Tue 01-08 08:00 UTC until Tue 01-08 12:00 UTC (reset from the status line)']);
    assert.deepEqual(steps.ran, []);
  });

  it('lands in a blackout window when neither the status line nor budget.reset names the reset', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, coordinator: { ...DEPLOYING.coordinator, schedule: { resetBlackoutHours: 24 } } });
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps });
    assert.equal(result.code, 0);
  });

  it('takes the reset from budget.reset when no status line reported one', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, budget: { reset: { weekday: 'tue', timeUtc: '11:00' } }, coordinator: { ...DEPLOYING.coordinator, schedule: { resetBlackoutHours: 2 } } });
    const result = await kit.run(INTEGRATE, { ...IN_WORKTREE, integrateGit: git, steps });
    assert.deepEqual(result.stdout, ['REFUSED deploy blackout before the weekly token reset: no deploy from Tue 01-08 09:00 UTC until Tue 01-08 11:00 UTC (reset from the budget.reset config)']);
  });
});
