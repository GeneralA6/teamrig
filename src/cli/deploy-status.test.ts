import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KIT_VERSION } from '../core/version.ts';
import { CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { EXIT } from './runtime.ts';

const LOCK = join(KIT, 'host.lock');
const CLAIMS = join(TEAM_HOME, 'state', 'deploys', 'claims.json');
const OTHER = 9001;
const DEPLOY = { targets: ['cloud-api'], command: ['node', 'tools/deploy.js'] };
/** app deploys by command, web on push; the reset is Tuesday 12:00 UTC, so at the clock's 10:00 the 4 h blackout holds. */
const DEPLOYING = {
  ...TEAM,
  budget: { reset: { weekday: 'tue', timeUtc: '12:00' } },
  delivery: {
    schedule: { resetBlackoutHours: 4, queueCutoffUtc: '22:30' },
    repos: { app: { mainCheckout: MAIN_CHECKOUT, deploy: DEPLOY }, web: { mainCheckout: '/repo/web', deploysOnPush: ['cloud-web'] } },
  },
};
const PLAIN = { ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploy: DEPLOY } } } };

/** A lock po's build took at 09:50, lasting to `expiresAt`. */
function heldBy(expiresAt: string = '2030-01-08T12:20:00.000Z'): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt });
}

function otherRuns(): FakeSessionProcesses {
  return new FakeSessionProcesses().add({ pid: OTHER, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });
}

/** A main checkout two commits behind origin. */
function behind(): FakeMergeGit {
  const git = new FakeMergeGit();
  git.origin.set('main', 'c2');
  git.ancestry.add('base>c2');
  git.landed = ['c1', 'c2'];
  return git;
}

