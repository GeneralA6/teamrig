import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { LeadTree } from '../config/lead-tree.ts';
import type { DeliveryConfig, DeliveryRepoConfig, ScheduleConfig } from '../config/types.ts';
import { DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_FREEZES, DEFAULT_COMMITS, DEFAULT_DELIVERY_WAIT, DEFAULT_QUEUE, DEFAULT_STABLE_PERIODS } from '../config/defaults.ts';
import { HostLock } from '../delivery/host-lock.ts';
import type { DeliveryPlaces } from '../delivery/places.ts';
import type { ResetTime } from '../delivery/schedule.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import type { CommitStat } from '../push-guard/commit-size.ts';
import { passRecordPath, type PassRecord } from '../push-guard/pass-record.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, defaultGateOn, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeMergeGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-merge-git.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { heldBy } from '../testing/held-lock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { commandLine } from '../test-run/shell.ts';
import { BASELINE_LOCK_ENV } from './dependencies.ts';
import { GateHolds } from './gate-holds.ts';
import type { GatedSetup } from './gated-step.ts';
import { mergeBranch, PUSH_ATTEMPTS, repoOf, type MergedTask, type MergeEnd, type MergeRequest, type MergeSetup } from './merge.ts';
import { MergeLog } from './merge-log.ts';
import { parsePendingMerge, type PendingMerge } from './pending-merges.ts';
import { REVIEW_BASE_ENV } from './review-check.ts';
import type { ReviewGateSetup } from './review-gate-step.ts';
import { ReviewHolds } from './review-holds.ts';

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
const REQUEST: MergeRequest = { session: 'api', dir: WORKTREE, keepRemote: false, keepLocal: false };
const NO_REVIEW: ReviewGateSetup = { reviewPaths: [], tree: new LeadTree(testConfig()), roles: {} };
const PLAIN: DeliveryRepoConfig = { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false };
/** The team's task folders. */
const TASKS = '/team/tasks';
/** A commit of a source file with its test, under the size limits. */
const COMMIT: CommitStat = { sha: 'rebased', subject: 'Add the feature', body: '', files: [{ path: 'src/app.ts', added: 10, deleted: 2 }, { path: 'src/app.test.ts', added: 20, deleted: 0 }] };

interface Options {
  readonly repos?: Readonly<Record<string, DeliveryRepoConfig>>;
  readonly schedule?: ScheduleConfig;
  readonly waitMinutes?: number;
  readonly start?: string;
  readonly reset?: ResetTime;
  /** The deploy freezes file's text. */
  readonly freezes?: string;
  readonly review?: ReviewGateSetup;
  readonly gated?: GatedSetup;
  /** The host lock waits for host memory, as the CLI's does. */
  readonly memoryGated?: true;
}

class World {
  readonly git = new FakeMergeGit();
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly steps: FakeSteps;
  readonly hooks: FakeHooks;
  readonly lock: HostLock;
  readonly said: string[] = [];
  /** The host's memory, which each queued step's watch reads. */
  readonly memory = new FakeHostMemory();
  /** The register's tasks, as the review gate and the self-merge gates read them. */
  readonly tasks = new Map<string, MergedTask>();
  readonly reviewHolds: ReviewHolds;
  readonly gateHolds: GateHolds;
  readonly merges: MergeLog;
  /** The commits the change lands, as the self-merge gates weigh them; undefined where git cannot read them. */
  commits: readonly CommitStat[] | undefined = [COMMIT];
  /** How often the next reset was read. */
  resetReads = 0;
  readonly setup: MergeSetup;
  private readonly reset: ResetTime | undefined;

  constructor(options: Options = {}) {
    this.files = new MemoryFiles(options.freezes === undefined ? {} : { [PLACES.freezes]: options.freezes });
    this.clock = new FakeClock(options.start ?? '2030-01-08T10:00:00Z');
    this.steps = new FakeSteps(this.clock).ends(0, 90_000);
    this.hooks = new FakeHooks(this.clock);
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
    this.reset = options.reset;
    this.reviewHolds = new ReviewHolds(this.files, PLACES.reviewHolds);
    this.gateHolds = new GateHolds(this.files, PLACES.gateHolds);
    this.merges = new MergeLog(this.files, PLACES.merges);
    const delivery: DeliveryConfig = {
      schedule: options.schedule ?? {},
      queue: DEFAULT_QUEUE,
      wait: { ...DEFAULT_DELIVERY_WAIT, maxMinutes: options.waitMinutes ?? DEFAULT_DELIVERY_WAIT.maxMinutes },
      checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      freezes: DEFAULT_FREEZES,
      stablePeriods: DEFAULT_STABLE_PERIODS,
      repos: options.repos ?? {},
    };
    this.setup = {
      delivery,
      places: PLACES,
      zone: TimeZone.UTC,
      inTeam: (path) => (path.startsWith('/') ? path : `/repo/${path}`),
      review: options.review ?? NO_REVIEW,
      gated: options.gated,
      tasksFolder: TASKS,
    };
    this.pushLands();
  }

  /** Each push moves origin's main to the worktree's HEAD, as a push that git accepts does. */
  pushLands(): void {
    this.steps.whileRunning(async (request) => {
      const head = this.git.heads.get(request.cwd);
      if (head !== undefined) {
        this.git.pushed('main', head);
      }
    });
  }

  run(request: MergeRequest = REQUEST): Promise<MergeEnd> {
    return mergeBranch(this.setup, {
      git: this.git,
      steps: this.steps,
      hooks: this.hooks,
      scanner: { redact: (text) => text.replaceAll('s3cret', '[redacted]') },
      files: this.files,
      memory: this.memory,
      pid: 4242,
      reviewHolds: this.reviewHolds,
      gateHolds: this.gateHolds,
      merges: this.merges,
      commitLog: { between: () => this.commits },
      taskOf: async (id) => this.tasks.get(id),
      clock: this.clock,
      sleep: this.clock.sleep,
      lock: this.lock,
      env: { PATH: '/bin', GIT_DIR: '/elsewhere/.git' },
      platform: 'linux',
      nextReset: async () => {
        this.resetReads += 1;
        return this.reset;
      },
      newId: () => 'step-1',
      say: (text) => this.said.push(text),
    }, request);
  }

  records(path: string): unknown[] {
    return (this.files.get(path) ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
  }

  /** The host lock is free again. */
  lockFree(): boolean {
    return this.files.get(PLACES.hostLock) === undefined;
  }
}

function refused(end: MergeEnd, pattern: RegExp): void {
  assert.equal(end.kind, 'refused', JSON.stringify(end));
  assert.match(end.kind === 'refused' ? end.reason : '', pattern);
}

function failed(end: MergeEnd, pattern: RegExp): void {
  assert.equal(end.kind, 'failed', JSON.stringify(end));
  assert.match(end.kind === 'failed' ? end.reason : '', pattern);
}

describe('repoOf', () => {
  const setup = new World({ repos: { app: { ...PLAIN, mainCheckout: 'app' }, web: { ...PLAIN, mainCheckout: '/repo/web' } } }).setup;

  it('finds the repository by its main checkout, a relative path in the team folder, from a worktree of it', () => {
    const match = repoOf({ top: WORKTREE, branch: 'feat', mainCheckout: MAIN_CHECKOUT, linked: true }, setup, 'linux');
    assert.deepEqual(match, { name: 'app', config: { ...PLAIN, mainCheckout: 'app' }, listed: true });
  });

  it('names an unlisted repository after its main checkout and configures nothing for it', () => {
    const match = repoOf({ top: '/repo/tools', branch: 'feat', mainCheckout: undefined, linked: false }, setup, 'linux');
    assert.deepEqual(match, { name: 'tools', config: { ...PLAIN, mainCheckout: '/repo/tools' }, listed: false });
  });
});


describe('merge refuses a branch it must not merge, before the lock', () => {
  const cases: readonly { readonly name: string; readonly arrange: (world: World) => void; readonly request?: MergeRequest; readonly expect: RegExp }[] = [
    { name: 'a folder outside git', arrange: () => undefined, request: { ...REQUEST, dir: '/nowhere' }, expect: /\/nowhere is not in a git checkout/ },
    { name: 'a detached HEAD', arrange: (world) => world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: undefined, mainCheckout: MAIN_CHECKOUT, linked: true }), expect: /detached HEAD/ },
    { name: 'a failed git status', arrange: (world) => world.git.statusFails.add(WORKTREE), expect: /git status failed/ },
    { name: 'one uncommitted change', arrange: (world) => world.git.status.set(WORKTREE, [' M a.ts']), expect: /has 1 uncommitted change:/ },
    { name: 'untracked files too', arrange: (world) => world.git.status.set(WORKTREE, ['?? a.ts', '?? b.ts']), expect: /has 2 uncommitted changes/ },
    { name: 'the default branch itself', arrange: () => undefined, request: { ...REQUEST, dir: MAIN_CHECKOUT }, expect: /main is a default branch/ },
    {
      name: 'master when the default branch is another',
      arrange: (world) => {
        world.git.defaultName = 'trunk';
        world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 'master', mainCheckout: MAIN_CHECKOUT, linked: true });
      },
      expect: /master is a default branch/,
    },
    { name: 'a branch with nothing new', arrange: (world) => world.git.heads.set(WORKTREE, 'base'), expect: /nothing to merge: every commit of feat is already on origin\/main/ },
  ];
  for (const { name, arrange, request, expect } of cases) {
    it(name, async () => {
      const world = new World();
      arrange(world);
      refused(await world.run(request), expect);
      assert.deepEqual(world.steps.ran, []);
      assert.ok(world.lockFree());
    });
  }

  it('fails when the first fetch fails', async () => {
    const world = new World();
    world.git.fetchFails = 'could not resolve host';
    failed(await world.run(), /git fetch failed: could not resolve host/);
    assert.deepEqual(world.steps.ran, []);
  });
});

