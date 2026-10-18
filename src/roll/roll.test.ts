import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinatorConfig, CoordinatorRepoConfig, RollConfig, ScheduleConfig } from '../config/types.ts';
import { DEFAULT_CLAIMS, DEFAULT_COORDINATOR_WAIT, DEFAULT_GATE_TIMEOUT_SECONDS, DEFAULT_HEAVY, DEFAULT_WINDOWS } from '../config/defaults.ts';
import { HostLock } from '../coordinator/host-lock.ts';
import type { CoordinatorPlaces } from '../coordinator/places.ts';
import type { Env } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeIntegrateGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-integrate-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { hookExitCode, rollRepo, type RollEnd, type RollRequest, type RollSetup } from './roll.ts';

const PLACES: CoordinatorPlaces = {
  ledger: '/team/deploys/ledger.jsonl',
  ledgerMd: '/team/deploys/ledger.md',
  claims: '/team/deploys/claims.json',
  claimsMd: '/team/deploys/claims.md',
  claimsLock: '/team/deploys/claims.lock',
  hostLock: '/kit/host.lock',
};
const FLOW = { name: 'flow', command: ['node', 'gates/flow.js'] };
const AFTER_PULL = ['node', 'scripts/build-cli.js'];
const COMMAND = ['node', 'tools/roll.js'];
const ROLL: RollConfig = { targets: ['api', 'workers'], gates: [FLOW], afterPull: [AFTER_PULL], command: COMMAND };
const PIPELINE: CoordinatorRepoConfig = { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], dependencyGate: false, followMainCheckout: false, roll: ROLL };
const REQUEST: RollRequest = { session: 'po', repo: undefined, dir: '/elsewhere' };
const HEAVY_MS = DEFAULT_HEAVY.maxRunMinutes * 60_000;
const SECRET = ['db password', '=', 'hunter2'].join('');
const REDACTED = 'db [redacted password or key assignment]';
const BY_HAND = 'a new roll finds nothing pending, so run `node tools/roll.js` in /repo/app by hand once it is fixed';

interface Options {
  readonly repos?: Readonly<Record<string, CoordinatorRepoConfig>>;
  readonly schedule?: ScheduleConfig;
  readonly claims?: string;
}

class World {
  readonly git = new FakeIntegrateGit();
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');
  readonly hooks = new FakeHooks(this.clock);
  readonly lock: HostLock;
  readonly said: string[] = [];
  readonly setup: RollSetup;

  constructor(options: Options = {}) {
    this.files = new MemoryFiles(options.claims === undefined ? {} : { [PLACES.claims]: options.claims });
    this.lock = new HostLock(PLACES.hostLock, 150 * 60_000, { files: this.files, clock: this.clock, sleep: this.clock.sleep, pid: 7, alive: () => true, newId: () => 'lock-1' });
    const coordinator: CoordinatorConfig = {
      schedule: options.schedule ?? {},
      heavy: DEFAULT_HEAVY,
      wait: DEFAULT_COORDINATOR_WAIT,
      gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
      claims: DEFAULT_CLAIMS,
      windows: DEFAULT_WINDOWS,
      repos: options.repos ?? { pipeline: PIPELINE },
    };
    this.setup = { team: 'app', coordinator, places: PLACES, inTeam: (path) => (path.startsWith('/') ? path : `/repo/${path}`) };
    this.pushed('c1', 'c2');
  }

  /** Commits land on origin's main, on top of the main checkout's `base`. */
  pushed(...commits: string[]): void {
    const last = commits[commits.length - 1] ?? 'base';
    this.git.origin.set('main', last);
    this.git.ancestry.add(`base>${last}`);
    this.git.landed = commits;
  }

