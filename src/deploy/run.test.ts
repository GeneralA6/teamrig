import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import type { DeliveryConfig, DeliveryRepoConfig, DeployConfig, ScheduleConfig } from '../config/types.ts';
import { DEFAULT_FREEZES, DEFAULT_DELIVERY_WAIT, DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_QUEUE, DEFAULT_STABLE_PERIODS } from '../config/defaults.ts';
import { HostLock } from '../delivery/host-lock.ts';
import type { DeliveryPlaces } from '../delivery/places.ts';
import type { Env } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { BASELINE_LOCK_ENV } from '../merge/dependencies.ts';
import { LOCKFILE } from '../merge/manifest.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, defaultGateOn, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeMergeGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-merge-git.ts';
import { heldBy } from '../testing/held-lock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { deployRepo, type DeployEnd, type DeployRequest, type DeploySetup } from './run.ts';

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
const AFTER_PULL = ['node', 'scripts/build-cli.js'];
const COMMAND = ['node', 'tools/deploy.js'];
const DEPLOY: DeployConfig = { targets: ['api', 'workers'], checks: [FLOW], afterPull: [AFTER_PULL], command: COMMAND };
const PIPELINE: DeliveryRepoConfig = { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false, deploy: DEPLOY };
const REQUEST: DeployRequest = { session: 'po', repo: undefined, dir: '/elsewhere' };
const QUEUE_MAX_MS = DEFAULT_QUEUE.maxRunMinutes * 60_000;
const SECRET = ['db password', '=', 'hunter2'].join('');
const REDACTED = 'db [redacted password or key assignment]';
const BY_HAND = 'a new deploy finds nothing pending, so run `node tools/deploy.js` in /repo/app by hand once it is fixed';

interface Options {
  readonly repos?: Readonly<Record<string, DeliveryRepoConfig>>;
  readonly schedule?: ScheduleConfig;
  readonly freezes?: string;
  /** The host lock waits for host memory, as the CLI's does. */
  readonly memoryGated?: true;
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
  readonly setup: DeploySetup;

  constructor(options: Options = {}) {
    this.files = new MemoryFiles(options.freezes === undefined ? {} : { [PLACES.freezes]: options.freezes });
    this.lock = new HostLock(PLACES.hostLock, 150 * 60_000, {
      files: this.files,
      clock: this.clock,
      sleep: this.clock.sleep,
      pid: 7,
      alive: () => true,
      newId: () => 'lock-1',
      zone: TimeZone.UTC,
      ...(options.memoryGated === true ? { memory: defaultGateOn(this.memory, this.clock.sleep) } : {}),
    });
    const delivery: DeliveryConfig = {
      schedule: options.schedule ?? {},
      queue: DEFAULT_QUEUE,
      wait: DEFAULT_DELIVERY_WAIT,
      checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      freezes: DEFAULT_FREEZES,
      stablePeriods: DEFAULT_STABLE_PERIODS,
      repos: options.repos ?? { pipeline: PIPELINE },
    };
    this.setup = { team: 'app', delivery, places: PLACES, zone: TimeZone.UTC, inTeam: (path) => (path.startsWith('/') ? path : `/repo/${path}`) };
    this.pushed('c1', 'c2');
  }

  /** Commits land on origin's main, on top of the main checkout's `base`. */
  pushed(...commits: string[]): void {
    const last = commits[commits.length - 1] ?? 'base';
    this.git.origin.set('main', last);
    this.git.ancestry.add(`base>${last}`);
    this.git.landed = commits;
  }

  run(request: DeployRequest = REQUEST): Promise<DeployEnd> {
    return deployRepo(this.setup, {
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
      nextReset: async () => undefined,
      newId: () => 'step-1',
      say: (text) => this.said.push(text),
    }, request);
  }

  records(): unknown[] {
    return (this.files.get(PLACES.ledger) ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
  }

  /** The queued step's two records, its end with `exitCode`. */
  queuedStep(exitCode: number, endedAt: string, what = 'deploy pipeline c1..c2'): unknown[] {
    const start = { type: 'heavy', id: 'step-1', session: 'po', what, kind: 'deploy', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: this.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    return [start, { ...start, endedAt, exitCode }];
  }

  pulled(): boolean {
    return this.git.log.some((step) => step.startsWith('fastForward '));
  }

  lockFree(): boolean {
    return this.files.get(PLACES.hostLock) === undefined;
  }
}

function teamrigEnv(env: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('TEAMRIG_')));
}