describe('merge holds a dependency change where the repository asks for it', () => {
  const gated = { app: { ...PLAIN, dependencyGate: true } };

  it('refuses a lockfile change and names the setting that holds it', async () => {
    const world = new World({ repos: gated });
    world.git.paths = ['src/app.ts', 'package-lock.json'];
    refused(await world.run(), /deps changed \(package-lock\.json\): delivery\.repos\.app\.dependencyGate/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('refuses a package.json change an install reads, reading it at the merge base and at HEAD', async () => {
    const world = new World({ repos: gated });
    world.git.paths = ['package.json'];
    world.git.files.set('base:package.json', JSON.stringify({ dependencies: { a: '1.0.0' } }));
    world.git.files.set('mine:package.json', JSON.stringify({ dependencies: { a: '1.0.1' } }));
    refused(await world.run(), /deps changed \(package\.json fields an install reads\)/);
  });

  it('merges a package.json change to its scripts only', async () => {
    const world = new World({ repos: gated });
    world.git.paths = ['package.json'];
    world.git.files.set('base:package.json', JSON.stringify({ scripts: { test: 'a' } }));
    world.git.files.set('mine:package.json', JSON.stringify({ scripts: { test: 'b' } }));
    assert.equal((await world.run()).kind, 'done');
  });

  it('merges a package.json change to a tool\'s settings only, such as jest', async () => {
    const world = new World({ repos: gated });
    world.git.paths = ['package.json'];
    world.git.files.set('base:package.json', JSON.stringify({ dependencies: { a: '1.0.0' }, jest: { preset: 'ts-jest' } }));
    world.git.files.set('mine:package.json', JSON.stringify({ dependencies: { a: '1.0.0' }, jest: { preset: 'ts-jest/presets/default-esm' } }));
    assert.equal((await world.run()).kind, 'done');
  });

  it('refuses when it cannot read what the branch changes', async () => {
    const world = new World({ repos: gated });
    world.git.mergeBaseIs = undefined;
    refused(await world.run(), /dependency gate cannot clear it/);
  });

  it('lets a lockfile change through where the gate is off', async () => {
    const world = new World({ repos: { app: PLAIN } });
    world.git.paths = ['package-lock.json'];
    assert.equal((await world.run()).kind, 'done');
  });

  it('says which setting clears a change it holds', async () => {
    const world = new World({ repos: gated });
    world.git.paths = ['package-lock.json'];
    refused(await world.run(), /set delivery\.repos\.app\.dependencyCheck to the check that clears one/);
  });
});

describe('merge holds a task with a design note and no decision record where the repository asks for it', () => {
  const RECORD = 'docs/decisions/2030-01-08-merge-gate.md';
  const recorded: DeliveryRepoConfig = { ...PLAIN, decisionRecordGate: true };

  /** The branch `t5-docs` of task T5, at `mine` in the worktree, whose task folder holds a design note, changing `paths`. */
  async function taskWorld(config: DeliveryRepoConfig, paths: readonly string[]): Promise<World> {
    const world = new World({ repos: { app: config } });
    world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't5-docs', mainCheckout: MAIN_CHECKOUT, linked: true });
    world.git.branches.set('t5-docs', 'mine');
    world.git.origin.set('t5-docs', 'mine');
    world.git.paths = paths;
    for (const path of paths) {
      world.git.files.set(`mine:${path}`, '# Record\n');
    }
    await world.files.write(`${TASKS}/T5/design.md`, '# T5 design\n');
    return world;
  }

  it('merges the branch once it adds a decision record', async () => {
    const world = await taskWorld(recorded, ['src/app.ts', RECORD]);
    assert.equal((await world.run()).kind, 'done');
  });

  it('refuses the branch before the lock while it adds no record, naming the note and the setting', async () => {
    const world = await taskWorld(recorded, ['src/app.ts']);
    refused(await world.run(), /^T5 has a design note \(design\.md\) and t5-docs adds or changes no decision record in docs\/decisions\/: .*delivery\.repos\.app\.decisionRecordGate/);
    assert.deepEqual(world.steps.ran, []);
    assert.ok(world.lockFree());
  });

  it('merges the branch with no record where the gate is off', async () => {
    const world = await taskWorld(PLAIN, ['src/app.ts']);
    assert.equal((await world.run()).kind, 'done');
  });

  it('finishes a waiting merge without weighing it again, once a merge commit leaves the branch changing nothing', async () => {
    const MERGE = ['node', 'merge.ts'];
    const world = await taskWorld({ ...recorded, merge: { command: MERGE, remote: 'origin' } }, ['src/app.ts', RECORD]);
    world.hooks.answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] });
    assert.equal((await world.run()).kind, 'waiting');
    world.git.origin.set('main', 'mergecommit');
    world.git.ancestry.add('rebased>mergecommit');
    world.git.landed = ['rebased', 'mergecommit'];
    world.git.diffs.set('mergecommit..rebased', []);
    // The merge commit holds the branch, so the branch's merge base with the default branch is the branch itself.
    world.git.mergeBaseIs = 'rebased';
    assert.equal((await world.run()).kind, 'done');
    assert.equal(world.hooks.ran.length, 1);
  });
});