  run(request: RollRequest = REQUEST): Promise<RollEnd> {
    return rollRepo(this.setup, {
      git: this.git,
      hooks: this.hooks,
      files: this.files,
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

  /** The heavy step's two records, its end with `exitCode`. */
  heavy(exitCode: number, endedAt: string, what = 'roll pipeline c1..c2'): unknown[] {
    const start = { type: 'heavy', id: 'step-1', session: 'po', what, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
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

function refused(end: RollEnd, reason: string): void {
  assert.deepEqual(end, { kind: 'refused', reason });
}

describe('rollRepo', () => {
  it('pulls the pending range, runs afterPull then the roll command, and records one heavy step and the deploy', async () => {
    const world = new World();
    world.hooks.answer(FLOW.command, { lines: ['no flow open', 'tag=sha-0f8e'] }).answer(COMMAND, { lines: ['building', 'rolled api, workers on sha-0f8e'], takesMs: 120_000 });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 rolled: rolled api, workers on sha-0f8e' });
    assert.deepEqual(world.hooks.commands, ['node gates/flow.js', 'node gates/flow.js', 'node scripts/build-cli.js', 'node tools/roll.js']);
    const base = { TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'po', TEAMRIG_VERB: 'roll', TEAMRIG_REPO: 'pipeline', TEAMRIG_PENDING_RANGE: 'base..c2' };
    const [before, locked, afterPull, command] = world.hooks.ran;
    assert.deepEqual(teamrigEnv(before?.env ?? {}), { ...base, TEAMRIG_GATE_NAME: 'flow', TEAMRIG_GATE_PHASE: 'before' });
    assert.deepEqual(teamrigEnv(locked?.env ?? {}), { ...base, TEAMRIG_GATE_NAME: 'flow', TEAMRIG_GATE_PHASE: 'locked' });
    const rolling = { ...base, TEAMRIG_ROLL_TO: 'c2', TEAMRIG_ROLL_TAG: 'sha-0f8e', TEAMRIG_HOST_LOCK: 'lock-1' };
    assert.deepEqual(teamrigEnv(afterPull?.env ?? {}), rolling);
    assert.deepEqual(teamrigEnv(command?.env ?? {}), rolling);
    assert.deepEqual([command?.cwd, command?.timeoutMs, command?.env['PATH']], [MAIN_CHECKOUT, HEAVY_MS, '/bin']);
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'c2');
    assert.deepEqual(world.records(), [
      ...world.heavy(0, '2030-01-08T10:02:00.000Z'),
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'po',
        repo: 'pipeline',
        range: 'c1..c2',
        what: 'roll api, workers (sha-0f8e)',
        note: '2 commits; rolled api, workers on sha-0f8e',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:02:00.000Z',
      },
    ]);
    assert.ok(world.said.includes('  building'), 'the command’s lines are shown as they come');
    assert.ok(world.lockFree());
  });

  it('is done with nothing run when the main checkout is at origin', async () => {
    const world = new World();
    world.pushed();
    assert.deepEqual(await world.run(), { kind: 'done', summary: "nothing to roll: the pipeline main checkout is at its origin's default branch (base)" });
    assert.deepEqual([world.hooks.ran.length, world.records().length, world.pulled()], [0, 0, false]);
  });

  it('waits while a gate holds the roll, and pulls what origin has under the lock', async () => {
    const world = new World();
    const moved = async (): Promise<void> => world.pushed('c1', 'c2', 'c3');
    world.hooks.answer(FLOW.command, { lines: ['batch run open since 23:10 UTC'], end: 75, during: moved }, {});
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c3 rolled' });
    assert.ok(world.said.includes('waiting: gate flow holds the roll: batch run open since 23:10 UTC'));
    assert.equal(world.clock.now(), Date.parse('2030-01-08T10:00:00Z') + DEFAULT_COORDINATOR_WAIT.pollSeconds * 1_000);
    assert.equal(teamrigEnv(world.hooks.ran[2]?.env ?? {})['TEAMRIG_PENDING_RANGE'], 'base..c3', 'the locked gate judges the range pulled');
    assert.equal(world.git.heads.get(MAIN_CHECKOUT), 'c3');
  });

  it('ends under the lock, pulling nothing, when another roll pulled the range meanwhile', async () => {
    const world = new World();
    const rolledElsewhere = async (): Promise<void> => {
      world.git.heads.set(MAIN_CHECKOUT, 'c2');
    };
    world.hooks.answer(FLOW.command, { end: 75, during: rolledElsewhere }, {});
    assert.deepEqual(await world.run(), { kind: 'done', summary: "nothing to roll: the pipeline main checkout is at its origin's default branch (c2)" });
    assert.deepEqual(world.hooks.commands, ['node gates/flow.js', 'node gates/flow.js'], 'no gate is asked under the lock about nothing');
    assert.deepEqual([world.records().length, world.pulled(), world.lockFree()], [0, false, true]);
  });

  it('refuses when a gate refuses, pulling nothing', async () => {
    const world = new World();
    world.hooks.answer(FLOW.command, { lines: ['frozen for the release'], end: 2 });
    refused(await world.run(), 'gate flow refuses the roll: frozen for the release');
    assert.deepEqual([world.records().length, world.pulled(), world.lockFree()], [0, false, true]);
  });

  it('waits out a quiet claim on its targets, and is refused at the heavy cutoff', async () => {
    const claim = { session: 'ops', targets: ['workers'], metric: 'p95', why: 'latency probe', from: '2030-01-08T09:50:00.000Z', until: '2030-01-08T10:05:00.000Z' };
    const world = new World({ claims: JSON.stringify([claim]) });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 rolled' });
    assert.ok(world.said.includes('waiting: quiet claim by ops on workers until 2030-01-08 10:05 UTC (p95)'));
    assert.ok(world.clock.now() >= Date.parse('2030-01-08T10:05:00Z'));
    const late = new World({ schedule: { heavyCutoffUtc: '09:00' } });
    refused(await late.run(), 'nothing heavy after 09:00 UTC (now 2030-01-08 10:00)');
    assert.deepEqual([late.hooks.ran.length, late.pulled()], [0, false]);
  });

  it('records the deploy and fails when the roll command fails, its last line redacted', async () => {
    const world = new World();
    world.hooks.answer(COMMAND, { lines: [`orchestrator CRASH: ${SECRET}`], end: 1 });
    assert.deepEqual(await world.run(), {
      kind: 'failed',
      reason: `c1..c2 pulled, but the roll command exited 1: orchestrator CRASH: ${REDACTED}; its owners fix forward or roll back, and ${BY_HAND}`,
    });
    const [, end, deploy] = world.records();
    assert.deepEqual(end, world.heavy(1, '2030-01-08T10:00:00.000Z')[1]);
    assert.deepEqual(deploy, {
      type: 'deploy',
      kind: 'deploy',
      session: 'po',
      repo: 'pipeline',
      range: 'c1..c2',
      what: 'roll api, workers',
      note: `2 commits; the roll command exited 1: orchestrator CRASH: ${REDACTED}`,
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T10:00:00.000Z',
    });
    assert.ok(!(world.files.get(PLACES.ledgerMd) ?? '').includes('hunter2'));
  });

  it('records no deploy when the roll command says nothing needed rolling', async () => {
    const world = new World();
    world.hooks.answer(COMMAND, { lines: ['no image change', 'no-roll'] });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'c1..c2 pulled; nothing needed rolling' });
    assert.deepEqual(world.records(), world.heavy(0, '2030-01-08T10:00:00.000Z'));
  });

  it('fails without running the roll command when an afterPull hook fails', async () => {
    const world = new World();
    world.hooks.answer(AFTER_PULL, { end: 3 });
    assert.deepEqual(await world.run(), { kind: 'failed', reason: `c1..c2 pulled, but afterPull \`node scripts/build-cli.js\` exited 3, so nothing rolled; ${BY_HAND}` });
    assert.ok(!world.hooks.commands.includes('node tools/roll.js'));
    assert.deepEqual(world.records(), world.heavy(3, '2030-01-08T10:00:00.000Z'));
  });

  it('fails, running nothing after the gates, when the pull fails', async () => {
    const world = new World();
    world.git.fastForwardFails = 'Not possible to fast-forward, aborting.';
    assert.deepEqual(await world.run(), { kind: 'failed', reason: 'the pull of c1..c2 into /repo/app failed (Not possible to fast-forward, aborting.): nothing pulled, nothing rolled; roll again' });
    assert.deepEqual(world.hooks.commands, ['node gates/flow.js', 'node gates/flow.js']);
    assert.deepEqual(world.records(), world.heavy(1, '2030-01-08T10:00:00.000Z'));
    assert.ok(world.lockFree());
  });

  it('refuses a main checkout it must not pull into, before any gate or lock', async () => {
    const offBranch = new World();
    offBranch.git.checkouts.set(MAIN_CHECKOUT, { top: MAIN_CHECKOUT, branch: 'hotfix', mainCheckout: MAIN_CHECKOUT, linked: false });
    refused(await offBranch.run(), 'the pipeline main checkout /repo/app is on hotfix, not main');
    const dirty = new World();
    dirty.git.status.set(MAIN_CHECKOUT, [' M src/app.ts', '?? notes.txt']);
    refused(await dirty.run(), 'the pipeline main checkout /repo/app has 1 uncommitted change: a roll pulls only into a clean checkout');
    const diverged = new World();
    diverged.git.origin.set('main', 'theirs');
    refused(await diverged.run(), 'the pipeline main checkout /repo/app has commits that are not on origin/main: a roll only pulls fast-forward');
    const held = new World({ repos: { pipeline: { ...PIPELINE, dependencyGate: true } } });
    held.git.paths = ['package-lock.json', 'src/app.ts'];
    refused(
      await held.run(),
      'deps changed (package-lock.json): coordinator.repos.pipeline.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; pull and install by hand',
    );
    for (const world of [offBranch, dirty, diverged, held]) {
      assert.deepEqual([world.hooks.ran.length, world.files.get(PLACES.hostLock), world.pulled()], [0, undefined, false]);
    }
  });

  it('rolls the repository named, else the one the folder is in, else the only one with a roll', async () => {
    const CONSOLE: CoordinatorRepoConfig = { ...PIPELINE, mainCheckout: '/repo/console' };
    const SITE: CoordinatorRepoConfig = { mainCheckout: '/repo/site', deploysOnPush: ['cloud-web'], dependencyGate: false, followMainCheckout: false };
    const two = { pipeline: PIPELINE, console: CONSOLE, site: SITE };
    refused(await new World({ repos: two }).run({ ...REQUEST, repo: 'nope' }), 'nope is not in coordinator.repos (with a roll block: pipeline, console)');
    refused(await new World({ repos: two }).run({ ...REQUEST, repo: 'site' }), 'coordinator.repos.site has no roll block, so there is nothing to roll it with (with a roll block: pipeline, console)');
    refused(await new World({ repos: two }).run(), 'name the repository to roll with --repo (with a roll block: pipeline, console)');
    refused(await new World({ repos: { site: SITE } }).run(), 'no repository in coordinator.repos has a roll block');
    const inFolder = new World({ repos: two });
    assert.equal((await inFolder.run({ ...REQUEST, dir: WORKTREE })).kind, 'done');
    assert.equal(inFolder.git.heads.get(MAIN_CHECKOUT), 'c2');
    const named = new World({ repos: two });
    assert.equal((await named.run({ ...REQUEST, repo: 'pipeline' })).kind, 'done');
  });
});

describe('hookExitCode', () => {
  it('records a hook’s own code, 124 at its time limit, and 1 for a signal or a hook that did not start', () => {
    assert.deepEqual(
      [{ kind: 'exited', code: 3 } as const, { kind: 'timedOut' } as const, { kind: 'signal', signal: 'SIGKILL' } as const, { kind: 'notStarted', error: 'ENOENT' } as const].map(hookExitCode),
      [3, 124, 1, 1],
    );
  });
});