function refused(end: DeployEnd, reason: string): void {
  assert.deepEqual(end, { kind: 'refused', reason });
}

const CHECK = ['node', 'checks/deps-check.js'];
const INSTALL = ['npm', 'ci', '--ignore-scripts'];
const OLD_LOCK = '{"lockfileVersion":3}';
const BASELINE = join(dirname(PLACES.ledger), 'baseline-step-1.package-lock.json');
const DEPS_CHANGED = 'deps changed (package-lock.json)';

/** A world whose pushed range changes package-lock.json, with the dependency gate, the check and the install each on unless turned off. */
function depsWorld({ gate = true, check = true, install = true }: { readonly gate?: boolean; readonly check?: boolean; readonly install?: boolean } = {}): World {
  const deploy: DeployConfig = install ? { ...DEPLOY, dependencyInstall: INSTALL } : DEPLOY;
  const world = new World({ repos: { pipeline: { ...PIPELINE, dependencyGate: gate, deploy, ...(check ? { dependencyCheck: CHECK } : {}) } } });
  world.git.paths = ['package-lock.json', 'src/app.ts'];
  world.git.files.set(`base:${LOCKFILE}`, OLD_LOCK);
  return world;
}

describe('deployRepo', () => {
  it('pulls the pending range, runs afterPull then the deploy command, and records one queued step and the deploy', async () => {
    const world = new World();
    world.hooks.answer(FLOW.command, { lines: ['no flow open', 'tag=sha-0f8e'] }).answer(COMMAND, { lines: ['building', 'deployed api, workers on sha-0f8e'], takesMs: 120_000 });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 deployed: deployed api, workers on sha-0f8e' });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'node scripts/build-cli.js', 'node tools/deploy.js']);
    const base = { TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'po', TEAMRIG_VERB: 'deploy', TEAMRIG_REPO: 'pipeline', TEAMRIG_PENDING_RANGE: 'base..c2' };
    const [before, locked, afterPull, command] = world.hooks.ran;
    assert.deepEqual(teamrigEnv(before?.env ?? {}), { ...base, TEAMRIG_CHECK_NAME: 'flow', TEAMRIG_CHECK_PHASE: 'before' });
    assert.deepEqual(teamrigEnv(locked?.env ?? {}), { ...base, TEAMRIG_CHECK_NAME: 'flow', TEAMRIG_CHECK_PHASE: 'locked' });
    const deploying = { ...base, TEAMRIG_DEPLOY_TO: 'c2', TEAMRIG_DEPLOY_TAG: 'sha-0f8e', TEAMRIG_HOST_LOCK: 'lock-1' };
    assert.deepEqual(teamrigEnv(afterPull?.env ?? {}), deploying);
    assert.deepEqual(teamrigEnv(command?.env ?? {}), deploying);
    assert.deepEqual([command?.cwd, command?.timeoutMs, command?.env['PATH']], [MAIN_CHECKOUT, QUEUE_MAX_MS, '/bin']);
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'c2');
    assert.deepEqual(world.records(), [
      ...world.queuedStep(0, '2030-01-08T10:02:00.000Z'),
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'po',
        repo: 'pipeline',
        range: 'c1..c2',
        what: 'deploy api, workers (sha-0f8e)',
        note: '2 commits; deployed api, workers on sha-0f8e',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:02:00.000Z',
      },
    ]);
    assert.ok(world.said.includes('  building'), 'the command’s lines are shown as they come');
    assert.ok(world.lockFree());
  });

  it('watches the queued step it runs, and records the memory its tree held on the end record', async () => {
    const world = new World();
    world.memory.measures({ peakTreeMb: 2400, lowFreeMb: 5100, startFreeMb: 7700 });
    world.hooks.answer(FLOW.command, { lines: ['no flow open', 'tag=sha-0f8e'] }).answer(COMMAND, { lines: ['deployed api, workers on sha-0f8e'], takesMs: 120_000 });
    await world.run();
    assert.deepEqual(world.memory.watches, [{ root: 4242, intervalMs: DEFAULT_QUEUE.memorySampleSeconds * 1_000, stopped: true }]);
    const start = { type: 'heavy', id: 'step-1', session: 'po', what: 'deploy pipeline c1..c2', kind: 'deploy', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records().slice(0, 2), [start, { ...start, endedAt: '2030-01-08T10:02:00.000Z', exitCode: 0, peakTreeMb: 2400, lowFreeMb: 5100, startFreeMb: 7700 }]);
  });

  it('is done with nothing run when the main checkout is at origin', async () => {
    const world = new World();
    world.pushed();
    assert.deepEqual(await world.run(), { kind: 'done', summary: "nothing to deploy: the pipeline main checkout is at its origin's default branch (base)" });
    assert.deepEqual([world.hooks.ran.length, world.records().length, world.pulled()], [0, 0, false]);
  });

  it('waits while a check holds the deploy, and pulls what origin has under the lock', async () => {
    const world = new World();
    const moved = async (): Promise<void> => world.pushed('c1', 'c2', 'c3');
    world.hooks.answer(FLOW.command, { lines: ['batch run open since 23:10 UTC'], end: 75, during: moved }, {});
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c3 deployed' });
    assert.ok(world.said.includes('waiting: check flow holds the deploy: batch run open since 23:10 UTC'));
    assert.equal(world.clock.now(), Date.parse('2030-01-08T10:00:00Z') + DEFAULT_DELIVERY_WAIT.pollSeconds * 1_000);
    const start = { type: 'heavy', id: 'step-1', session: 'po', what: 'deploy pipeline c1..c3', kind: 'deploy', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', waits: { check: DEFAULT_DELIVERY_WAIT.pollSeconds * 1_000 }, queueFreeMb: world.memory.free, startedAt: new Date(world.clock.now()).toISOString(), endedAt: null, exitCode: null };
    assert.deepEqual(world.records()[0], start, 'its record shows the wait from its first look, under the check');
    assert.equal(teamrigEnv(world.hooks.ran[2]?.env ?? {})['TEAMRIG_PENDING_RANGE'], 'base..c3', 'the check under the lock judges the range pulled');
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'c3');
  });

  it('ends under the lock, pulling nothing, when another deploy pulled the range meanwhile', async () => {
    const world = new World();
    const deployedElsewhere = async (): Promise<void> => {
      world.git.heads.set(MAIN_CHECKOUT, 'c2');
    };
    world.hooks.answer(FLOW.command, { end: 75, during: deployedElsewhere }, {});
    assert.deepEqual(await world.run(), { kind: 'done', summary: "nothing to deploy: the pipeline main checkout is at its origin's default branch (c2)" });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js'], 'no check is asked under the lock about nothing');
    assert.deepEqual([world.records().length, world.pulled(), world.lockFree()], [0, false, true]);
  });

  it('refuses when a check refuses, pulling nothing', async () => {
    const world = new World();
    world.hooks.answer(FLOW.command, { lines: ['frozen for the release'], end: 2 });
    refused(await world.run(), 'check flow refuses the deploy: frozen for the release');
    assert.deepEqual([world.records().length, world.pulled(), world.lockFree()], [0, false, true]);
  });

  it('leaves a refusal record, pulling nothing, when another step holds the host lock past its wait (T2209)', async () => {
    const world = new World();
    await world.files.write(PLACES.hostLock, heldBy());
    const end = await world.run();
    assert.equal(end.kind, 'refused');
    const reason = end.kind === 'refused' ? end.reason : '';
    assert.match(reason, /^host lock still held by po/);
    const endedAt = world.clock.now();
    assert.deepEqual(world.records(), [{
      type: 'refusal',
      id: 'step-1',
      session: 'po',
      what: 'deploy pipeline c1..c2',
      kind: 'deploy',
      kit: KIT_VERSION,
      queuedAt: '2030-01-08T10:00:00.000Z',
      endedAt: new Date(endedAt).toISOString(),
      outcome: 'timedOut',
      reason,
      waits: { lock: endedAt - Date.parse('2030-01-08T10:00:00Z') },
      lastWait: { cause: 'lock', text: 'the host lock: po (heavy: build) since 2030-01-08 09:50 UTC' },
      queueFreeMb: world.memory.free,
      endFreeMb: world.memory.free,
    }]);
    assert.equal(world.pulled(), false);
  });

  it('names the programs holding the most memory when it refuses after its wait on host memory, pulling nothing (T2209)', async () => {
    const world = new World({ memoryGated: true });
    world.memory.free = 5000;
    world.memory.holds(BUSY_HOLDERS);
    const end = await world.run();
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    const reason = `host memory still short: ${short}; ${BUSY_HOLDERS_TEXT}`;
    assert.deepEqual(end, { kind: 'refused', reason });
    const endedAt = world.clock.now();
    assert.deepEqual(world.records(), [{
      type: 'refusal',
      id: 'step-1',
      session: 'po',
      what: 'deploy pipeline c1..c2',
      kind: 'deploy',
      kit: KIT_VERSION,
      queuedAt: '2030-01-08T10:00:00.000Z',
      endedAt: new Date(endedAt).toISOString(),
      outcome: 'timedOut',
      reason,
      waits: { memory: endedAt - Date.parse('2030-01-08T10:00:00Z') },
      lastWait: { cause: 'memory', text: `the host lock: ${short}` },
      queueFreeMb: 5000,
      endFreeMb: 5000,
    }]);
    assert.equal(world.pulled(), false);
  });

  it('waits out a deploy freeze on its targets, and is refused at the queue cutoff', async () => {
    const freeze = { session: 'ops', targets: ['workers'], metric: 'p95', why: 'latency probe', from: '2030-01-08T09:50:00.000Z', until: '2030-01-08T10:05:00.000Z' };
    const world = new World({ freezes: JSON.stringify([freeze]) });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 deployed' });
    assert.ok(world.said.includes('waiting: deploy freeze by ops on workers until 2030-01-08 10:05 UTC (p95)'));
    assert.ok(world.clock.now() >= Date.parse('2030-01-08T10:05:00Z'));
    const late = new World({ schedule: { queueCutoffUtc: '09:00' } });
    refused(await late.run(), 'queue cutoff 09:00-00:00 UTC (now 10:00 UTC)');
    assert.deepEqual([late.hooks.ran.length, late.pulled()], [0, false]);
  });

  it('records the deploy and fails when the deploy command fails, its last line redacted', async () => {
    const world = new World();
    world.hooks.answer(COMMAND, { lines: [`orchestrator CRASH: ${SECRET}`], end: 1 });
    assert.deepEqual(await world.run(), {
      kind: 'failed',
      reason: `c1..c2 pulled, but the deploy command exited 1: orchestrator CRASH: ${REDACTED}; its owners fix forward or roll back, and ${BY_HAND}`,
    });
    const [, end, deploy] = world.records();
    assert.deepEqual(end, world.queuedStep(1, '2030-01-08T10:00:00.000Z')[1]);
    assert.deepEqual(deploy, {
      type: 'deploy',
      kind: 'deploy',
      session: 'po',
      repo: 'pipeline',
      range: 'c1..c2',
      what: 'deploy api, workers',
      note: `2 commits; the deploy command exited 1: orchestrator CRASH: ${REDACTED}`,
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T10:00:00.000Z',
    });
    assert.ok(!(world.files.get(PLACES.ledgerMd) ?? '').includes('hunter2'));
  });

  it('records no deploy when the deploy command says nothing needed deploying', async () => {
    const world = new World();
    world.hooks.answer(COMMAND, { lines: ['no image change', 'no-deploy'] });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 pulled; nothing needed deploying' });
    assert.deepEqual(world.records(), world.queuedStep(0, '2030-01-08T10:00:00.000Z'));
  });

  it('reads the no-deploy line wherever the command prints it, and the old no-roll line as any other', async () => {
    const early = new World();
    early.hooks.answer(COMMAND, { lines: ['no-deploy', 'image unchanged'] });
    assert.deepEqual(await early.run(), { kind: 'done', summary: 'c1..c2 pulled; nothing needed deploying: image unchanged' });
    assert.deepEqual(early.records(), early.queuedStep(0, '2030-01-08T10:00:00.000Z'));
    const old = new World();
    old.hooks.answer(COMMAND, { lines: ['no-roll'] });
    assert.deepEqual(await old.run(), { kind: 'done', summary: 'c1..c2 deployed: no-roll' });
    assert.equal(old.records().length, 3, 'the queued step and a deploy are recorded');
  });

  it('fails without running the deploy command when an afterPull hook fails', async () => {
    const world = new World();
    world.hooks.answer(AFTER_PULL, { end: 3 });
    assert.deepEqual(await world.run(), { kind: 'failed', reason: `c1..c2 pulled, but afterPull \`node scripts/build-cli.js\` exited 3, so nothing deployed; ${BY_HAND}` });
    assert.ok(!world.hooks.commands.includes('node tools/deploy.js'));
    assert.deepEqual(world.records(), world.queuedStep(3, '2030-01-08T10:00:00.000Z'));
  });

  it('fails, running nothing after the checks, when the pull fails', async () => {
    const world = new World();
    world.git.fastForwardFails = 'Not possible to fast-forward, aborting.';
    assert.deepEqual(await world.run(), { kind: 'failed', reason: 'the pull of c1..c2 into /repo/app failed (Not possible to fast-forward, aborting.): nothing pulled, nothing deployed; deploy again' });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js']);
    assert.deepEqual(world.records(), world.queuedStep(1, '2030-01-08T10:00:00.000Z'));
    assert.ok(world.lockFree());
  });

  it('refuses a main checkout it must not pull into, before any check or lock', async () => {
    const offBranch = new World();
    offBranch.git.checkouts.set(MAIN_CHECKOUT, { top: MAIN_CHECKOUT, branch: 'hotfix', mainCheckout: MAIN_CHECKOUT, linked: false });
    refused(await offBranch.run(), 'the pipeline main checkout /repo/app is on hotfix, not main');
    const dirty = new World();
    dirty.git.status.set(MAIN_CHECKOUT, [' M src/app.ts', '?? notes.txt']);
    refused(await dirty.run(), 'the pipeline main checkout /repo/app has 1 uncommitted change: a deploy pulls only into a clean checkout');
    const diverged = new World();
    diverged.git.origin.set('main', 'theirs');
    refused(await diverged.run(), 'the pipeline main checkout /repo/app has commits that are not on origin/main: a deploy only pulls fast-forward');
    const held = new World({ repos: { pipeline: { ...PIPELINE, dependencyGate: true } } });
    held.git.paths = ['package-lock.json', 'src/app.ts'];
    refused(
      await held.run(),
      'deps changed (package-lock.json): delivery.repos.pipeline.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; set delivery.repos.pipeline.dependencyCheck and delivery.repos.pipeline.deploy.dependencyInstall to deploy one, or pull and install by hand',
    );
    for (const world of [offBranch, dirty, diverged, held]) {
      assert.deepEqual([world.hooks.ran.length, world.files.get(PLACES.hostLock), world.pulled()], [0, undefined, false]);
    }
  });

  it('deploys the repository named, else the one the folder is in, else the only one with a deploy block', async () => {
    const CONSOLE: DeliveryRepoConfig = { ...PIPELINE, mainCheckout: '/repo/console' };
    const SITE: DeliveryRepoConfig = { mainCheckout: '/repo/site', deploysOnPush: ['cloud-web'], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false };
    const two = { pipeline: PIPELINE, console: CONSOLE, site: SITE };
    refused(await new World({ repos: two }).run({ ...REQUEST, repo: 'nope' }), 'nope is not in delivery.repos (with a deploy block: pipeline, console)');
    refused(await new World({ repos: two }).run({ ...REQUEST, repo: 'site' }), 'delivery.repos.site has no deploy block, so there is nothing to deploy it with (with a deploy block: pipeline, console)');
    refused(await new World({ repos: two }).run(), 'name the repository to deploy with --repo (with a deploy block: pipeline, console)');
    refused(await new World({ repos: { site: SITE } }).run(), 'no repository in delivery.repos has a deploy block');
    const inFolder = new World({ repos: two });
    assert.equal((await inFolder.run({ ...REQUEST, dir: WORKTREE })).kind, 'done');
    assert.equal(inFolder.git.heads.get(MAIN_CHECKOUT), 'c2');
    const named = new World({ repos: two });
    assert.equal((await named.run({ ...REQUEST, repo: 'pipeline' })).kind, 'done');
  });
});