describe('merge runs the dependency check, where one is set, on what the rebase made', () => {
  const CHECK = ['node', 'check-change.ts'];
  const checked = { app: { ...PLAIN, dependencyGate: true, dependencyCheck: CHECK } };
  const BASELINE = join(dirname(PLACES.ledger), 'baseline-step-1.package-lock.json');

  it('runs it in the branch’s checkout under the host lock, with the default branch’s lockfile, then pushes', async () => {
    const world = new World({ repos: checked });
    world.git.paths = ['package-lock.json'];
    world.git.files.set('base:package-lock.json', '{"lockfileVersion":3}');
    const during: { baseline?: string | undefined; head?: string | undefined; lockHeld?: boolean } = {};
    world.hooks.answer(CHECK, {
      lines: ['pins hold'],
      during: async (request) => {
        const path = request.env[BASELINE_LOCK_ENV];
        during.baseline = path === undefined ? undefined : world.files.get(path);
        during.head = world.git.heads.get(request.cwd);
        during.lockHeld = !world.lockFree();
      },
    });
    assert.equal((await world.run()).kind, 'done');
    const [run] = world.hooks.ran;
    assert.deepEqual(run?.argv, CHECK);
    assert.equal(run?.cwd, WORKTREE);
    assert.equal(run?.env[BASELINE_LOCK_ENV], BASELINE);
    assert.equal(run?.env['TEAMRIG_HOST_LOCK'], 'lock-1');
    assert.equal(run?.env['GIT_DIR'], undefined);
    assert.deepEqual(during, { baseline: '{"lockfileVersion":3}', head: 'rebased', lockHeld: true });
    assert.equal(world.files.get(BASELINE), undefined);
    assert.ok(world.said.includes('deps changed (package-lock.json): dependency check node check-change.ts'));
    assert.ok(world.said.includes('  pins hold'));
    assert.equal(world.steps.ran.length, 1);
    const checks = world.records(PLACES.ledger).filter((record) => JSON.stringify(record).includes('dependency check of feat'));
    assert.equal(checks.length, 2);
    const pushes = world.records(PLACES.ledger).filter((record) => JSON.stringify(record).includes('push feat to main'));
    const waited = (records: unknown[]): boolean[] => records.map((record) => JSON.stringify(record).includes('"queuedAt":"2030-01-08T10:00:00.000Z"'));
    assert.deepEqual([waited(checks), waited(pushes)], [[true, true], [false, false]], 'the wait is on the first step under the lock only');
  });

  it('refuses a change the check fails, shows its output redacted, pushes nothing and removes the lockfile copy', async () => {
    const world = new World({ repos: checked });
    world.git.paths = ['package-lock.json'];
    world.git.files.set('base:package-lock.json', '{}');
    world.hooks.answer(CHECK, { lines: ['token s3cret moved a pin'], end: 3 });
    refused(await world.run(), /deps changed \(package-lock\.json\): the dependency check `node check-change\.ts` exited 3, so feat stays off main; its output is above/);
    assert.ok(world.said.includes('  token [redacted] moved a pin'));
    assert.deepEqual(world.steps.ran, []);
    assert.equal(world.files.get(BASELINE), undefined);
    assert.ok(world.lockFree());
  });

  it('refuses when the check cannot start, and leaves the lockfile copy unset where the default branch has none', async () => {
    const world = new World({ repos: checked });
    world.git.paths = ['package-lock.json'];
    world.hooks.answer(CHECK, { end: { kind: 'notStarted', error: 'ENOENT' } });
    refused(await world.run(), /the dependency check `node check-change\.ts` could not start \(ENOENT\)/);
    assert.equal(world.hooks.ran[0]?.env[BASELINE_LOCK_ENV], undefined);
  });

  it('runs no check for a branch that changes no package files', async () => {
    const world = new World({ repos: checked });
    assert.equal((await world.run()).kind, 'done');
    assert.deepEqual(world.hooks.ran, []);
  });

  it('refuses when it cannot read what the rebased branch changes', async () => {
    const world = new World({ repos: checked });
    world.git.paths = undefined;
    refused(await world.run(), /could not read what feat changes against base, so the dependency check cannot clear it/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('checks again, against the default branch it rebased onto, when origin moved during the push', async () => {
    const world = new World({ repos: checked });
    world.git.paths = ['package-lock.json'];
    world.git.files.set('base:package-lock.json', 'base lock');
    world.git.files.set('theirs:package-lock.json', 'their lock');
    const baselines: (string | undefined)[] = [];
    world.hooks.answer(CHECK, {
      during: async (request) => {
        const path = request.env[BASELINE_LOCK_ENV];
        baselines.push(path === undefined ? undefined : world.files.get(path));
      },
    });
    let pushes = 0;
    world.steps.whileRunning(async () => {
      pushes += 1;
      if (pushes === 1) {
        world.git.origin.set('main', 'theirs');
        world.git.rebasedTo = 'rebased-2';
        return;
      }
      world.git.pushed('main', world.git.heads.get(WORKTREE) ?? '');
    });
    assert.equal((await world.run()).kind, 'done');
    assert.deepEqual(baselines, ['base lock', 'their lock']);
  });
});

describe('merge pushes a branch to the default branch', () => {
  it('rebases, pushes HEAD to the default branch as a recorded queued step, then tidies the branch away', async () => {
    const world = new World();
    world.git.landed = ['aaaaaaaa1111', 'bbbbbbbb2222'];
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'pushed aaaaaaaa..bbbbbbbb to main' });
    assert.deepEqual(world.steps.ran, [
      { command: commandLine(['git', 'push', 'origin', 'HEAD:refs/heads/main'], 'linux'), cwd: WORKTREE, env: { PATH: '/bin', TEAMRIG_HOST_LOCK: 'lock-1' }, timeoutMs: DEFAULT_QUEUE.maxRunMinutes * 60_000 },
    ]);
    assert.deepEqual(world.git.log, [
      `fetch ${WORKTREE} origin`,
      `fetch ${WORKTREE} origin`,
      `rebase ${WORKTREE} origin/main`,
      `deleteRemoteBranch ${WORKTREE} feat`,
      `detach ${WORKTREE}`,
      `deleteBranch ${WORKTREE} feat`,
      `updateLocalBranch ${WORKTREE} origin main`,
    ]);
    const start = { type: 'heavy', id: 'step-1', session: 'api', what: 'merge app: push feat to main', kind: 'merge', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records(PLACES.ledger), [start, { ...start, endedAt: '2030-01-08T10:01:30.000Z', exitCode: 0 }]);
    assert.equal(world.files.get(PLACES.ledgerMd), undefined);
    assert.ok(world.lockFree());
    assert.ok(world.said.includes('NOTE app is not in delivery.repos: no deploy targets, no dependency gate, no main checkout to follow'));
    assert.equal(world.said.at(-1), `next: teamrig worktree remove "${WORKTREE}"`);
  });

  it("records the task its branch names, at that task's register priority, on the push's start and end records (T2209)", async () => {
    const world = new World();
    world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't9-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    world.tasks.set('T9', { owner: 'alpha', priority: 1, status: 'in-progress', answer: null });
    assert.equal((await world.run()).kind, 'done');
    const start = { type: 'heavy', id: 'step-1', session: 'api', what: 'merge app: push t9-feat to main', kind: 'merge', task: 'T9', priority: 1, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records(PLACES.ledger), [start, { ...start, endedAt: '2030-01-08T10:01:30.000Z', exitCode: 0 }]);
  });

  it('records a push a host deploys by itself as that deploy, in both ledgers', async () => {
    const world = new World({ repos: { app: { ...PLAIN, deploysOnPush: ['cloud-api'] } } });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'pushed rebased to main; cloud-api deploy on push' });
    const deploy = {
      type: 'deploy',
      kind: 'deploy',
      session: 'api',
      repo: 'app',
      range: 'rebased',
      what: 'merge feat',
      note: 'pushed to main; cloud-api deploy on push, not watched by teamrig',
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T10:01:30.000Z',
    };
    assert.deepEqual(world.records(PLACES.ledger).at(-1), deploy);
    assert.match(world.files.get(PLACES.ledgerMd) ?? '', /\n- 2030-01-08 10:01 \| api \| app \| rebased \| merge feat \| deploy \| pushed to main; cloud-api deploy on push, not watched by teamrig\n$/);
  });

  it('keeps the branch on origin and here when asked, and says how to remove the worktree with it', async () => {
    const world = new World();
    assert.equal((await world.run({ ...REQUEST, keepRemote: true, keepLocal: true })).kind, 'done');
    assert.deepEqual(world.git.log.slice(3), [`updateLocalBranch ${WORKTREE} origin main`]);
    assert.equal(world.said.at(-1), `next: teamrig worktree remove "${WORKTREE}" --delete-branch`);
  });

  it('takes a push whose command failed after origin took it as merged, and says so', async () => {
    const world = new World();
    world.steps.ends(1, 1_000);
    assert.equal((await world.run()).kind, 'done');
    assert.ok(world.said.includes("the push exited 1, but origin's main is at rebased: it merged"));
  });

  it('checks out the default branch in a main checkout it merged from, where its local branch moved', async () => {
    const world = new World();
    world.git.checkouts.set('/solo', { top: '/solo', branch: 'feat', mainCheckout: '/solo', linked: false });
    world.git.heads.set('/solo', 'mine');
    world.git.localUpdate = { kind: 'updated' };
    assert.equal((await world.run({ ...REQUEST, dir: '/solo' })).kind, 'done');
    assert.equal(world.git.log.at(-1), 'checkout /solo main');
    assert.equal(world.git.branches.get('main'), 'rebased');
    assert.ok(!world.said.some((line) => line.startsWith('next:')));
  });
});

