import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveryConfig, DeliveryRepoConfig, DeployConfig, ScheduleConfig } from '../config/types.ts';
import { DEFAULT_FREEZES, DEFAULT_DELIVERY_WAIT, DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_QUEUE, DEFAULT_STABLE_PERIODS } from '../config/defaults.ts';
import { HostLock } from '../delivery/host-lock.ts';
import type { DeliveryPlaces } from '../delivery/places.ts';
import type { ResetTime } from '../delivery/schedule.ts';
import type { Env } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { redeployTargets, type RedeployRequest } from './deploy.ts';
import type { DeployEnd } from './run.ts';

const PLACES: DeliveryPlaces = {
  ledger: '/team/deploys/ledger.jsonl',
  ledgerMd: '/team/deploys/ledger.md',
  freezes: '/team/deploys/claims.json',
  freezesMd: '/team/deploys/claims.md',
  freezesLock: '/team/deploys/claims.lock',
  hostLock: '/kit/host.lock',
  pendingMerges: '/team/deploys/pending-merges',
  reviewHolds: '/team/deploys/review-holds',
  gateHolds: '/team/deploys/gate-holds',
  merges: '/team/deploys/merges.jsonl',
};
const FLOW = { name: 'flow', command: ['node', 'checks/flow.js'] };
const DEPLOY_COMMAND = ['node', 'tools/deploy.js'];
const DEPLOY: DeployConfig = { targets: ['api', 'workers', 'live'], checks: [FLOW], afterPull: [['node', 'scripts/build-cli.js']], command: DEPLOY_COMMAND };
const PIPELINE: DeliveryRepoConfig = { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false, deploy: DEPLOY };
const RESTART = ['node', 'tools/restart.js', 'api', 'live'];
const REQUEST: RedeployRequest = { session: 'sec', repo: 'pipeline', dir: '/runner', targets: ['api', 'live'], why: 'rotate the db credential', argv: RESTART };
const SECRET = ['db password', '=', 'hunter2'].join('');
const REDACTED = 'db [redacted password or key assignment]';

interface Options {
  readonly schedule?: ScheduleConfig;
  readonly freezes?: string;
  readonly reset?: ResetTime;
}

class World {
  readonly git = new FakeMergeGit();
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');
  readonly hooks = new FakeHooks(this.clock);
  readonly lock: HostLock;
  readonly said: string[] = [];
  /** The host's memory, which each queued step's watch reads. */
  readonly memory = new FakeHostMemory();
  private readonly delivery: DeliveryConfig;
  private readonly reset: ResetTime | undefined;

  constructor(options: Options = {}) {
    this.files = new MemoryFiles(options.freezes === undefined ? {} : { [PLACES.freezes]: options.freezes });
    this.lock = new HostLock(PLACES.hostLock, 150 * 60_000, { files: this.files, clock: this.clock, sleep: this.clock.sleep, pid: 7, alive: () => true, newId: () => 'lock-1' });
    this.reset = options.reset;
    this.delivery = {
      schedule: options.schedule ?? {},
      queue: DEFAULT_QUEUE,
      wait: DEFAULT_DELIVERY_WAIT,
      checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      freezes: DEFAULT_FREEZES,
      stablePeriods: DEFAULT_STABLE_PERIODS,
      repos: { pipeline: PIPELINE },
    };
  }

  run(request: RedeployRequest = REQUEST): Promise<DeployEnd> {
    const setup = { team: 'app', delivery: this.delivery, places: PLACES, zone: TimeZone.UTC, inTeam: (path: string) => path };
    return redeployTargets(setup, {
      git: this.git,
      hooks: this.hooks,
      files: this.files,
      memory: this.memory,
      pid: 4242,
      clock: this.clock,
      sleep: this.clock.sleep,
      lock: this.lock,
      env: { PATH: '/bin' },
      platform: 'linux',
      scanner: new SecretScanner(),
      nextReset: async () => this.reset,
      newId: () => 'step-1',
      say: (text) => this.said.push(text),
    }, request);
  }

  records(): unknown[] {
    return (this.files.get(PLACES.ledger) ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
  }

  /** The queued step's two records, its end with `exitCode`. */
  queuedStep(exitCode: number, startedAt: string, endedAt: string): unknown[] {
    const start = { type: 'heavy', id: 'step-1', session: 'sec', what: 'deploy api,live of pipeline', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: this.memory.free, startedAt, endedAt: null, exitCode: null };
    return [start, { ...start, endedAt, exitCode }];
  }

  lockFree(): boolean {
    return this.files.get(PLACES.hostLock) === undefined;
  }
}

function teamrigEnv(env: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('TEAMRIG_')));
}