describe('deployRepo of a range that changes the dependencies', () => {
  it('pulls, checks the change against the old package-lock.json, installs it, then runs afterPull and the deploy command', async () => {
    const world = depsWorld();
    const atCheck: (string | undefined)[] = [];
    world.hooks.answer(CHECK, {
      lines: ['1 package added, no advisories'],
      during: async (request) => {
        atCheck.push(world.git.heads.get(MAIN_CHECKOUT), world.files.get(request.env[BASELINE_LOCK_ENV] ?? ''));
      },
    });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 deployed' });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'node checks/deps-check.js', 'npm ci --ignore-scripts', 'node scripts/build-cli.js', 'node tools/deploy.js']);
    assert.deepEqual(atCheck, ['c2', OLD_LOCK], 'the check judges what was pulled against the old HEAD’s lock');
    const [, , check, install] = world.hooks.ran;
    assert.deepEqual([check?.cwd, check?.timeoutMs, check?.env[BASELINE_LOCK_ENV], check?.env['TEAMRIG_HOST_LOCK']], [MAIN_CHECKOUT, QUEUE_MAX_MS, BASELINE, 'lock-1']);
    assert.deepEqual([install?.cwd, install?.timeoutMs, install?.env[BASELINE_LOCK_ENV], install?.env['TEAMRIG_HOST_LOCK'], install?.env['TEAMRIG_DEPLOY_TO']], [MAIN_CHECKOUT, QUEUE_MAX_MS, undefined, 'lock-1', 'c2']);
    assert.equal(world.files.get(BASELINE), undefined, 'the baseline copy is removed');
    for (const line of [`${DEPS_CHANGED}: dependency check node checks/deps-check.js`, '  1 package added, no advisories', `${DEPS_CHANGED}: dependency install npm ci --ignore-scripts`, 'installed: the worktrees that link to the node_modules in /repo/app have the new dependencies now']) {
      assert.ok(world.said.includes(line), line);
    }
    assert.deepEqual(world.records().slice(0, 2), world.queuedStep(0, '2030-01-08T10:00:00.000Z'), 'the check and the install are inside the roll’s one queued step');
    assert.deepEqual([world.records().length, world.lockFree()], [3, true]);
  });

  it('refuses, moving the main checkout back with nothing installed, when the dependency check fails', async () => {
    const world = depsWorld();
    world.hooks.answer(CHECK, { lines: ['left-pad@9.0.0 was published 2 days ago'], end: 1 });
    refused(await world.run(), `${DEPS_CHANGED}: the dependency check \`node checks/deps-check.js\` exited 1, so /repo/app is back at base and nothing deployed; its output is above`);
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'node checks/deps-check.js']);
    assert.deepEqual([world.git.heads.get(MAIN_CHECKOUT), world.git.log.includes('resetTo /repo/app base')], ['base', true]);
    assert.deepEqual(world.records(), world.queuedStep(1, '2030-01-08T10:00:00.000Z'), 'no deploy is recorded');
    assert.deepEqual([world.files.get(BASELINE), world.lockFree()], [undefined, true]);
  });

  it('fails, naming the reset to do by hand, when the main checkout cannot move back after a failed check', async () => {
    const world = depsWorld();
    world.hooks.answer(CHECK, { end: 1 });
    world.git.resetFails = 'Entry src/app.ts not uptodate. Cannot merge.';
    assert.deepEqual(await world.run(), {
      kind: 'failed',
      reason: `${DEPS_CHANGED}: the dependency check \`node checks/deps-check.js\` exited 1, and moving /repo/app back to base failed (Entry src/app.ts not uptodate. Cannot merge.): it is at c2 with the old dependencies, so reset it to base by hand, else a new deploy finds nothing pending`,
    });
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'c2');
  });

  it('moves back and installs the old dependencies again when the install fails', async () => {
    const world = depsWorld();
    const reinstalledAt: (string | undefined)[] = [];
    world.hooks.answer(INSTALL, { lines: ['EBUSY: resource busy or locked'], end: 1 }, {
      during: async () => {
        reinstalledAt.push(world.git.heads.get(MAIN_CHECKOUT));
      },
    });
    assert.deepEqual(await world.run(), {
      kind: 'failed',
      reason: `${DEPS_CHANGED}: the dependency install \`npm ci --ignore-scripts\` exited 1, so /repo/app is back at base with its dependencies installed again and nothing deployed; fix the install and deploy again`,
    });
    assert.deepEqual(world.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'node checks/deps-check.js', 'npm ci --ignore-scripts', 'npm ci --ignore-scripts']);
    assert.deepEqual(reinstalledAt, ['base'], 'the second install runs on the old HEAD');
    assert.ok(world.said.includes('moved /repo/app back to base; installing its dependencies again'));
    assert.deepEqual(world.records(), world.queuedStep(1, '2030-01-08T10:00:00.000Z'));
  });

  it('fails loudly, naming what to run by hand, when the old dependencies cannot be restored', async () => {
    const reinstallFails = depsWorld();
    reinstallFails.hooks.answer(INSTALL, { end: 1 }, { end: 254 });
    assert.deepEqual(await reinstallFails.run(), {
      kind: 'failed',
      reason: `${DEPS_CHANGED}: the dependency install \`npm ci --ignore-scripts\` exited 1, and installing base's dependencies again exited 254: the node_modules every worktree links to may be broken; run \`npm ci --ignore-scripts\` in /repo/app by hand`,
    });
    const stuck = depsWorld();
    stuck.hooks.answer(INSTALL, { end: 1 });
    stuck.git.resetFails = 'Entry package-lock.json not uptodate. Cannot merge.';
    assert.deepEqual(await stuck.run(), {
      kind: 'failed',
      reason: `${DEPS_CHANGED}: the dependency install \`npm ci --ignore-scripts\` exited 1, and moving /repo/app back to base failed (Entry package-lock.json not uptodate. Cannot merge.): the node_modules every worktree links to may be broken; reset it to base and run \`npm ci --ignore-scripts\` in /repo/app by hand`,
    });
    assert.deepEqual(stuck.hooks.commands.filter((command) => command === 'npm ci --ignore-scripts'), ['npm ci --ignore-scripts'], 'no install runs on a checkout that did not move back');
  });

  it('installs unchecked with the gate off, and deploys as it is with no install set', async () => {
    const unchecked = depsWorld({ gate: false });
    assert.deepEqual(await unchecked.run(), { kind: 'done', summary: 'c1..c2 deployed' });
    assert.deepEqual(unchecked.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'npm ci --ignore-scripts', 'node scripts/build-cli.js', 'node tools/deploy.js']);
    const plain = depsWorld({ gate: false, install: false });
    assert.deepEqual(await plain.run(), { kind: 'done', summary: 'c1..c2 deployed' });
    assert.deepEqual(plain.hooks.commands, ['node checks/flow.js', 'node checks/flow.js', 'node scripts/build-cli.js', 'node tools/deploy.js']);
  });

  it('holds the range, before any check or lock, while the dependency gate lacks the check or the install, or cannot read the range', async () => {
    const hold = 'deps changed (package-lock.json): delivery.repos.pipeline.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; set';
    const noInstall = depsWorld({ install: false });
    refused(await noInstall.run(), `${hold} delivery.repos.pipeline.deploy.dependencyInstall to deploy one, or pull and install by hand`);
    const noCheck = depsWorld({ check: false });
    refused(await noCheck.run(), `${hold} delivery.repos.pipeline.dependencyCheck to deploy one, or pull and install by hand`);
    const unreadable = depsWorld();
    unreadable.git.paths = undefined;
    refused(await unreadable.run(), 'could not read what base..c2 changes, so the deploy cannot tell whether it changes the dependencies');
    for (const world of [noInstall, noCheck, unreadable]) {
      assert.deepEqual([world.hooks.ran.length, world.files.get(PLACES.hostLock), world.pulled()], [0, undefined, false]);
    }
  });
});