describe('merge goes through the repository’s merge command, where one is set', () => {
  const MERGE = ['node', 'merge.ts'];
  const MERGING: DeliveryRepoConfig = { ...PLAIN, merge: { command: MERGE, remote: 'origin' } };
  const PENDING = join(PLACES.pendingMerges, 'app%2Ffeat.json');
  const WAITED: PendingMerge = { session: 'api', repo: 'app', branch: 'feat', head: 'rebased', base: 'base', since: '2030-01-08T10:00:00.000Z', note: 'https://forge/pr/7' };
  const HALF_HOUR = 30 * 60_000;

  /** Origin's main moves to `commit`, which holds the rebased branch's files, as a squash merge of it does. */
  function squashedAs(world: World, commit: string): void {
    world.git.origin.set('main', commit);
    world.git.landed = [commit];
    world.git.diffs.set(`${commit}..rebased`, []);
  }

  function pendingOf(world: World): PendingMerge | undefined {
    const text = world.files.get(PENDING);
    return text === undefined ? undefined : parsePendingMerge(text);
  }

  function tidied(world: World): boolean {
    return world.git.log.some((line) => line.startsWith('deleteRemoteBranch') || line.startsWith('detach') || line.startsWith('deleteBranch'));
  }

  it('rebases, runs the command under the host lock as a recorded queued step, finds the merge on origin, then tidies the branch away', async () => {
    const world = new World({ repos: { app: { ...MERGING, deploysOnPush: ['cloud-api'] } } });
    const during: { head?: string | undefined; lockHeld?: boolean } = {};
    world.hooks.answer(MERGE, {
      lines: ['pull request https://forge/pr/7 merged', ''],
      takesMs: 60_000,
      during: async (request) => {
        during.head = world.git.heads.get(request.cwd);
        during.lockHeld = !world.lockFree();
        squashedAs(world, 'squashed');
      },
    });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'merged squashed into main through the merge command; cloud-api deploy on push' });
    const [run] = world.hooks.ran;
    assert.deepEqual(run?.argv, MERGE);
    assert.equal(run?.cwd, WORKTREE);
    assert.deepEqual(run?.env, { PATH: '/bin', TEAMRIG_HOST_LOCK: 'lock-1', TEAMRIG_MERGE_BRANCH: 'feat', TEAMRIG_MERGE_BASE: 'main', TEAMRIG_MERGE_HEAD: 'rebased', TEAMRIG_SESSION: 'api' });
    assert.deepEqual(during, { head: 'rebased', lockHeld: true });
    assert.deepEqual(world.steps.ran, [], 'nothing is pushed');
    assert.deepEqual(world.git.log, [
      `fetch ${WORKTREE} origin`,
      `fetch ${WORKTREE} origin`,
      `rebase ${WORKTREE} origin/main`,
      `fetch ${WORKTREE} origin`,
      `deleteRemoteBranch ${WORKTREE} feat`,
      `detach ${WORKTREE}`,
      `deleteBranch ${WORKTREE} feat`,
      `updateLocalBranch ${WORKTREE} origin main`,
    ]);
    assert.ok(world.said.includes('merging feat (rebased) into main through the merge command node merge.ts'));
    assert.ok(world.said.includes('  pull request https://forge/pr/7 merged'));
    const start = { type: 'heavy', id: 'step-1', session: 'api', what: 'merge app: merge feat into main', kind: 'merge', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records(PLACES.ledger), [
      start,
      { ...start, endedAt: '2030-01-08T10:01:00.000Z', exitCode: 0 },
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'api',
        repo: 'app',
        range: 'squashed',
        what: 'merge feat',
        note: 'merged by the merge command into main; cloud-api deploy on push, not watched by teamrig',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:01:00.000Z',
      },
    ]);
    assert.equal(world.files.get(PENDING), undefined);
    assert.ok(world.lockFree());
  });

  it('merges into the merge remote beside origin: rebases onto it and confirms there, deletes the branch on origin, and moves the local main to it', async () => {
    const world = new World({ repos: { app: { ...MERGING, merge: { command: MERGE, remote: 'upstream' } } } });
    world.git.remotes.set('upstream', new Map([['main', 'base']]));
    world.hooks.answer(MERGE, {
      lines: ['pull request https://forge/pr/7 merged'],
      during: async () => {
        world.git.remotes.get('upstream')?.set('main', 'squashed');
        world.git.landed = ['squashed'];
        world.git.diffs.set('squashed..rebased', []);
      },
    });
    assert.deepEqual(await world.run(), { kind: 'done', summary: 'merged squashed into main through the merge command' });
    assert.equal(world.hooks.ran[0]?.env['TEAMRIG_MERGE_BASE'], 'main');
    assert.deepEqual(world.git.log, [
      `fetch ${WORKTREE} upstream`,
      `fetch ${WORKTREE} upstream`,
      `rebase ${WORKTREE} upstream/main`,
      `fetch ${WORKTREE} upstream`,
      `deleteRemoteBranch ${WORKTREE} feat`,
      `detach ${WORKTREE}`,
      `deleteBranch ${WORKTREE} feat`,
      `updateLocalBranch ${WORKTREE} upstream main`,
    ]);
    assert.equal(world.git.origin.get('main'), 'base', 'origin, the fork, is left as it was');
    assert.ok(world.lockFree());
  });

  it('fails before the lock when the merge remote is not a remote of the checkout', async () => {
    const world = new World({ repos: { app: { ...MERGING, merge: { command: MERGE, remote: 'upstream' } } } });
    failed(await world.run(), /git fetch failed: 'upstream' does not appear to be a git repository/);
    assert.deepEqual(world.hooks.ran, []);
    assert.deepEqual(world.git.log, [`fetch ${WORKTREE} upstream`]);
    assert.ok(world.lockFree());
  });

  it('leaves a pending merge when the command waits, frees the lock, keeps the branch and records no deploy', async () => {
    const world = new World({ repos: { app: { ...MERGING, deploysOnPush: ['cloud-api'] } } });
    world.hooks.answer(MERGE, { end: 75, lines: ['checks running with s3cret', 'https://forge/pr/7', ''] });
    assert.deepEqual(await world.run(), { kind: 'waiting', reason: 'https://forge/pr/7' });
    assert.deepEqual(pendingOf(world), WAITED);
    assert.ok(world.lockFree());
    assert.ok(!tidied(world));
    const start = { type: 'heavy', id: 'step-1', session: 'api', what: 'merge app: merge feat into main', kind: 'merge', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records(PLACES.ledger), [start, { ...start, endedAt: '2030-01-08T10:00:00.000Z', exitCode: 75 }]);
    assert.ok(world.said.includes('  checks running with [redacted]'));
    assert.equal(world.said.at(-1), `next: run teamrig merge again in ${WORKTREE} once feat is merged`);
  });

  it('names the command as the reason when it waits without a word', async () => {
    const world = new World({ repos: { app: MERGING } });
    world.hooks.answer(MERGE, { end: 75 });
    assert.deepEqual(await world.run(), { kind: 'waiting', reason: 'the merge command `node merge.ts` says feat waits to merge into main' });
    assert.deepEqual(pendingOf(world), { ...WAITED, note: '' });
  });

  const merges: readonly { readonly name: string; readonly arrange: (world: World) => void; readonly range: string; readonly tip: string }[] = [
    { name: 'a squash merge', arrange: (world) => squashedAs(world, 'squashed'), range: 'squashed', tip: 'squashed' },
    {
      name: 'a merge commit, which makes the branch an ancestor of the default branch',
      arrange: (world) => {
        world.git.origin.set('main', 'mergecommit');
        world.git.ancestry.add('rebased>mergecommit');
        world.git.landed = ['rebased', 'mergecommit'];
        world.git.diffs.set('mergecommit..rebased', []);
      },
      range: 'rebased..mergecom',
      tip: 'mergecom',
    },
    {
      name: 'a rebase merge, with a later commit to other files on the default branch',
      arrange: (world) => {
        world.git.origin.set('main', 'later');
        world.git.landed = ['replayed', 'later'];
        world.git.diffs.set('later..rebased', ['docs/notes.md']);
      },
      range: 'replayed..later',
      tip: 'later',
    },
  ];
  for (const { name, arrange, range, tip } of merges) {
    it(`finishes a waiting merge origin holds without running the command again: ${name}`, async () => {
      const world = new World({ repos: { app: { ...MERGING, deploysOnPush: ['cloud-api'] } } });
      world.hooks.answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] });
      assert.equal((await world.run()).kind, 'waiting');
      world.clock.advance(HALF_HOUR);
      arrange(world);
      assert.deepEqual(await world.run(), { kind: 'done', summary: `merged ${range} into main through the merge command; cloud-api deploy on push` });
      assert.equal(world.hooks.ran.length, 1);
      assert.equal(world.git.log.filter((line) => line.startsWith('rebase')).length, 1);
      assert.ok(world.said.includes(`feat (rebased) is merged into main: origin/main at ${tip} holds it`));
      assert.deepEqual(world.records(PLACES.ledger).at(-1), {
        type: 'deploy',
        kind: 'deploy',
        session: 'api',
        repo: 'app',
        range,
        what: 'merge feat',
        note: 'merged by the merge command into main; cloud-api deploy on push, not watched by teamrig',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:30:00.000Z',
      });
      assert.equal(world.files.get(PENDING), undefined);
      assert.ok(tidied(world));
      assert.ok(world.lockFree());
    });
  }

  it('still refuses a branch with nothing new when no merge of it waits', async () => {
    const world = new World({ repos: { app: MERGING } });
    world.git.heads.set(WORKTREE, 'base');
    refused(await world.run(), /nothing to merge: every commit of feat is already on origin\/main/);
    assert.deepEqual(world.hooks.ran, []);
  });

  it('runs the command again while origin does not hold the waiting merge, and dates the merge from its first run', async () => {
    const world = new World({ repos: { app: { ...MERGING, deploysOnPush: ['cloud-api'] } } });
    world.hooks.answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] }, { end: 75, lines: ['https://forge/pr/7'] }, { during: async () => squashedAs(world, 'squashed') });
    assert.equal((await world.run()).kind, 'waiting');
    world.clock.advance(HALF_HOUR);
    assert.equal((await world.run()).kind, 'waiting');
    assert.deepEqual(pendingOf(world), WAITED);
    world.clock.advance(HALF_HOUR);
    assert.equal((await world.run()).kind, 'done');
    assert.equal(world.hooks.ran.length, 3);
    assert.equal(world.git.log.filter((line) => line.startsWith('rebase')).length, 3);
    assert.deepEqual(world.records(PLACES.ledger).at(-1), {
      type: 'deploy',
      kind: 'deploy',
      session: 'api',
      repo: 'app',
      range: 'squashed',
      what: 'merge feat',
      note: 'merged by the merge command into main; cloud-api deploy on push, not watched by teamrig',
      startedAt: '2030-01-08T10:00:00.000Z',
      rolledAt: '2030-01-08T11:00:00.000Z',
    });
    assert.equal(world.files.get(PENDING), undefined);
  });

  it('runs the command again for a branch with new commits since its merge waited, as a merge of its own', async () => {
    const world = new World({ repos: { app: MERGING } });
    world.hooks.answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] });
    assert.equal((await world.run()).kind, 'waiting');
    world.clock.advance(HALF_HOUR);
    squashedAs(world, 'squashed');
    world.git.heads.set(WORKTREE, 'mine2');
    world.git.rebasedTo = 'rebased2';
    assert.equal((await world.run()).kind, 'waiting');
    assert.equal(world.hooks.ran.length, 2);
    assert.equal(world.hooks.ran[1]?.env['TEAMRIG_MERGE_HEAD'], 'rebased2');
    assert.deepEqual(pendingOf(world), { ...WAITED, head: 'rebased2', base: 'squashed', since: '2030-01-08T10:30:00.000Z' });
    assert.ok(!tidied(world));
  });

  const unmerged: readonly { readonly name: string; readonly arrange: (world: World) => void; readonly since: string }[] = [
    { name: 'origin did not move', arrange: () => undefined, since: 'base' },
    {
      name: 'origin moved with another change to its files',
      arrange: (world) => {
        world.git.origin.set('main', 'other');
        world.git.landed = ['other'];
      },
      since: 'base',
    },
  ];
  for (const { name, arrange, since } of unmerged) {
    it(`fails when the command says it merged but no commit on origin holds the branch, and keeps the branch: ${name}`, async () => {
      const world = new World({ repos: { app: MERGING } });
      world.hooks.answer(MERGE, { lines: ['merged'], during: async () => arrange(world) });
      failed(await world.run(), new RegExp(`^the merge command said feat merged, but no commit on origin/main since ${since} holds its files at rebased$`));
      assert.ok(!tidied(world));
      assert.equal(world.files.get(PENDING), undefined);
      assert.ok(world.lockFree());
    });
  }

  it('fails when the command fails or cannot start, naming its end and last line, and leaves no pending merge', async () => {
    const world = new World({ repos: { app: MERGING } });
    world.hooks.answer(MERGE, { end: 1, lines: ['checks failed: lint', ''] }, { end: { kind: 'notStarted', error: 'ENOENT' } });
    failed(await world.run(), /^the merge command `node merge\.ts` exited 1, so feat is not on main: checks failed: lint$/);
    failed(await world.run(), /^the merge command `node merge\.ts` could not start \(ENOENT\), so feat is not on main$/);
    assert.ok(!tidied(world));
    assert.equal(world.files.get(PENDING), undefined);
    assert.ok(world.lockFree());
  });

  const holds: readonly { readonly name: string; readonly options: Options; readonly arrange: (world: World) => void; readonly end: (end: MergeEnd) => void }[] = [
    {
      name: 'after the queue cutoff',
      options: { repos: { app: MERGING }, start: '2030-01-08T22:45:00Z', schedule: { queueCutoffUtc: '22:30' } },
      arrange: () => undefined,
      end: (end) => refused(end, /queue cutoff 22:30-00:00 UTC/),
    },
    {
      name: 'a lockfile change the dependency gate holds',
      options: { repos: { app: { ...MERGING, dependencyGate: true } } },
      arrange: (world) => {
        world.git.paths = ['package-lock.json'];
      },
      end: (end) => refused(end, /deps changed \(package-lock\.json\): delivery\.repos\.app\.dependencyGate/),
    },
    {
      name: 'a rebase conflict',
      options: { repos: { app: MERGING } },
      arrange: (world) => {
        world.git.rebaseFails = 'conflict in src/app.ts';
      },
      end: (end) => failed(end, /conflict in src\/app\.ts/),
    },
  ];
  for (const { name, options, arrange, end } of holds) {
    it(`runs no merge command on ${name}`, async () => {
      const world = new World(options);
      arrange(world);
      end(await world.run());
      assert.deepEqual(world.hooks.ran, []);
      assert.equal(world.files.get(PENDING), undefined);
      assert.ok(world.lockFree());
    });
  }

  it('runs the dependency check before the command, and no command when the check refuses the change', async () => {
    const CHECK = ['node', 'check-change.ts'];
    const world = new World({ repos: { app: { ...MERGING, dependencyGate: true, dependencyCheck: CHECK } } });
    world.git.paths = ['package-lock.json'];
    world.hooks.answer(CHECK, { end: 3, lines: ['a pin moved'] });
    refused(await world.run(), /the dependency check `node check-change\.ts` exited 3, so feat stays off main/);
    assert.deepEqual(world.hooks.commands, ['node check-change.ts']);
    assert.ok(world.lockFree());
  });
});