describe('teamrig deploy-status', () => {
  it('shows the lock holder, the cutoff and blackout, the open freezes and loads, and what each repository with a deploy block has pushed', async () => {
    const kit = new CliHarness(DEPLOYING);
    await kit.files.append(LOCK, heldBy());
    const claim = ['freeze', '--session', 'bravo', '--targets', 'cloud-api', '--metric', 'p95', '--why', 'cache probe', '--for', '30m'];
    assert.equal((await kit.run(claim)).code, 0);
    assert.equal((await kit.run(['load', '--session', 'alpha', '--what', 'trim', '--at', '08:00'])).code, 0);
    const ended = (await kit.run(['load', '--session', 'alpha', '--what', 'backfill', '--at', '08:30'])).stdout.join('');
    assert.equal((await kit.run(['load', 'end', '--session', 'alpha', '--id', /LOAD (\S+)/.exec(ended)?.[1] ?? '', '--at', '09:00'])).code, 0);
    const open = /LOAD (\S+)/.exec((await kit.run(['load', '--session', 'bravo', '--what', 'reindex', '--targets', 'cloud-api,cloud-web'])).stdout.join(''))?.[1];
    const result = await kit.run(['deploy-status'], { mergeGit: behind(), sessionProcesses: otherRuns() });
    assert.equal(result.code, 0, JSON.stringify(result));
    const trim = /^ {2}(\S+) by alpha: trim/m.exec(result.stdout.join('\n'))?.[1];
    assert.deepEqual(result.stdout, [
      'host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
      'heavy cutoff: 22:30-00:00 UTC (no heavy step starts)',
      'deploy blackout: IN FORCE Tue 01-08 08:00 UTC until Tue 01-08 12:00 UTC (no merge or deploy; reset from the budget.reset config)',
      'claims: 1',
      '  quiet claim by bravo on cloud-api until 2030-01-08 10:30 UTC (p95)',
      'loads: 2',
      `  ${trim} by alpha: trim on the whole host since 2030-01-08 08:00 UTC`,
      `  ${open} by bravo: reindex on cloud-api,cloud-web since 2030-01-08 10:00 UTC`,
      'app: 2 commits pushed, not deployed (c1..c2)',
    ]);
  });

  it("shows the times on the team's clock", async () => {
    const kit = new CliHarness(DEPLOYING);
    const inIsrael = { timeZone: 'Asia/Jerusalem' };
    await kit.files.append(LOCK, heldBy());
    const claim = ['freeze', '--session', 'bravo', '--targets', 'cloud-api', '--metric', 'p95', '--why', 'cache probe', '--for', '30m'];
    assert.deepEqual((await kit.run(claim, inIsrael)).stdout, ['FROZEN cloud-api until 2030-01-08 12:30 IST']);
    assert.equal((await kit.run(['load', '--session', 'alpha', '--what', 'trim', '--at', '11:00'], inIsrael)).code, 0);
    const result = await kit.run(['deploy-status'], { mergeGit: behind(), sessionProcesses: otherRuns(), ...inIsrael });
    assert.deepEqual(result.stdout.slice(0, 6), [
      'host lock: po (heavy: build) since 2030-01-08 11:50 IST',
      'heavy cutoff: 00:30-02:00 IST (no heavy step starts)',
      'deploy blackout: IN FORCE Tue 01-08 10:00 IST until Tue 01-08 14:00 IST (no merge or deploy; reset from the budget.reset config)',
      'claims: 1',
      '  quiet claim by bravo on cloud-api until 2030-01-08 12:30 IST (p95)',
      'loads: 1',
    ]);
    assert.match(result.stdout[6] ?? '', / by alpha: trim on the whole host since 2030-01-08 11:00 IST$/);
  });

  it('shows a stale lock as free, an unset cutoff and blackout, no freezes or loads, and nothing to deploy', async () => {
    const kit = new CliHarness(PLAIN);
    await kit.files.append(LOCK, heldBy('2030-01-08T09:55:00.000Z'));
    await kit.files.append(CLAIMS, JSON.stringify([{ session: 'bravo', targets: ['cloud-api'], metric: 'p95', why: 'probe', from: '2030-01-08T09:00:00.000Z', until: '2030-01-08T09:30:00.000Z' }]));
    assert.deepEqual(await kit.run(['deploy-status'], { mergeGit: new FakeMergeGit(), sessionProcesses: otherRuns() }), {
      code: 0,
      stdout: [
        'host lock: free: the lock of po (heavy: build) since 2030-01-08 09:50 UTC is stale, and the next heavy step removes it',
        'heavy cutoff: none (delivery.schedule.queueCutoffUtc is not set)',
        'deploy blackout: none (delivery.schedule.resetBlackoutHours is not set)',
        'claims: none',
        'loads: none',
        'app: nothing to deploy: the main checkout is at origin (base)',
      ],
      stderr: [],
    });
  });

  it('names the small steps sharing the host, a stale share left out', async () => {
    const kit = new CliHarness(PLAIN);
    const share = { token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 };
    await kit.files.append(`${LOCK}.shared/other.json`, JSON.stringify(share));
    await kit.files.append(`${LOCK}.shared/gone.json`, JSON.stringify({ ...share, token: 'gone', pid: 7 }));
    const { stdout } = await kit.run(['deploy-status'], { mergeGit: new FakeMergeGit(), sessionProcesses: otherRuns() });
    assert.deepEqual(stdout.slice(0, 2), ['host lock: free', 'sharing the host: 1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC']);
  });

  it('says what it cannot tell: a lock being written, an unknown reset, unreadable freezes, a refused or failed read and no deploy block', async () => {
    const kit = new CliHarness({ ...PLAIN, delivery: { ...PLAIN.delivery, schedule: { resetBlackoutHours: 4, queueCutoffUtc: '09:30' } } });
    await kit.files.append(LOCK, '{"tok');
    await kit.files.append(CLAIMS, 'not json');
    const offBranch = new FakeMergeGit();
    offBranch.checkouts.set(MAIN_CHECKOUT, { top: MAIN_CHECKOUT, branch: 'fix', mainCheckout: MAIN_CHECKOUT, linked: false });
    const { stdout } = await kit.run(['deploy-status'], { mergeGit: offBranch });
    assert.deepEqual(stdout.slice(0, 3), [
      'host lock: a writer that has not finished writing',
      'heavy cutoff: IN FORCE 09:30-00:00 UTC (no heavy step starts)',
      'deploy blackout: unknown: neither the status line nor budget.reset names the weekly token reset',
    ]);
    assert.match(stdout[3] ?? '', /^claims: unreadable \(.+\)$/);
    assert.equal(stdout.at(-1), `app: a deploy would refuse: the app main checkout ${MAIN_CHECKOUT} is on fix, not main`);
    const offline = new FakeMergeGit();
    offline.fetchFails = 'no network';
    assert.equal((await kit.run(['deploy-status'], { mergeGit: offline })).stdout.at(-1), `app: cannot read what is pending: git fetch failed in ${MAIN_CHECKOUT}: no network`);
    const pushOnly = new CliHarness({ ...TEAM, delivery: { repos: { web: { mainCheckout: '/repo/web', deploysOnPush: ['cloud-web'] } } } });
    assert.equal((await pushOnly.run(['deploy-status'])).stdout.at(-1), 'deploys: no repository in delivery.repos has a deploy block');
  });

  it('refuses teamrig deploys, its old name, with the new one and exit 64, reading nothing', async () => {
    const kit = new CliHarness(DEPLOYING);
    const git = behind();
    const result = await kit.run(['deploys'], { mergeGit: git });
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0], git.log], [EXIT.usage, [], 'deploys was renamed: use deploy-status', []]);
  });
});