function freeze(targets: readonly string[]): object {
  return { session: 'ops', targets, metric: 'p95', why: 'latency probe', from: '2030-01-08T09:50:00.000Z', until: '2030-01-08T10:05:00.000Z' };
}

describe('redeployTargets', () => {
  it('asks the checks before and under the lock, runs the command with the lock, and records one queued step and a deploy of its targets', async () => {
    const world = new World();
    world.hooks.answer(RESTART, { lines: ['restarting api, live', 'restarted 2 deployments'], takesMs: 90_000 });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'deployed api, live of pipeline: restarted 2 deployments' });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', RESTART.join(' ')], 'nothing is pulled, built or deployed');
    const base = { TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'sec', TEAMRIG_VERB: 'redeploy', TEAMRIG_REPO: 'pipeline', TEAMRIG_DEPLOY_TARGETS: 'api,live' };
    const [before, locked, command] = world.hooks.ran;
    assert.deepEqual(teamrigEnv(before?.env ?? {}), { ...base, TEAMRIG_CHECK_NAME: 'flow', TEAMRIG_CHECK_PHASE: 'before' });
    assert.deepEqual(teamrigEnv(locked?.env ?? {}), { ...base, TEAMRIG_CHECK_NAME: 'flow', TEAMRIG_CHECK_PHASE: 'locked' });
    assert.deepEqual(teamrigEnv(command?.env ?? {}), { ...base, TEAMRIG_HOST_LOCK: 'lock-1' });
    assert.deepEqual([before?.cwd, command?.cwd, command?.timeoutMs, command?.env['PATH']], [MAIN_CHECKOUT, '/runner', DEFAULT_QUEUE.maxRunMinutes * 60_000, '/bin']);
    assert.deepEqual(world.records(), [
      ...world.queuedStep(0, '2030-01-08T10:00:00.000Z', '2030-01-08T10:01:30.000Z'),
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'sec',
        repo: 'pipeline',
        range: 'at base',
        what: 'deploy api, live',
        note: 'rotate the db credential; restarted 2 deployments',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:01:30.000Z',
        targets: ['api', 'live'],
      },
    ]);
    assert.ok(world.said.includes('  restarting api, live'), 'the command’s lines are shown as they come');
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'base');
    assert.ok(world.lockFree());
  });

  it('watches the queued step it runs, and records the memory its tree held on the end record', async () => {
    const world = new World();
    world.memory.measures({ peakTreeMb: 1800, lowFreeMb: 5200, startFreeMb: 7600 });
    world.hooks.answer(RESTART, { lines: ['restarted 2 deployments'], takesMs: 90_000 });
    await world.run();
    assert.deepEqual(world.memory.watches, [{ root: 4242, intervalMs: DEFAULT_QUEUE.memorySampleSeconds * 1_000, stopped: true }]);
    const start = { type: 'heavy', id: 'step-1', session: 'sec', what: 'deploy api,live of pipeline', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records().slice(0, 2), [start, { ...start, endedAt: '2030-01-08T10:01:30.000Z', exitCode: 0, peakTreeMb: 1800, lowFreeMb: 5200, startFreeMb: 7600 }]);
  });

  it('refuses targets its repository does not deploy, or none, before any check or lock', async () => {
    const world = new World();
    const listed = 'delivery.repos.pipeline.deploy.targets (api, workers, live)';
    assert.deepEqual(await world.run({ ...REQUEST, targets: ['api', 'apii', 'cron'] }), { kind: 'refused', reason: `apii, cron are not in ${listed}: a deploy names only targets the deploy freezes and stable periods know` });
    assert.deepEqual(await world.run({ ...REQUEST, targets: ['apii'] }), { kind: 'refused', reason: `apii is not in ${listed}: a deploy names only targets the deploy freezes and stable periods know` });
    assert.deepEqual(await world.run({ ...REQUEST, targets: [] }), { kind: 'refused', reason: `name the targets the command restarts, from ${listed}` });
    assert.deepEqual(await world.run({ ...REQUEST, repo: 'site' }), { kind: 'refused', reason: 'site is not in delivery.repos (with a deploy block: pipeline)' });
    assert.deepEqual([world.hooks.ran.length, world.records().length, world.lockFree()], [0, 0, true]);
  });

  it('refuses a main checkout with no commit at HEAD, before any check or lock', async () => {
    const world = new World();
    world.git.heads.delete(MAIN_CHECKOUT);
    assert.deepEqual(await world.run(), { kind: 'refused', reason: `${MAIN_CHECKOUT} (delivery.repos.pipeline.mainCheckout) names no commit at HEAD, so the deploy could not record what it ran on` });
    assert.equal(world.hooks.ran.length, 0);
  });

  it('waits out a deploy freeze on a target it names, and not one on a target it leaves alone', async () => {
    const held = new World({ freezes: JSON.stringify([freeze(['live'])]) });
    assert.equal((await held.run()).kind, 'done');
    assert.ok(held.said.includes('waiting: deploy freeze by ops on live until 2030-01-08 10:05 UTC (p95)'));
    assert.ok(held.clock.now() >= Date.parse('2030-01-08T10:05:00Z'));
    const free = new World({ freezes: JSON.stringify([freeze(['workers'])]) });
    assert.equal((await free.run()).kind, 'done');
    assert.ok(!free.said.some((line) => line.startsWith('waiting:')), 'a freeze on workers does not hold a restart of api and live');
  });

  it('is refused at the queue cutoff and in the blackout before the token reset, running nothing', async () => {
    const late = new World({ schedule: { queueCutoffUtc: '09:00' } });
    assert.deepEqual(await late.run(), { kind: 'refused', reason: 'queue cutoff 09:00-00:00 UTC (now 10:00 UTC)' });
    const blackout = new World({ schedule: { resetBlackoutHours: 2 }, reset: { at: Date.parse('2030-01-08T11:00:00Z'), source: 'usage snapshot' } });
    const end = await blackout.run();
    assert.equal(end.kind, 'refused');
    assert.match(end.kind === 'refused' ? end.reason : '', /^deploy blackout before the weekly token reset: no deploy from .* \(reset from the usage snapshot\)$/);
    assert.deepEqual([late.hooks.ran.length, blackout.hooks.ran.length, late.records().length, blackout.records().length], [0, 0, 0, 0]);
  });

  it('waits while a check holds it and is refused when a check refuses, running nothing', async () => {
    const held = new World();
    held.hooks.answer(FLOW.command, { lines: ['batch run open since 23:10 UTC'], end: 75 }, {});
    assert.equal((await held.run()).kind, 'done');
    assert.ok(held.said.includes('waiting: check flow holds the deploy: batch run open since 23:10 UTC'));
    const frozen = new World();
    frozen.hooks.answer(FLOW.command, { lines: ['frozen for the release'], end: 2 });
    assert.deepEqual(await frozen.run(), { kind: 'refused', reason: 'check flow refuses the deploy: frozen for the release' });
    assert.deepEqual([frozen.hooks.commands, frozen.records().length, frozen.lockFree()], [['node checks/flow.js'], 0, true]);
  });

  it('records the deploy and fails when the command fails, its lines and reason redacted', async () => {
    const world = new World();
    world.hooks.answer(RESTART, { lines: ['restarting api', `refused: ${SECRET}`], end: 3 });
    assert.deepEqual(await world.run({ ...REQUEST, why: `rotate ${SECRET}` }), {
      kind: 'failed',
      reason: `the command exited 3: refused: ${REDACTED}, so api, live may be partly restarted; its owners fix forward or roll back`,
    });
    const [, , deploy] = world.records();
    assert.deepEqual(deploy, {
      type: 'deploy',
      kind: 'deploy',
      session: 'sec',
      repo: 'pipeline',
      range: 'at base',
      what: 'deploy api, live',
      note: `rotate ${REDACTED}; the command exited 3: refused: ${REDACTED}`,
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T10:00:00.000Z',
      targets: ['api', 'live'],
    });
    assert.deepEqual(world.records().slice(0, 2), world.queuedStep(3, '2030-01-08T10:00:00.000Z', '2030-01-08T10:00:00.000Z'));
    assert.ok(world.lockFree());
  });

  it('fails with no deploy recorded when the command cannot start', async () => {
    const world = new World();
    world.hooks.answer(RESTART, { end: { kind: 'notStarted', error: 'ENOENT' } });
    const end = await world.run();
    assert.equal(end.kind, 'failed');
    assert.match(end.kind === 'failed' ? end.reason : '', /^the command could not start \(ENOENT\), so nothing was deployed$/);
    assert.deepEqual(world.records().map((record) => (typeof record === 'object' && record !== null && 'type' in record ? record.type : undefined)), ['heavy', 'heavy']);
    assert.ok(world.lockFree());
  });
});