describe('merge tidies as far as it can', () => {
  it('warns about each tidy step that failed and still reports the merge', async () => {
    const world = new World();
    world.git.deleteRemoteFails = 'remote rejected';
    world.git.detachFails = 'index.lock exists';
    world.git.localUpdate = { kind: 'failed', reason: 'not a fast-forward' };
    assert.equal((await world.run()).kind, 'done');
    assert.deepEqual(
      world.said.filter((line) => line.startsWith('WARNING')),
      ['WARNING could not delete feat on origin: remote rejected', 'WARNING could not delete the local feat: index.lock exists', "WARNING could not move the local main to origin's: not a fast-forward"],
    );
    assert.ok(!world.git.log.includes(`deleteBranch ${WORKTREE} feat`));
  });

  it('skips a branch already gone from origin and warns when the default branch cannot be checked out', async () => {
    const world = new World();
    world.git.origin.delete('feat');
    world.git.checkouts.set('/solo', { top: '/solo', branch: 'feat', mainCheckout: '/solo', linked: false });
    world.git.heads.set('/solo', 'mine');
    world.git.localUpdate = { kind: 'updated' };
    world.git.checkoutFails = 'would be overwritten';
    assert.equal((await world.run({ ...REQUEST, dir: '/solo' })).kind, 'done');
    assert.ok(!world.git.log.some((line) => line.startsWith('deleteRemoteBranch')));
    assert.ok(world.said.includes('WARNING could not check out main: would be overwritten'));
  });
});

describe('merge under the lock, when the push does not go through', () => {
  it('rebases and pushes again when origin moved during the push', async () => {
    const world = new World();
    let pushes = 0;
    world.steps.whileRunning(async () => {
      pushes += 1;
      if (pushes === 1) {
        world.git.origin.set('main', 'theirs');
        world.git.rebasedTo = 'rebased-2';
        return;
      }
      world.git.pushed('main', world.git.heads.get(WORKTREE) ?? '');
    });
    assert.equal((await world.run()).kind, 'done');
    assert.equal(world.steps.ran.length, 2);
    assert.ok(world.said.includes(`origin's main moved to theirs meanwhile: rebasing and pushing again (attempt 2 of ${PUSH_ATTEMPTS})`));
    assert.deepEqual(world.git.log.filter((line) => line.startsWith('rebase')), [`rebase ${WORKTREE} origin/main`, `rebase ${WORKTREE} origin/main`]);
  });

  it(`gives up after ${PUSH_ATTEMPTS} pushes that origin kept moving under`, async () => {
    const world = new World();
    let moves = 0;
    world.steps.ends(1).whileRunning(async () => {
      moves += 1;
      world.git.origin.set('main', `theirs-${moves}`);
    });
    failed(await world.run(), /^the push exited 1; origin's main is at theirs-3, not at rebased$/);
    assert.equal(world.steps.ran.length, PUSH_ATTEMPTS);
    assert.ok(world.lockFree());
  });

  it('fails when the pre-push hook stops the push, and leaves the branch where it is', async () => {
    const world = new World();
    world.steps.ends(1).whileRunning(async () => undefined);
    failed(await world.run(), /^the push exited 1; origin's main is at base, not at rebased$/);
    assert.equal(world.steps.ran.length, 1);
    assert.ok(!world.git.log.some((line) => line.startsWith('delete') || line.startsWith('detach')));
    assert.equal(world.records(PLACES.ledger).length, 2);
    assert.ok(world.lockFree());
  });

  it('names a push killed at its time limit, stopped by a signal or killed as its shell ended, and an unreadable origin', async () => {
    const world = new World();
    world.steps.ends({ kind: 'timedOut' }).whileRunning(async () => {
      world.git.origin.delete('main');
    });
    failed(await world.run(), /^the push was killed at its time limit \(exit \d+\); origin's main could not be read, not at rebased$/);
    const stopped = new World();
    stopped.steps.ends({ kind: 'signal', signal: 'SIGTERM' }).whileRunning(async () => undefined);
    failed(await stopped.run(), /^the push was stopped by SIGTERM;/);
    const orphaned = new World();
    orphaned.steps.ends({ kind: 'stopped' }).whileRunning(async () => undefined);
    failed(await orphaned.run(), /^the push was killed when its launching shell ended \(exit 129\);/);
  });

  it('records the memory of a push killed as its launching shell ended, from a watch of its tree', async () => {
    const world = new World();
    world.memory.measures({ peakTreeMb: 2400, lowFreeMb: 900, startFreeMb: 7000 });
    world.steps.ends({ kind: 'stopped' }).whileRunning(async () => undefined);
    failed(await world.run(), /^the push was killed when its launching shell ended \(exit 129\);/);
    assert.deepEqual(world.memory.watches, [{ root: 4242, intervalMs: DEFAULT_QUEUE.memorySampleSeconds * 1_000, stopped: true }]);
    const start = { type: 'heavy', id: 'step-1', session: 'api', what: 'merge app: push feat to main', kind: 'merge', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: world.memory.free, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(world.records(PLACES.ledger), [
      start,
      { ...start, endedAt: '2030-01-08T10:00:00.000Z', exitCode: 129, peakTreeMb: 2400, lowFreeMb: 900, startFreeMb: 7000, endFreeMb: world.memory.free },
    ]);
  });

  it('fails on a rebase conflict without pushing, and frees the lock', async () => {
    const world = new World();
    world.git.rebaseFails = 'rebase onto origin/main stopped (conflicts in a.ts); aborted, the branch is as it was';
    failed(await world.run(), /conflicts in a\.ts/);
    assert.deepEqual(world.steps.ran, []);
    assert.ok(world.lockFree());
  });

  it('frees the lock when the push cannot start', async () => {
    const world = new World();
    world.steps.failsWith(new Error('git is not installed'));
    await assert.rejects(world.run(), /git is not installed/);
    assert.ok(world.lockFree());
  });
});

describe('merge waits for what may hold a deploy, and refuses what forbids one', () => {
  const deploying = { app: { ...PLAIN, deploysOnPush: ['cloud-api'] } };
  const freeze = (until: string, targets: readonly string[] = ['cloud-api']): string =>
    JSON.stringify([{ session: 'po', targets, metric: 'p95 latency', why: 'baseline', from: '2030-01-08T09:00:00Z', until }]);

  it('waits out a deploy freeze on what the push deploys, then merges', async () => {
    const world = new World({ repos: deploying, freezes: freeze('2030-01-08T10:05:00Z') });
    assert.equal((await world.run()).kind, 'done');
    assert.ok(world.said.includes('waiting: deploy freeze by po on cloud-api until 2030-01-08 10:05 UTC (p95 latency)'));
    assert.equal(world.steps.ran.length, 1);
    assert.ok(world.clock.now() >= Date.parse('2030-01-08T10:05:00Z'));
    const [start] = world.records(PLACES.ledger);
    const shown = /"queuedAt":"2030-01-08T10:00:00\.000Z","waits":\{"freeze":(\d+)\},"queueFreeMb":8000,"startedAt":"(2030-01-08T10:0[5-9]:[^"]+)"/.exec(JSON.stringify(start));
    assert.ok(shown, 'its record shows the wait from its first look, under the freeze');
    assert.equal(Number(shown[1]), Date.parse(shown[2] ?? '') - Date.parse('2030-01-08T10:00:00Z'), 'all of the wait is the freeze');
  });

  it('sums its wait by cause on the start record: the freeze, then the host lock another step held (T2209)', async () => {
    const world = new World({ repos: deploying, freezes: freeze('2030-01-08T10:05:00Z') });
    await world.files.write(PLACES.hostLock, heldBy('2030-01-08T10:08:00.000Z'));
    assert.equal((await world.run()).kind, 'done');
    const [start] = world.records(PLACES.ledger);
    const shown = /"queuedAt":"2030-01-08T10:00:00\.000Z","waits":\{"lock":(\d+),"freeze":(\d+)\},"queueFreeMb":8000,"startedAt":"([^"]+)"/.exec(JSON.stringify(start));
    assert.ok(shown, 'its start record keeps both causes and the free memory when it queued');
    const [onLock, onFreeze, startedAt] = [Number(shown[1]), Number(shown[2]), Date.parse(shown[3] ?? '')];
    assert.ok(onFreeze >= 5 * 60_000 && onLock > 0 && startedAt >= Date.parse('2030-01-08T10:08:00Z'), JSON.stringify(start));
    assert.equal(onLock + onFreeze, startedAt - Date.parse('2030-01-08T10:00:00Z'), 'the causes sum to the whole wait');
  });

  it('ignores a freeze on other targets, and freezes at all for a repository that deploys nothing', async () => {
    const other = new World({ repos: deploying, freezes: freeze('2030-01-08T12:00:00Z', ['cloud-web']) });
    assert.equal((await other.run()).kind, 'done');
    const quiet = new World({ freezes: 'not json' });
    assert.equal((await quiet.run()).kind, 'done');
    assert.ok(!quiet.said.some((line) => line.startsWith('waiting')));
  });

  it('gives up on a freeze that outlasts the wait, without pushing', async () => {
    const world = new World({ repos: deploying, waitMinutes: 5, freezes: freeze('2030-01-08T12:00:00Z') });
    refused(await world.run(), /deploy freeze by po on cloud-api/);
    assert.deepEqual(world.steps.ran, []);
    assert.ok(world.lockFree());
  });

  it('leaves a refusal record when another step holds the host lock past its wait (T2209)', async () => {
    const world = new World({ repos: deploying, waitMinutes: 1 });
    await world.files.write(PLACES.hostLock, heldBy());
    const end = await world.run();
    refused(end, /^host lock still held by po/);
    const endedAt = world.clock.now();
    assert.deepEqual(world.records(PLACES.ledger), [{
      type: 'refusal',
      id: 'step-1',
      session: 'api',
      what: 'merge app: feat',
      kind: 'merge',
      kit: KIT_VERSION,
      queuedAt: '2030-01-08T10:00:00.000Z',
      endedAt: new Date(endedAt).toISOString(),
      outcome: 'timedOut',
      reason: end.kind === 'refused' ? end.reason : '',
      waits: { lock: endedAt - Date.parse('2030-01-08T10:00:00Z') },
      lastWait: { cause: 'lock', text: 'the host lock: po (heavy: build) since 2030-01-08 09:50 UTC' },
      queueFreeMb: world.memory.free,
      endFreeMb: world.memory.free,
    }]);
    assert.deepEqual(world.steps.ran, []);
  });

  it('names the programs holding the most memory when it refuses after its wait on host memory (T2209)', async () => {
    const world = new World({ repos: deploying, waitMinutes: 1, memoryGated: true });
    world.memory.free = 5000;
    world.memory.holds(BUSY_HOLDERS);
    const end = await world.run();
    const short = 'host memory: 5000 MB free, 8192 MB needed (4096 floor + 4096 for this step)';
    const reason = `host memory still short: ${short}; ${BUSY_HOLDERS_TEXT}`;
    assert.deepEqual(end, { kind: 'refused', reason });
    const endedAt = world.clock.now();
    assert.deepEqual(world.records(PLACES.ledger), [{
      type: 'refusal',
      id: 'step-1',
      session: 'api',
      what: 'merge app: feat',
      kind: 'merge',
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
    assert.deepEqual(world.steps.ran, []);
  });

  it('waits on unreadable freezes, since they may hold the deploy', async () => {
    const world = new World({ repos: deploying, waitMinutes: 1, freezes: '{' });
    refused(await world.run(), /deploy freezes in \/team\/deploys\/claims\.json are unreadable \(not JSON\)/);
  });

  it('refuses after the queue cutoff', async () => {
    const world = new World({ start: '2030-01-08T22:45:00Z', schedule: { queueCutoffUtc: '22:30' } });
    refused(await world.run(), /queue cutoff 22:30-00:00 UTC/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('refuses in the blackout before the weekly reset, and reads the reset only when a blackout is set', async () => {
    const reset: ResetTime = { at: Date.parse('2030-01-08T12:00:00Z'), source: 'status line' };
    const blackout = new World({ schedule: { resetBlackoutHours: 4 }, reset });
    refused(await blackout.run(), /^deploy blackout before the weekly token reset: no deploy from Tue 01-08 08:00 UTC until Tue 01-08 12:00 UTC \(reset from the status line\)$/);
    const before = new World({ schedule: { resetBlackoutHours: 1 }, reset });
    assert.equal((await before.run()).kind, 'done');
    const unset = new World({ reset });
    assert.equal((await unset.run()).kind, 'done');
    assert.equal(unset.resetReads, 0);
  });
});

describe('merge follows the main checkout where the repository asks for it', () => {
  const following = { app: { ...PLAIN, updateMainCheckout: true } };

  it('fast-forwards a clean main checkout on the default branch to what merged', async () => {
    const world = new World({ repos: following });
    world.git.status.set(MAIN_CHECKOUT, ['?? notes.txt']);
    assert.equal((await world.run()).kind, 'done');
    assert.ok(world.git.log.includes(`fastForward ${MAIN_CHECKOUT} rebased`));
    assert.ok(world.said.includes(`fast-forwarded the main checkout ${MAIN_CHECKOUT} to rebased`));
    assert.ok(!world.said.some((line) => line.includes('npm ci')));
  });

  it('says to install when what it fast-forwarded over changes the lockfile', async () => {
    const world = new World({ repos: following });
    world.git.paths = ['package-lock.json'];
    assert.equal((await world.run()).kind, 'done');
    assert.ok(world.said.includes(`NOTE package-lock.json changed: run npm ci --ignore-scripts in ${MAIN_CHECKOUT}`));
  });

  const kept: readonly { readonly name: string; readonly arrange: (world: World) => void; readonly note: string }[] = [
    {
      name: 'on another branch',
      arrange: (world) => world.git.checkouts.set(MAIN_CHECKOUT, { top: MAIN_CHECKOUT, branch: 'spike', mainCheckout: MAIN_CHECKOUT, linked: false }),
      note: 'it is on spike, not main',
    },
    { name: 'with tracked changes', arrange: (world) => world.git.status.set(MAIN_CHECKOUT, [' M a.ts']), note: 'it has uncommitted changes' },
    { name: 'where git status fails', arrange: (world) => world.git.statusFails.add(MAIN_CHECKOUT), note: 'git status failed there' },
    { name: 'with commits of its own', arrange: (world) => world.git.heads.set(MAIN_CHECKOUT, 'local'), note: 'its main has commits that are not on origin' },
    { name: 'when the fast-forward fails', arrange: (world) => (world.git.fastForwardFails = 'not possible to fast-forward'), note: 'not possible to fast-forward' },
  ];
  for (const { name, arrange, note } of kept) {
    it(`leaves it as it is ${name}`, async () => {
      const world = new World({ repos: following });
      arrange(world);
      assert.equal((await world.run()).kind, 'done');
      assert.ok(world.said.includes(`NOTE left the main checkout ${MAIN_CHECKOUT} as it is: ${note}`), world.said.join('\n'));
    });
  }

  it('says to check the install itself when it cannot read what the fast-forward changed', async () => {
    const world = new World({ repos: following });
    world.git.paths = undefined;
    assert.equal((await world.run()).kind, 'done');
    assert.ok(world.said.includes(`NOTE could not read what the fast-forward changed: check whether ${MAIN_CHECKOUT} needs npm ci --ignore-scripts`));
  });

  it('does not follow from the main checkout itself', async () => {
    const world = new World({ repos: following });
    world.git.checkouts.set('/repo/app', { top: '/repo/app', branch: 'feat', mainCheckout: '/repo/app', linked: false });
    world.git.heads.set('/repo/app', 'mine');
    assert.equal((await world.run({ ...REQUEST, dir: '/repo/app' })).kind, 'done');
    assert.ok(!world.git.log.some((line) => line.startsWith('fastForward')));
  });
});

describe('mergeBranch with the review gate', () => {
  const REVIEW_CHECK = ['node', 'review.js'];
  const REVIEW: ReviewGateSetup = { reviewPaths: [{ glob: 'src/**', mode: 'check', class: 'security' }], tree: new LeadTree(testConfig()), roles: { securityReviewer: 'bravo' } };
  const ALPHA: MergeRequest = { ...REQUEST, session: 'alpha' };

  function gatedWorld(config: Partial<DeliveryRepoConfig> = {}): World {
    const world = new World({ repos: { app: { ...PLAIN, reviewGate: true, ...config } }, review: REVIEW });
    world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't9-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    world.tasks.set('T9', { owner: 'alpha', priority: 1, status: 'in-progress', answer: null });
    return world;
  }

  function reviewChecks(world: World): string[] {
    return world.records(PLACES.ledger).map((record) => JSON.stringify(record)).filter((text) => text.includes('review check of t9-feat'));
  }

  it('holds a lockfile change for its reviewer, pushing nothing, then lands it once approved and drops the hold', async () => {
    const world = gatedWorld();
    world.git.paths = ['package-lock.json'];
    refused(await world.run(ALPHA), /^review hold H\w+ keeps t9-feat \(base\.\.rebased\) off the default branch: .* --waits approval:bravo /);
    assert.deepEqual(world.steps.ran, []);
    assert.ok(world.lockFree());
    world.clock.advance(60_000);
    world.tasks.set('T9', { owner: 'alpha', priority: 1, status: 'waiting', answer: { verdict: 'approved', by: 'bravo', at: new Date(world.clock.now()).toISOString(), note: null } });
    world.clock.advance(60_000);
    assert.equal((await world.run(ALPHA)).kind, 'done');
    assert.equal(world.steps.ran.length, 1);
    assert.equal(await world.reviewHolds.read('app', 't9-feat'), undefined);
  });

  it('runs the review check as a queued step under the host lock, against the base it rebased onto, its lines redacted', async () => {
    const world = gatedWorld({ reviewCheck: REVIEW_CHECK });
    world.git.paths = ['src/app.ts'];
    world.hooks.answer(REVIEW_CHECK, { lines: ['token s3cret looks fine'] });
    assert.equal((await world.run(ALPHA)).kind, 'done');
    const [run] = world.hooks.ran;
    assert.deepEqual([run?.argv, run?.cwd, run?.env[REVIEW_BASE_ENV], run?.env['TEAMRIG_HOST_LOCK']], [REVIEW_CHECK, WORKTREE, 'base', 'lock-1']);
    assert.ok(world.said.includes('  token [redacted] looks fine'));
    const checks = reviewChecks(world);
    assert.equal(checks.length, 2);
    assert.match(checks[1] ?? '', /"exitCode":0/);
  });

  it('records a flagging check with its exit code and holds the change with its findings', async () => {
    const world = gatedWorld({ reviewCheck: REVIEW_CHECK });
    world.git.paths = ['src/app.ts'];
    world.hooks.answer(REVIEW_CHECK, { lines: ['token in src/app.ts'], end: 3 });
    refused(await world.run(ALPHA), /the review check flagged it/);
    assert.equal((await world.reviewHolds.read('app', 't9-feat'))?.findings, 'token in src/app.ts');
    assert.match(reviewChecks(world)[1] ?? '', /"exitCode":3/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('holds a change of a repository with a merge command before the command runs', async () => {
    const MERGE = ['node', 'merge.ts'];
    const world = gatedWorld({ merge: { command: MERGE, remote: 'origin' } });
    world.git.paths = ['package-lock.json'];
    refused(await world.run(ALPHA), /^review hold H\w+ keeps t9-feat \(base\.\.rebased\) off the default branch: .* --waits approval:bravo /);
    assert.deepEqual(world.hooks.ran, []);
    assert.ok(world.lockFree());
  });
});

describe('mergeBranch under pushToProtected: gated', () => {
  const GATED: GatedSetup = { tree: new LeadTree(testConfig()), roles: {}, commits: DEFAULT_COMMITS };
  const ALPHA: MergeRequest = { ...REQUEST, session: 'alpha' };
  /** The pass record of the tree the rebase makes, as the repo's local checks write it in the main checkout's git dir. */
  const PASS: PassRecord = { tree: 'tree-rebased', commit: 'rebased', checks: ['unit', 'lint'], passedAt: '2030-01-08T09:30:00.000Z', node: 'v24.0.0' };
  /** What every merges row of the change keeps, but when it landed and how. */
  const LANDED = { session: 'alpha', repo: 'app', branch: 't9-feat', task: 'T9', base: 'base', head: 'rebased', tree: 'tree-rebased', files: 2, lines: 32 };

  /** T9 is alpha's and in progress; its branch lands in a repo whose review gate is on, under `gated`. */
  function gatedWorld(config: Partial<DeliveryRepoConfig> = {}, review: ReviewGateSetup = NO_REVIEW): World {
    const world = new World({ repos: { app: { ...PLAIN, reviewGate: true, ...config } }, review, gated: GATED });
    world.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't9-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    world.tasks.set('T9', { owner: 'alpha', priority: 1, status: 'in-progress', answer: null });
    return world;
  }

  function passed(world: World): Promise<void> {
    return world.files.write(passRecordPath(WORKTREE, `${MAIN_CHECKOUT}/.git`, PASS.tree), JSON.stringify(PASS));
  }

  async function mergeRows(world: World): Promise<readonly unknown[]> {
    return (await world.merges.read()).records.map(({ at, ...row }) => {
      assert.match(at, /^\d{4}-\d\d-\d\dT/);
      return row;
    });
  }

  it('merges a change that holds every gate with no approval, and logs it as a self-merge', async () => {
    const world = gatedWorld();
    await passed(world);
    assert.equal((await world.run(ALPHA)).kind, 'done');
    assert.equal(world.steps.ran.length, 1);
    assert.ok(world.said.includes('self-merge gates of t9-feat: every gate holds, so it merges with no approval'), world.said.join('\n'));
    assert.deepEqual(await mergeRows(world), [{ ...LANDED, checks: ['unit', 'lint'], review: 'untouched', route: 'self' }]);
    assert.equal(await world.gateHolds.read('app', 't9-feat'), undefined);
  });

  it('logs a change only the review check cleared as checked, the self-merges security samples', async () => {
    const check = ['node', 'review.js'];
    const review: ReviewGateSetup = { reviewPaths: [{ glob: 'src/**', mode: 'check', class: 'security' }], tree: GATED.tree, roles: { securityReviewer: 'bravo' } };
    const world = gatedWorld({ reviewCheck: check }, review);
    world.git.paths = ['src/app.ts'];
    world.hooks.answer(check, { lines: [] });
    await passed(world);
    assert.equal((await world.run(ALPHA)).kind, 'done');
    assert.deepEqual(await mergeRows(world), [{ ...LANDED, checks: ['unit', 'lint'], review: 'checked', route: 'self' }]);
  });

  it("holds a change with no pass record for alpha's leader, pushing nothing and freeing the lock", async () => {
    const world = gatedWorld();
    refused(await world.run(ALPHA), /^gate hold G\w+ keeps t9-feat \(base\.\.rebased\) off the default branch: pass: no pass record proves the rebased tree /);
    assert.equal((await world.gateHolds.read('app', 't9-feat'))?.reviewer, 'lead');
    assert.deepEqual(world.steps.ran, []);
    assert.ok(world.lockFree());
    assert.deepEqual(await mergeRows(world), []);
  });

  it('lands the held change once the leader approved it, logging the gates it missed, and drops the hold', async () => {
    const world = gatedWorld();
    refused(await world.run(ALPHA), /^gate hold /);
    world.clock.advance(60_000);
    world.tasks.set('T9', { owner: 'alpha', priority: 1, status: 'waiting', answer: { verdict: 'approved', by: 'lead', at: new Date(world.clock.now()).toISOString(), note: null } });
    world.clock.advance(60_000);
    assert.equal((await world.run(ALPHA)).kind, 'done');
    assert.equal(world.steps.ran.length, 1);
    assert.deepEqual(await mergeRows(world), [{ ...LANDED, checks: [], review: 'untouched', route: 'approved', missed: ['pass'], approvedBy: 'lead' }]);
    assert.equal(await world.gateHolds.read('app', 't9-feat'), undefined);
  });

  it('counts a repo with its review gate off as a missed review', async () => {
    const world = gatedWorld({ reviewGate: false });
    await passed(world);
    refused(await world.run(ALPHA), /off the default branch: review: delivery\.repos\.app\.reviewGate is off/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('holds a change whose commits git cannot read', async () => {
    const world = gatedWorld();
    await passed(world);
    world.commits = undefined;
    refused(await world.run(ALPHA), /^could not read the commits of t9-feat against base/);
    assert.deepEqual(world.steps.ran, []);
  });

  it('weighs nothing and logs nothing when the push guard is not gated', async () => {
    const world = new World({ repos: { app: PLAIN } });
    assert.equal((await world.run(ALPHA)).kind, 'done');
    assert.equal(world.files.get(PLACES.merges), undefined);
    assert.ok(!world.files.paths().some((path) => path.includes('gate-holds')), world.files.paths().join('\n'));
  });
});
