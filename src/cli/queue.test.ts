import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FIRST_IN_LINE_POLL_MS } from '../delivery/host-lock.ts';
import type { QueuedStepRecord, RefusalOutcome, RefusalRecord } from '../delivery/ledger.ts';
import { lineFrontPath, LineFrontStore } from '../delivery/line-front-store.ts';
import { isRecord } from '../core/guards.ts';
import { recordPass } from '../delivery/push-pass.ts';
import { parkedDirOf, parseParked, PARKED_SUFFIX, type ParkedStep } from '../delivery/parked.ts';
import { KIT_VERSION } from '../core/version.ts';
import { APP, CliHarness, CONFIG_PATH, KIT, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { cleanTree, FakeTrees, GIT_DIR } from '../testing/fake-trees.ts';
import { CLAUDE, FakeStarterWatch, SHELL } from '../testing/fake-starter-watch.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { SHIP_TOOL_READS, SHIP_TOOL_REREAD_MS } from './ship-role-check.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { heldBy, OTHER, otherRuns } from '../testing/held-lock.ts';
import { lineRequests } from '../testing/line-tickets.ts';
import { ROOMY_FREE_MB } from '../testing/quiet-world.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const SHARED = `${LOCK}.shared`;
const MINUTE = 60_000;
const PIPELINE_FREEZES = join(KIT, 'pipeline-freezes.json');
/** The refusal under {@link pipelineFreezes}' freeze. */
const FROZEN = 'the pipeline is frozen until 2030-01-08 12:00 UTC by po (PC down; F1); no new step starts until then. The lead or the delivery owner ends it early with: teamrig pipeline unfreeze F1';

/** The pipeline freezes file holding F1 by po from `from` until 12:00 UTC, on `kinds` (every kind when absent). */
function pipelineFreezes(freeze: { readonly from: string; readonly kinds?: readonly string[] }): string {
  return JSON.stringify([{ id: 'F1', session: 'po', to: '2030-01-08T12:00:00.000Z', reason: 'PC down', at: '2030-01-08T08:00:00.000Z', ...freeze }]);
}

/** The team config naming admission `serial`, where a heavy step takes the lock file. */
const SERIAL = { ...TEAM, delivery: { queue: { admission: 'serial' } } };

/** The team config naming admission `pipeline`, the default, where a heavy step shares the host. */
const PIPELINE = { ...TEAM, delivery: { queue: { admission: 'pipeline' } } };

/** The line of a heavy step admitted at `stamp` as the only heavy share, its 2048 MB held, with roomy free memory. */
function heavyShared(stamp: string): string {
  return `${stamp} sharing the host as a heavy step: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other heavy steps)`;
}

function ledgerOf(kit: CliHarness, path: string = LEDGER): unknown[] {
  return (kit.files.get(path) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

function harness(config: Readonly<Record<string, unknown>> = TEAM): { kit: CliHarness; steps: FakeSteps } {
  const kit = new CliHarness(config);
  return { kit, steps: new FakeSteps(kit.clock) };
}

const BUILD = ['queue', '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'];

/** A queued step's label and the kind of work its command does. */
type Step = Pick<RefusalRecord, 'what' | 'kind'>;

const BUILD_STEP: Step = { what: 'build api', kind: 'build' };
const SPECS_STEP: Step = { what: 'specs', kind: 'test' };

/** The refusal record of alpha's `step`, which began to wait at 10:00 with `freeMb` free and ended without running, the free memory unchanged. */
function refused(step: Step, freeMb: number, end: Pick<RefusalRecord, 'endedAt' | 'outcome' | 'reason' | 'waits' | 'lastWait'>): RefusalRecord {
  return { type: 'refusal', id: 'id-2', session: 'alpha', ...step, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', ...end, queueFreeMb: freeMb, endFreeMb: freeMb };
}

/** The refusal record of alpha's `build api`, which waited on po's lock (`heldBy`) until `endedAt` and did not run. */
function buildRefused(endedAt: string, lockMs: number, outcome: RefusalOutcome, reason: string): RefusalRecord {
  const lastWait = { cause: 'lock', text: 'waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC' } as const;
  return refused(BUILD_STEP, ROOMY_FREE_MB, { endedAt, outcome, reason, waits: { lock: lockMs }, lastWait });
}

/** The refusal record of alpha's `step`, refused at 10:01 after a minute's wait on host memory stuck at `freeMb`: `waiting` starts its wait line. */
function memoryRefused(step: Step, freeMb: number, waiting: string, short: string): RefusalRecord {
  const lastWait = { cause: 'memory', text: `${waiting}: ${short}` } as const;
  return refused(step, freeMb, { endedAt: '2030-01-08T10:01:00.000Z', outcome: 'timedOut', reason: `host memory still short: ${short}`, waits: { memory: MINUTE }, lastWait });
}

const SPECS = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--', 'npm', 'test'];

/** A small step sharing the host: po's spec run, taken at 09:50 by `OTHER`, 2048 MB held for it. */
function sharedBy(): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 });
}

/** A small step of alpha's own sharing the host: `purpose`, taken at 09:50 by `OTHER` under `token`, 2048 MB held for it. */
function ownShare(token: string, purpose: string): string {
  return JSON.stringify({ token, pid: OTHER, session: 'alpha', purpose, kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 });
}

/** A heavy step of alpha's own sharing the host under pipeline admission: as {@link ownShare}, marked heavy. */
function ownHeavyShare(token: string, purpose: string): string {
  return JSON.stringify({ token, pid: OTHER, session: 'alpha', purpose, kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048, heavy: true });
}

/** What else an earlier run recorded: its kind of work, and the host's free memory when it started and at its lowest. */
type RanAlso = Partial<Pick<QueuedStepRecord, 'kind' | 'startFreeMb' | 'lowFreeMb'>>;

/** An ended run of `what` by `session` the day before, whose process tree held `peakTreeMb` at most, with `also`. */
function ranBefore(session: string, what: string, peakTreeMb: number, also: RanAlso = {}): string {
  return JSON.stringify({ type: 'heavy', id: `${session}-${peakTreeMb}`, session, what, ...also, startedAt: '2030-01-07T10:00:00.000Z', endedAt: '2030-01-07T10:05:00.000Z', exitCode: 0, peakTreeMb });
}

describe('teamrig queue', () => {
  it('shares the host as a heavy step under the default admission, pipeline, its share marked heavy and the lock file free, recorded as not shared (T2250)', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [kit.files.get(LOCK), JSON.parse(kit.files.get(`${SHARED}/id-1.json`) ?? '{}')];
    });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 0, stdout: [heavyShared('2030-01-08 10:00:02 UTC'), '2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    const request = { kind: 'build', class: 'Improvements', classPct: 15, needMb: 2048, heavy: true, exclusive: false };
    const share = { id: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: build api', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z', reserveMb: 2048, heavy: true, request };
    assert.deepEqual(whileRunning, [undefined, share]);
    assert.equal(kit.files.get(`${SHARED}/id-1.json`), undefined, 'the share is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }], 'a heavy share is not recorded as shared: that marks a small step');
  });

  it('reads the heavy cap again at each look, so a step waiting on it is let in once the team raises maxHeavyParallel (T2942)', async () => {
    const capped = (maxHeavyParallel: number): Readonly<Record<string, unknown>> => ({ ...TEAM, delivery: { queue: { maxHeavyParallel } } });
    const { kit, steps } = harness(capped(1));
    const share = { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048, heavy: true };
    await kit.files.write(`${SHARED}/other.json`, JSON.stringify(share));
    let raised = false;
    const sleep = async (ms: number): Promise<void> => {
      if (!raised) {
        raised = true;
        await kit.files.write(CONFIG_PATH, JSON.stringify(capped(2)));
      }
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(BUILD, { steps, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: 1 heavy step running, the cap 1: po (heavy: specs) since 2030-01-08 09:50 UTC',
        '2030-01-08 10:00:06 UTC sharing the host as a heavy step: 2048 MB held for it (16000 MB free, 1 other heavy step)',
        '2030-01-08 10:00:06 UTC running: build api (killed after 45m)',
        'DONE exit 0',
      ],
      stderr: [],
    });
    assert.equal(steps.ran.length, 1);
  });

  it('runs the command under the host lock with delivery.queue.admission serial, records its start and end, and prints DONE', async () => {
    const { kit, steps } = harness(SERIAL);
    let lockWhileRunning: unknown;
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      lockWhileRunning = JSON.parse(kit.files.get(LOCK) ?? '{}');
    });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 0, stdout: ['2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual(lockWhileRunning, {
      id: 'id-1',
      pid: 4242,
      session: 'alpha',
      purpose: 'heavy: build api',
      kit: KIT_VERSION,
      acquiredAt: '2030-01-08T10:00:02.000Z',
      expiresAt: '2030-01-08T12:30:02.000Z',
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('runs the command line in the shell, in the current folder with the environment as it is, limited to 45 minutes', async () => {
    const { kit, steps } = harness();
    await kit.run(['queue', '--session', 'alpha', '--what', 'tests', '--', 'node', '--test', 'src/**/*.test.ts'], { steps, env: { PROBE: 'yes' } });
    const [request] = steps.ran;
    assert.equal(request?.command, "node --test 'src/**/*.test.ts'");
    assert.equal(request?.cwd, APP);
    assert.equal(request?.env['PROBE'], 'yes');
    assert.equal(request?.timeoutMs, 45 * MINUTE);
  });

  it('starts the command without the credential variables delivery.passEnv does not name', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { passEnv: ['NPM_TOKEN'] } });
    const env = { PROBE: 'yes', GH_TOKEN: 'not-a-real-credential', NPM_TOKEN: 'not-a-real-credential' };
    await kit.run(['queue', '--session', 'alpha', '--what', 'install', '--', 'npm', 'ci'], { steps, env });
    const [request] = steps.ran;
    assert.deepEqual([request?.env['PROBE'], request?.env['GH_TOKEN'], request?.env['NPM_TOKEN']], ['yes', undefined, 'not-a-real-credential']);
  });

  it('prints FAILED with the exit code and records it', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends(3) });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED exit 3']);
    assert.deepEqual(ledgerOf(kit).map((record) => JSON.stringify(record).includes('"exitCode":3')), [false, true]);
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('prints TIMED OUT for a step killed at its limit, recorded as exit 124', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends({ kind: 'timedOut' }, 45 * MINUTE) });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        heavyShared('2030-01-08 10:00:02 UTC'),
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
        '2030-01-08 10:45:02 UTC timed out after 45m: killed its process tree',
        'TIMED OUT killed, recorded as exit 124',
      ],
      stderr: [],
    });
    assert.deepEqual(ledgerOf(kit)[1], { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: '2030-01-08T10:45:02.000Z', exitCode: 124, endFreeMb: ROOMY_FREE_MB });
  });

  it('prints FAILED for a step a signal stopped, recorded as exit 1', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends({ kind: 'signal', signal: 'SIGTERM' }) });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED stopped by SIGTERM, recorded as exit 1']);
  });

  it('records a step that could not start as exit 1 and releases the lock', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.failsWith(new Error('spawn cmd.exe ENOENT')) });
    assert.deepEqual([result.code, result.stderr], [1, ['FAILED spawn cmd.exe ENOENT']]);
    assert.deepEqual(ledgerOf(kit).map((record) => JSON.stringify(record).endsWith('"exitCode":1}')), [false, true]);
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('kills the step after --max-minutes', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'replay', '--max-minutes', '90', '--', 'npm', 'run', 'replay'], { steps });
    assert.equal(result.stdout[1], '2030-01-08 10:00:02 UTC running: replay (killed after 1h30m)');
    assert.equal(steps.ran[0]?.timeoutMs, 90 * MINUTE);
  });

  for (const minutes of ['0', '141', '1.5', 'soon']) {
    it(`refuses --max-minutes ${minutes} before taking the lock`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(['queue', '--session', 'alpha', '--what', 'replay', '--max-minutes', minutes, '--', 'npm', 'test'], { steps });
      assert.equal(result.code, 64);
      assert.match(result.stderr.join('\n'), /--max-minutes is a whole number from 1 to 140 \(delivery\.queue\.lockTtlMinutes less 10\)/);
      assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
    });
  }

  it('refuses from the queue cutoff on, before taking the lock', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED queue cutoff 09:30-00:00 UTC (now 10:00 UTC)'], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it("names the cutoff on the team's clock", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    const result = await kit.run(BUILD, { steps, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED queue cutoff 11:30-02:00 IST (now 12:00 IST)'], stderr: [] });
  });

  it("stamps its progress lines on the team's clock", async () => {
    const { kit, steps } = harness();
    steps.ends(0, MINUTE);
    const result = await kit.run(BUILD, { steps, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result.stdout, [heavyShared('2030-01-08 12:00:02 IST'), '2030-01-08 12:00:02 IST running: build api (killed after 45m)', 'DONE exit 0']);
  });

  it('waits for a held lock, and refuses when the wait ran past the cutoff, recording its refusal, with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '10:30' }, queue: { admission: 'serial' } } });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', 'REFUSED queue cutoff 10:30-00:00 UTC (now 10:40 UTC)'],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:40:02.000Z', 40 * MINUTE + FIRST_IN_LINE_POLL_MS, 'refused', 'queue cutoff 10:30-00:00 UTC (now 10:40 UTC)');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit)], [[], undefined, [refusal]]);
  });

  it('refuses under a pipeline freeze on its kind before taking the lock, and runs under one on other kinds', async () => {
    const { kit, steps } = harness();
    await kit.files.write(PIPELINE_FREEZES, pipelineFreezes({ from: '2030-01-08T09:00:00.000Z', kinds: ['build'] }));
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 2, stdout: [`REFUSED ${FROZEN}`], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
    await kit.files.write(PIPELINE_FREEZES, pipelineFreezes({ from: '2030-01-08T09:00:00.000Z', kinds: ['merge'] }));
    steps.ends(0, MINUTE);
    assert.equal((await kit.run(BUILD, { steps })).code, 0);
  });

  it('refuses every step while the pipeline freezes file is unreadable', async () => {
    const { kit, steps } = harness();
    await kit.files.write(PIPELINE_FREEZES, '[{');
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 2, stdout: [`REFUSED the pipeline freezes in ${PIPELINE_FREEZES} are unreadable (not JSON), so no new step starts until the file reads or is removed`], stderr: [] });
  });

  it('refuses, recording its refusal, a step whose wait ran into a pipeline freeze, with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness(SERIAL);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    await kit.files.write(PIPELINE_FREEZES, pipelineFreezes({ from: '2030-01-08T10:30:00.000Z' }));
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result.stdout.at(-1), `REFUSED ${FROZEN}`);
    const refusal = buildRefused('2030-01-08T10:40:02.000Z', 40 * MINUTE + FIRST_IN_LINE_POLL_MS, 'refused', FROZEN);
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit)], [[], undefined, [refusal]]);
  });

  it('refuses when the lock is still held after the wait, leaving it to its holder and recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', 'REFUSED host lock still held by po (heavy: build) since 2030-01-08 09:50 UTC'],
      stderr: [],
    });
    assert.deepEqual(kit.clock.sleeps, Array.from({ length: MINUTE / FIRST_IN_LINE_POLL_MS }, () => FIRST_IN_LINE_POLL_MS), 'the first in line looks every 2 s');
    assert.equal(kit.files.get(LOCK), heldBy());
    assert.deepEqual(ledgerOf(kit), [buildRefused('2030-01-08T10:01:00.000Z', MINUTE, 'timedOut', 'host lock still held by po (heavy: build) since 2030-01-08 09:50 UTC')]);
  });

  it('refuses, running nothing and recording its refusal, when its ticket is withdrawn while it waits, leaving the lock to its holder', async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const queue = `${LOCK}.queue`;
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      for (const name of await kit.files.list(queue)) {
        await kit.files.remove(join(queue, name));
      }
    };
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), sleep });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', "REFUSED withdrawn from the host lock's line (teamrig withdraw): build api did not run"],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:00:02.000Z', 2_000, 'withdrawn', "withdrawn from the host lock's line (teamrig withdraw): build api did not run");
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit), await kit.files.list(queue)], [[], heldBy(), [refusal], []]);
  });

  it('records when the step began to wait, how long the lock held it, and what its process tree and the host held while it ran', async () => {
    const { kit, steps } = harness();
    steps.ends(0, 5 * MINUTE);
    const memory = new FakeHostMemory(ROOMY_FREE_MB).measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    assert.equal((await kit.run(BUILD, { steps, memory, sessionProcesses: otherRuns() })).code, 0);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }], "its own process's tree, every 15 s");
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', waits: { lock: 3 * MINUTE + 2_000 }, queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:03:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:08:02.000Z', exitCode: 0, peakTreeMb: 1900, lowFreeMb: 6400 }]);
  });

  it('watches no memory when the config samples it every 0 seconds', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { memorySampleSeconds: 0 } } });
    const memory = new FakeHostMemory(ROOMY_FREE_MB).measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    assert.equal((await kit.run(BUILD, { steps, memory })).code, 0);
    assert.deepEqual(memory.watches, []);
    assert.equal(ledgerOf(kit).some((record) => JSON.stringify(record).includes('peakTreeMb')), false);
  });

  it("stops waiting for the lock once the shell that started it ended in a person's own terminal, leaving the lock to its holder and recording its refusal", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch([SHELL]);
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end();
    };
    const result = await kit.run(BUILD, { steps, starters, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
        '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: no one waits for it any more',
        "STOPPED before the host lock was free: nothing ran; re-run the same command in the background with no human's OK, unless you or the human stopped it on purpose",
      ],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:00:02.000Z', 2_000, 'stopped', 'its launching shell ended (bash.exe 4100) while it waited');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit), starters.openWatches], [[], heldBy(), [refusal], 0]);
  });

  it('kills a running step once the shell that started it ended, records exit 129 and frees the lock with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness(SERIAL);
    const starters = new FakeStarterWatch();
    steps.ends(0, MINUTE).whileRunning(async () => starters.end());
    const result = await kit.run(BUILD, { steps, starters });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
        '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100): killed its process tree',
        "STOPPED killed, recorded as exit 129; re-run the same command in the background with no human's OK, unless you or the human stopped it on purpose or its part run changed stored data",
      ],
      stderr: [],
    });
    assert.equal(steps.ran[0]?.stop?.aborted, true);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:00:02.000Z', exitCode: 129, endFreeMb: ROOMY_FREE_MB }]);
    assert.deepEqual([kit.files.get(LOCK), starters.openWatches], [undefined, 0]);
  });

  it("kills a step run under its parent's lock once its shell ended, leaving the parent's lock", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch([SHELL]);
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'pre-commit checks', '--', 'npm', 'test'], {
      steps: steps.whileRunning(async () => starters.end(SHELL)),
      starters,
      sessionProcesses: otherRuns(),
      env: { TEAMRIG_HOST_LOCK: 'other' },
    });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK), starters.openWatches], [1, "STOPPED killed, recorded as exit 129; re-run the same command in the background with no human's OK, unless you or the human stopped it on purpose or its part run changed stored data", heldBy(), 0]);
  });

  it('says when it cannot list the processes that started it, and runs the step as usual', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps, starters: new FakeStarterWatch([]) });
    assert.deepEqual(result.stdout, [
      '2030-01-08 10:00:00 UTC could not list the processes that started this one: the step runs on if its shell ends',
      heavyShared('2030-01-08 10:00:02 UTC'),
      '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
      'DONE exit 0',
    ]);
  });

  it('takes over a lock its process left behind with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness(SERIAL);
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK)], [0, 'DONE exit 0', undefined]);
  });

  it("gives its command the lock's id, so a queued step the command starts runs under this lock", async () => {
    const { kit, steps } = harness();
    await kit.run(BUILD, { steps });
    assert.equal(steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], 'id-1');
  });

  it("runs a step its parent's live lock covers at once, in the parent's session, without a ledger record", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(['queue', '--what', 'pre-commit checks', '--', 'npm', 'test'], {
      steps: steps.ends(0, MINUTE),
      sessionProcesses: otherRuns(),
      env: { TEAMRIG_HOST_LOCK: 'other' },
    });
    assert.deepEqual(result, {
      code: 0,
      stdout: ['2030-01-08 10:00:00 UTC running: pre-commit checks under the host lock of po (heavy: build) since 2030-01-08 09:50 UTC (killed after 45m)', 'DONE exit 0'],
      stderr: [],
    });
    assert.deepEqual([steps.ran.length, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], kit.clock.sleeps], [1, 'other', []]);
    assert.deepEqual([kit.files.get(LOCK), kit.files.get(LEDGER)], [heldBy(), undefined], "the parent's lock stays, and its record covers the step");
  });

  it('runs under a parent lock even from the queue cutoff on, since its parent started before it', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.deepEqual([result.code, steps.ran.length], [0, 1]);
  });

  /** The lock taken carries its ticket's id, also when taking it first removes a lock left behind. */
  for (const [label, lock] of [
    ['a lock its process left behind', heldBy()],
    ['no lock at all', undefined],
  ] as const) {
    it(`takes the lock as usual when $TEAMRIG_HOST_LOCK names ${label}, with delivery.queue.admission serial`, async () => {
      const { kit, steps } = harness(SERIAL);
      if (lock !== undefined) {
        await kit.files.write(LOCK, lock);
      }
      const result = await kit.run(BUILD, { steps, env: { TEAMRIG_HOST_LOCK: 'other' } });
      assert.deepEqual(result.stdout.slice(0, 2), [
        '2030-01-08 10:00:00 UTC $TEAMRIG_HOST_LOCK names no live host lock: taking the lock as usual',
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
      ]);
      assert.deepEqual([result.code, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], ledgerOf(kit).length], [0, 'id-1', 2]);
    });
  }

  it('waits for a live lock whose id is not the one in $TEAMRIG_HOST_LOCK', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'someone-else' } });
    assert.deepEqual([result.code, steps.ran, kit.files.get(LOCK)], [2, [], heldBy()]);
  });

  it('takes the session this Claude Code tab is bound to when none is named', async () => {
    const { kit, steps } = harness();
    const tab = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' };
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: tab });
    const result = await kit.run(['queue', '--what', 'pre-commit checks', '--', 'npm', 'test'], { steps, env: tab });
    assert.equal(result.code, 0);
    assert.deepEqual(
      ledgerOf(kit).map((record) => JSON.stringify(record).includes('"session":"alpha"')),
      [true, true],
    );
  });

  it('prints the usage when no session is named and the tab is bound to none', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--what', 'build', '--', 'npm', 'test'], { steps, env: { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' } });
    assert.deepEqual([result.code, steps.ran], [64, []]);
  });

  it("keeps the lock and ledger where the team's config puts them", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { dir: 'data/deploys', queue: { lockPath: 'data/deploys/host.lock', admission: 'serial' } } });
    const lock = join(TEAM_HOME, 'data', 'deploys', 'host.lock');
    let lockWhileRunning: string | undefined;
    steps.whileRunning(async () => {
      lockWhileRunning = kit.files.get(lock);
    });
    await kit.run(BUILD, { steps });
    assert.equal(JSON.parse(lockWhileRunning ?? '{}').session, 'alpha');
    assert.equal(ledgerOf(kit, join(TEAM_HOME, 'data', 'deploys', 'ledger.jsonl')).length, 2);
  });

  it('refuses a session not on the team', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'zulu', '--what', 'build', '--', 'npm', 'test'], { steps });
    assert.equal(result.code, 2);
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
  });

  it('refuses teamrig heavy, its old name, with the new one and exit 64, running nothing', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['heavy', '--session', 'alpha', '--what', 'build', '--', 'npm', 'test'], { steps });
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'heavy was renamed: use queue']);
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
  });

  it('refuses on Windows a command with a line break, which cmd.exe would cut, before it queues (T2156)', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build', '--', 'bash', '-c', '\nnpm test'], { steps, platform: 'win32' });
    assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
    assert.match(result.stderr[0] ?? '', /^a word of the command holds a line break, and cmd\.exe/u);
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it('refuses a word that is only &&, before it queues, and names the one-word form (#661)', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build', '--', 'npm', 'run', 'build', '&&', 'npm', 'test'], { steps });
    assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
    assert.match(result.stderr[0]?.split('\n')[0] ?? '', /^the word "&&" of the command is a shell operator.*-- "npm run build && npm test"$/u);
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it('runs the same command on Linux, whose shell keeps a quoted line break', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build', '--', 'bash', '-c', '\nnpm test'], { steps });
    assert.equal(result.code, 0);
    assert.deepEqual(
      steps.ran.map((request) => request.command),
      ["bash -c '\nnpm test'"],
    );
  });

  for (const [label, argv] of [
    ['no session', ['queue', '--what', 'build', '--', 'npm', 'test']],
    ['an empty command', ['queue', '--session', 'alpha', '--what', 'build', '--', ' ']],
    ['no label', ['queue', '--session', 'alpha', '--', 'npm', 'test']],
    ['no command', ['queue', '--session', 'alpha', '--what', 'build', '--']],
    ['a word before --', ['queue', '--session', 'alpha', '--what', 'build', 'npm', '--', 'test']],
  ] as const) {
    it(`prints the usage for ${label}`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(argv, { steps });
      assert.equal(result.code, 64);
      assert.deepEqual(steps.ran, []);
    });
  }

  for (const [label, flags, what, command, request] of [
    ['given with --kind and --task', ['--kind', 'test', '--task', 'T7'], 'build api', ['npm', 'run', 'build'], { kind: 'test', task: 'T7' }],
    ['read from its command and the task its label names', [], 'teamrig T2192 specs', ['node', '--test', 'a.test.ts'], { kind: 'test', task: 'T2192' }],
    ['read from its command, with no task when its label names none', [], 'checks', ['npm', 'run', 'check'], { kind: 'other' }],
  ] as const) {
    it(`records the kind of work and the task ${label} on its start and end records (T2209)`, async () => {
      const { kit, steps } = harness();
      steps.ends(0, MINUTE);
      assert.equal((await kit.run(['queue', '--session', 'alpha', '--what', what, ...flags, '--', ...command], { steps })).code, 0);
      const start = { type: 'heavy', id: 'id-2', session: 'alpha', what, ...request, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
      assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:01:02.000Z', exitCode: 0 }]);
    });
  }

  it("records the register priority of the task its label names on its start and end records (T2209)", async () => {
    const { kit, steps } = harness();
    const added = await kit.run(['add', '--title', 'Ship the build', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    steps.ends(0, MINUTE);
    assert.equal((await kit.run(['queue', '--session', 'alpha', '--what', 'T1 build', '--', 'npm', 'run', 'build'], { steps })).code, 0);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'T1 build', kind: 'build', task: 'T1', priority: 2, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:01:02.000Z', exitCode: 0 }]);
  });

  it("puts what the step asks on its ticket in the host lock's line: its kind, the task its label names with that task's priority and class, and the memory it needs (T2210)", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1, admission: 'pipeline' }, wait: { pollSeconds: 30 } } });
    const added = await kit.run(['add', '--title', 'Ship the build', '--description', 'what and why', '--priority', 'p2', '--class', 'Maintenance', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    await kit.files.write(LOCK, heldBy());
    const requests: unknown[] = [];
    const sleep = async (ms: number): Promise<void> => {
      requests.push(...(await lineRequests(kit.files, LOCK)));
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'T1 build', '--', 'npm', 'run', 'build'], { steps, sessionProcesses: otherRuns(), sleep });
    assert.equal(result.code, 2, 'po holds the lock past the wait');
    const request = { kind: 'build', task: 'T1', priority: 2, class: 'Maintenance', classPct: 25, needMb: 2048, heavy: true, exclusive: false };
    assert.deepEqual([requests.length > 0, requests.filter((seen) => !isDeepStrictEqual(seen, request))], [true, []]);
  });

  it("marks a fronted task's step on its ticket, from the start or once the lead fronts it while the step waits (T4082)", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 3, admission: 'pipeline' }, wait: { pollSeconds: 30 } } });
    for (const title of ['Ship the build', 'Fix the gate']) {
      const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--class', 'Maintenance', '--session', 'alpha']);
      assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    }
    const front = new LineFrontStore(kit.files, lineFrontPath(join(TEAM_HOME, 'state')));
    await front.put({ task: 'T2', at: '2030-01-08T09:00:00.000Z', by: 'lead' });
    await kit.files.write(LOCK, heldBy());
    const LATER = '2030-01-08T10:05:00.000Z';
    /** The front each look at the line sees on the step's ticket, the lead fronting T1 after the first look when `frontT1` says so. */
    const fronts = async (label: string, frontT1: boolean): Promise<(string | undefined)[]> => {
      const seen: (string | undefined)[] = [];
      const sleep = async (ms: number): Promise<void> => {
        for (const request of await lineRequests(kit.files, LOCK)) {
          const frontAt = isRecord(request) ? request['frontAt'] : undefined;
          seen.push(typeof frontAt === 'string' ? frontAt : undefined);
        }
        if (frontT1 && seen.length > 0) {
          await front.put({ task: 'T1', at: LATER, by: 'lead' });
        }
        await kit.clock.sleep(ms);
      };
      const result = await kit.run(['queue', '--session', 'alpha', '--what', label, '--', 'npm', 'run', 'build'], { steps, sessionProcesses: otherRuns(), sleep });
      assert.equal(result.code, 2, `po holds the lock past the wait (${label})`);
      return seen;
    };
    const fromStart = await fronts('T2 build', false);
    assert.deepEqual([fromStart.length > 0, fromStart.filter((at) => at !== '2030-01-08T09:00:00.000Z')], [true, []], 'fronted when it queued');
    const later = await fronts('T1 build', true);
    assert.deepEqual([later[0], later.at(-1)], [undefined, LATER], 'fronted at its next read of the register');
  });

  for (const [flag, value, message] of [
    ['--kind', 'tests', /--kind is one of build, test, lint, push, merge, deploy, other, ship/],
    ['--task', 'merge', /--task is a register task id, such as T12/],
    ['--task', 'T0', /--task is a register task id, such as T12/],
    ['--memory-mb', '0', /--memory-mb is a whole number of MB from 1/],
    ['--memory-mb', 'x', /--memory-mb is a whole number of MB from 1/],
    ['--memory-mb', '1.5', /--memory-mb is a whole number of MB from 1/],
  ] as const) {
    it(`refuses ${flag} ${value} as a usage error, before it waits or records anything (T2209)`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build api', flag, value, '--', 'npm', 'run', 'build'], { steps });
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr.join('\n'), message);
      assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
    });
  }
});

describe('teamrig queue --small', () => {
  it('shares the host instead of taking the lock, holds its share, which says what the step asks, while it runs and records it as shared (T2210)', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [kit.files.get(LOCK), JSON.parse(kit.files.get(`${SHARED}/id-1.json`) ?? '{}')];
    });
    const result = await kit.run(SPECS, { steps });
    const lines = [`2030-01-08 10:00:02 UTC sharing the host: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other small steps)`, '2030-01-08 10:00:02 UTC running: specs (killed after 10m)', 'DONE exit 0'];
    assert.deepEqual(result, { code: 0, stdout: lines, stderr: [] });
    const request = { kind: 'test', class: 'Improvements', classPct: 15, needMb: 2048, heavy: false, exclusive: false };
    const share = { id: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z', reserveMb: 2048, request };
    assert.deepEqual(whileRunning, [undefined, share], 'a step whose label names no task asks at the default class, with no priority');
    assert.equal(kit.files.get(`${SHARED}/id-1.json`), undefined, 'the share is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'specs', kind: 'test', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, shared: true, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('kills it after delivery.queue.smallMaxRunMinutes, or a shorter --max-minutes', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { smallMaxRunMinutes: 12 } } });
    assert.equal((await kit.run(SPECS, { steps })).stdout[1], '2030-01-08 10:00:02 UTC running: specs (killed after 12m)');
    const shorter = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--max-minutes', '5', '--', 'npm', 'test'];
    assert.equal((await kit.run(shorter, { steps })).stdout[1], '2030-01-08 10:00:04 UTC running: specs (killed after 5m)');
    assert.deepEqual(steps.ran.map((request) => request.timeoutMs), [12 * MINUTE, 5 * MINUTE]);
  });

  it('refuses a --max-minutes past delivery.queue.smallMaxRunMinutes before sharing the host', async () => {
    const { kit, steps } = harness();
    const longer = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--max-minutes', '11', '--', 'npm', 'test'];
    const result = await kit.run(longer, { steps });
    assert.equal(result.code, 64);
    assert.match(result.stderr.join('\n'), /--max-minutes with --small is a whole number from 1 to 10 \(delivery\.queue\.smallMaxRunMinutes\): a longer step runs without --small/);
    assert.deepEqual([steps.ran, kit.files.get(`${SHARED}/id-1.json`), kit.files.get(LOCK)], [[], undefined, undefined]);
  });

  it('holds for it the most its latest 20 runs under the same session and label held, with a quarter more', async () => {
    const { kit, steps } = harness();
    const runs = [ranBefore('alpha', 'specs', 9000), ...Array.from({ length: 19 }, () => ranBefore('alpha', 'specs', 1000)), ranBefore('alpha', 'specs', 1900)];
    await kit.files.append(LEDGER, `${[...runs, ranBefore('bravo', 'specs', 9000), ranBefore('alpha', 'lint', 9000)].join('\n')}\n`);
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 2375 MB held for it (${ROOMY_FREE_MB} MB free, 0 other small steps)`);
  });

  it('joins a small step sharing the host while the memory allows it', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { smallReserveMb: 1000, memoryFloorMb: 4000 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 1000 MB held for it (${ROOMY_FREE_MB} MB free, 1 other small step)`);
  });

  it('shares the host under pipeline admission beside its session\'s 2 heavy steps, its cap holding no small step (T3286)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { admission: 'pipeline' } } });
    await kit.files.append(`${SHARED}/a1.json`, ownHeavyShare('a1', 'heavy: build'));
    await kit.files.append(`${SHARED}/a2.json`, ownHeavyShare('a2', 'heavy: build web'));
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other small steps, 2 heavy steps)`);
  });

  it('shares the host beside its session\'s 2 running steps with delivery.queue.admission serial (T2210)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { admission: 'serial' } } });
    await kit.files.append(`${SHARED}/a1.json`, ownShare('a1', 'heavy: lint'));
    await kit.files.append(`${SHARED}/a2.json`, ownShare('a2', 'heavy: build'));
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 2 other small steps)`);
  });

  it('waits while the small steps sharing the host hold the memory it needs, then refuses, recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(SPECS, { steps, memory: new FakeHostMemory(6000), sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC; host memory: 6000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting to share the host: ${held}`, `REFUSED host memory still short: ${held}`], stderr: [] });
    assert.deepEqual([ledgerOf(kit), kit.files.get(`${SHARED}/id-1.json`)], [[memoryRefused(SPECS_STEP, 6000, 'waiting to share the host', held)], undefined]);
  });

  it('keeps a lone small step waiting while free memory is under the floor plus its own MB, then refuses (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(SPECS, { steps, memory: new FakeHostMemory(6000) });
    const short = 'host memory: 6000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting to share the host: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual([steps.ran, ledgerOf(kit), await kit.files.list(SHARED)], [[], [memoryRefused(SPECS_STEP, 6000, 'waiting to share the host', short)], []]);
  });

  it('keeps a heavy step waiting while free memory is under the floor plus delivery.queue.heavyReserveMb, then refuses (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual([steps.ran, ledgerOf(kit), kit.files.get(LOCK)], [[], [memoryRefused(BUILD_STEP, 5000, 'waiting for the host lock', short)], undefined]);
  });

  it('names the programs holding the most memory when it refuses after its wait on host memory, printed and recorded (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000).holds(BUSY_HOLDERS) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    const reason = `host memory still short: ${short}; ${BUSY_HOLDERS_TEXT}`;
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED ${reason}`]);
    assert.deepEqual(ledgerOf(kit), [{ ...memoryRefused(BUILD_STEP, 5000, 'waiting for the host lock', short), reason }]);
  });

  it('records on its start record how long a heavy step waited for host memory, and the free memory when it queued (T2209)', async () => {
    const { kit, steps } = harness();
    steps.ends(0, MINUTE);
    const memory = new FakeHostMemory(ROOMY_FREE_MB).readsFree(5000, 5000, 5000);
    assert.equal((await kit.run(BUILD, { steps, memory })).code, 0);
    const [start] = ledgerOf(kit);
    const short = 3 * FIRST_IN_LINE_POLL_MS;
    assert.deepEqual(start, { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', waits: { memory: short }, queueFreeMb: 5000, startedAt: new Date(Date.parse('2030-01-08T10:00:00Z') + short).toISOString(), endedAt: null, exitCode: null }, 'it waits two short looks of the first in line, then its last look before it takes the lock');
  });

  it('holds for a heavy step its latest runs\' peak with a quarter more when that passes delivery.queue.heavyReserveMb (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${[ranBefore('alpha', 'build api', 2000), ranBefore('alpha', 'build api', 6000), ranBefore('bravo', 'build api', 9000)].join('\n')}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11596 MB needed (4096 floor + 7500 for this step, learned from 2 runs)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
  });

  it('holds for a heavy step the median of what the host lost during its runs when that passes their peak (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${[ranBefore('alpha', 'build api', 1000, { startFreeMb: 12_000, lowFreeMb: 4000 }), ranBefore('alpha', 'build api', 1200, { startFreeMb: 12_000, lowFreeMb: 6000 })].join('\n')}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11096 MB needed (4096 floor + 7000 for this step, learned from 2 runs)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('falls back to its session\'s runs of the same kind when none has its label, and names the kind (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${ranBefore('alpha', 'T8 build', 6000, { kind: 'build' })}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11596 MB needed (4096 floor + 7500 for this step, learned from 1 build run)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('holds for a step the MB it declares with --memory-mb when more than it learned (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const declared = ['queue', '--session', 'alpha', '--what', 'build api', '--memory-mb', '9000', '--', 'npm', 'run', 'build'];
    const result = await kit.run(declared, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 13096 MB needed (4096 floor + 9000 for this step, declared with --memory-mb)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual(steps.ran, []);
  });

  it('holds delivery.queue.heavyReserveMb for a heavy step whose latest runs\' peak with a quarter more is less (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${ranBefore('alpha', 'build api', 1200)}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('makes a step without it wait for the small steps sharing the host with delivery.queue.admission serial, then refuse, leaving no lock', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1, admission: 'serial' }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:02 UTC waiting for the host lock: ${held}`, `REFUSED host lock still held by ${held}`], stderr: [] });
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('runs a step without it beside the small steps sharing the host, as a heavy share, under delivery.queue.admission pipeline (T2210)', async () => {
    const { kit, steps } = harness(PIPELINE);
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    const sharing = `2030-01-08 10:00:02 UTC sharing the host as a heavy step: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other heavy steps, 1 small step)`;
    assert.deepEqual(result, { code: 0, stdout: [sharing, '2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual([kit.files.get(LOCK), kit.files.get(`${SHARED}/other.json`)], [undefined, sharedBy()]);
  });
});

describe('teamrig queue --exclusive', () => {
  const EXCLUSIVE = ['queue', '--session', 'alpha', '--what', 'build api', '--exclusive', '--', 'npm', 'run', 'build'];

  it('takes the whole host under delivery.queue.admission pipeline: the lock file, no share, recorded as not shared (T2210)', async () => {
    const { kit, steps } = harness(PIPELINE);
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [JSON.parse(kit.files.get(LOCK) ?? '{}'), kit.files.get(`${SHARED}/id-1.json`)];
    });
    const result = await kit.run(EXCLUSIVE, { steps });
    assert.deepEqual(result, { code: 0, stdout: ['2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    const lock = { id: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: build api', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z' };
    assert.deepEqual(whileRunning, [lock, undefined]);
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('asks for the whole host on its ticket and waits for the small steps sharing it to end, then refuses, leaving no lock (T2210)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const requests: unknown[] = [];
    const sleep = async (ms: number): Promise<void> => {
      requests.push(...(await lineRequests(kit.files, LOCK)));
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(EXCLUSIVE, { steps, sessionProcesses: otherRuns(), sleep });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:02 UTC waiting for the host lock: ${held}`, `REFUSED host lock still held by ${held}`], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(`${SHARED}/other.json`)], [[], undefined, sharedBy()]);
    const request = { kind: 'build', class: 'Improvements', classPct: 15, needMb: 2048, heavy: true, exclusive: true };
    assert.deepEqual([requests.length > 0, requests.filter((seen) => !isDeepStrictEqual(seen, request))], [true, []]);
  });

  it('refuses --exclusive with --small as a usage error, before it waits or records anything (T2210)', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'specs', '--small', '--exclusive', '--', 'npm', 'test'], { steps });
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--exclusive takes the whole host and --small shares it: give one of them/);
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });
});


describe('teamrig queue --pre-push', () => {
  const PRE_PUSH = ['queue', '--session', 'alpha', '--what', 'pre-push checks', '--pre-push', '--', 'npm', 'test'];
  const PASSES = join(GIT_DIR, 'teamrig', 'pre-push');
  const DECLINED = 'REFUSED push declined: its checks waited 3m for the host lock, long enough for its connection to close;';

  it('records the pass of checks run on a clean tree, which the next push of the tree reuses without the lock', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    steps.ends(0, MINUTE);
    const ran = [heavyShared('2030-01-08 10:00:02 UTC'), '2030-01-08 10:00:02 UTC running: pre-push checks (killed after 45m)', 'DONE exit 0'];
    assert.deepEqual(await kit.run(PRE_PUSH, { steps, trees }), { code: 0, stdout: ran, stderr: [] });
    assert.equal((await kit.files.list(PASSES)).length, 1);
    await kit.files.write(LOCK, heldBy());
    assert.deepEqual(await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() }), {
      code: 0,
      stdout: ['2030-01-08 10:01:02 UTC pre-push checks passed on this tree (c0ffee1) at 2030-01-08 10:01 UTC: not run again', 'DONE exit 0'],
      stderr: [],
    });
    assert.deepEqual([steps.ran.length, ledgerOf(kit).length, kit.files.get(LOCK)], [1, 2, heldBy()], 'nothing ran or was recorded, and the lock stayed with its holder');
    assert.deepEqual(trees.looks, [APP, APP, APP], 'the tree before and after the checks, then before the next push');
  });

  it('reuses a pass from the queue cutoff on, since it runs nothing', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    await recordPass(kit.files, cleanTree(), 'npm test', 'pre-push checks', Date.parse('2030-01-08T09:00:00Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()) });
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [0, 'DONE exit 0', []]);
  });

  it('runs checks with another command line again on the same tree', async () => {
    const { kit, steps } = harness();
    await recordPass(kit.files, cleanTree(), 'npm test', 'pre-push checks', Date.parse('2030-01-08T09:00:00Z'));
    const result = await kit.run([...PRE_PUSH.slice(0, -1), 'run', 'lint'], { steps, trees: new FakeTrees(cleanTree()) });
    assert.deepEqual([result.code, steps.ran.map((request) => request.command)], [0, ['npm run lint']]);
  });

  it('declines the push when its checks waited over a minute for the lock, and records their pass for the next push, with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness(SERIAL);
    const trees = new FakeTrees(cleanTree());
    steps.ends(0, MINUTE);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
        '2030-01-08 10:03:02 UTC running: pre-push checks (killed after 45m)',
        'DONE exit 0',
        `${DECLINED} push again: it reuses this pass`,
      ],
      stderr: [],
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const again = await kit.run(PRE_PUSH, { steps, trees });
    assert.deepEqual([again.code, again.stdout.at(-1), steps.ran.length], [0, 'DONE exit 0', 1]);
  });

  it("lets the push go after a wait of a minute, the memory gate's reads counted in it", async () => {
    const { kit, steps } = harness();
    // The lock frees at 10:00:58 and the gate's reads take 2 s more: the push's connection is open through both.
    await kit.files.write(LOCK, heldBy('2030-01-08T10:00:58.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()), sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1)], [0, 'DONE exit 0']);
  });

  for (const { label, trees, during, reason } of [
    { label: 'a tree with uncommitted changes', trees: new FakeTrees({ kind: 'changed' }), during: undefined, reason: 'the tree has uncommitted changes' },
    { label: 'a folder with no git commit', trees: new FakeTrees(), during: undefined, reason: 'this folder has no git commit to record it for' },
    { label: 'a tree that changed while the checks ran', trees: new FakeTrees(cleanTree()), during: cleanTree('ffff0000'), reason: 'the tree changed while they ran' },
  ]) {
    it(`records no pass for ${label}, and says so when it declines the push`, async () => {
      const { kit, steps } = harness();
      steps.whileRunning(async () => {
        trees.state = during ?? trees.state;
      });
      await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
      const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
      assert.deepEqual([result.code, result.stdout.at(-1)], [2, `${DECLINED} no pass was recorded, as ${reason}: commit, then push again`]);
      assert.deepEqual(await kit.files.list(PASSES), []);
    });
  }

  it('records no pass for checks that failed, which run again on the next push', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    steps.ends(1);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED exit 1']);
    assert.deepEqual(await kit.files.list(PASSES), []);
    await kit.run(PRE_PUSH, { steps, trees });
    assert.equal(steps.ran.length, 2);
  });

  it("records the pass of checks run under a parent's lock", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()), sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.deepEqual([result.code, (await kit.files.list(PASSES)).length], [0, 1]);
  });

  it('reads no tree and records no pass without --pre-push', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    assert.equal((await kit.run(BUILD, { steps, trees })).code, 0);
    assert.deepEqual([trees.looks, await kit.files.list(PASSES)], [[], []]);
  });
});

/** The id `--detach` gives a run started at the harness clock's 10:00:00 UTC by the CLI's pid. */
const DETACHED_ID = '20300108-100000-4242';
const DETACHED_LOG = join(TEAM_HOME, 'state', 'deploys', 'detached', `${DETACHED_ID}.log`);
const DETACHED_RECORD = join(TEAM_HOME, 'state', 'deploys', 'detached', `${DETACHED_ID}.run.json`);
const ALPHA_INBOX = join(TEAM_HOME, 'state', 'inbox', 'alpha.md');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
const DETACH_BUILD = ['queue', '--what', 'build api', '--max-minutes', '90', '--exclusive', '--detach', '--', 'npm', 'run', 'build'];
const DETACHED_BUILD = ['queue', '--detached-run', DETACHED_ID, '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'];
const DETACHED_DIR = join(TEAM_HOME, 'state', 'deploys', 'detached');
const DISPATCHER = ['/opt/teamrig/dist/cli/main.js', 'queue', '--dispatch'];

/** The parked step `id` (T4093), read back as the dispatcher would. */
function parkedOf(kit: CliHarness, id: string): ParkedStep | undefined {
  const text = kit.files.get(join(parkedDirOf(DETACHED_DIR), `${id}${PARKED_SUFFIX}`));
  return text === undefined ? undefined : parseParked(text);
}

/** The texts of the lines in alpha's inbox, without their stamps and senders. */
async function alphaLines(kit: CliHarness): Promise<string[]> {
  return ((await kit.files.read(ALPHA_INBOX)) ?? '').split('\n').flatMap((line) => {
    const text = /^- .+? alpha: (.*)$/.exec(line)?.[1];
    return text === undefined ? [] : [text];
  });
}

/** The texts of the wake asks waiting for alpha, each with its sender. */
async function alphaWakes(kit: CliHarness): Promise<string[]> {
  return (await new WakeAsks(kit.files, ASKS).read('alpha')).flatMap(({ ask }) => (ask === undefined ? [] : [`${ask.from}: ${ask.text}`]));
}

describe('teamrig queue --detach (T2227)', () => {
  it('parks the step as a queue --detached-run, its session resolved and its output in its log, starts the dispatcher and prints QUEUED at once (T4093)', async () => {
    const { kit, steps } = harness();
    const processes = new FakeProcesses();
    const result = await kit.run(DETACH_BUILD, { steps, processes, env: { TEAMRIG_SESSION: 'alpha', PATH: '/usr/bin', PROBE: 'yes', GH_TOKEN: 'secret-token' } });
    assert.deepEqual(result, {
      code: 0,
      stdout: [`QUEUED ${DETACHED_ID}: build api runs detached; log ${DETACHED_LOG}; alpha's inbox gets a line when it starts and when it ends`],
      stderr: [],
    });
    const parked = parkedOf(kit, DETACHED_ID);
    const argv = ['queue', '--detached-run', DETACHED_ID, '--session', 'alpha', '--what', 'build api', '--max-minutes', '90', '--exclusive', '--', 'npm', 'run', 'build'];
    assert.deepEqual(
      [parked?.argv, parked?.cwd, parked?.log, parked?.session, parked?.team, parked?.env],
      [argv, APP, DETACHED_LOG, 'alpha', 'app', { TEAMRIG_HOME: KIT, TEAMRIG_SESSION: 'alpha', PATH: '/usr/bin' }],
      'only allow-listed variables reach the disk: no credential, no variable of a name the list does not know',
    );
    const [hidden] = processes.hidden;
    assert.deepEqual([processes.hidden.length, hidden?.command, hidden?.args, hidden?.log, hidden?.env['GH_TOKEN']], [1, '/usr/bin/node', DISPATCHER, join(DETACHED_DIR, 'dispatcher.log'), 'secret-token'], 'the dispatcher gets them in memory');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER), await alphaLines(kit)], [[], undefined, undefined, []], 'the caller waits for nothing and runs nothing');
  });

  it('refuses under a pipeline freeze on its kind, starting nothing', async () => {
    const { kit, steps } = harness();
    await kit.files.write(PIPELINE_FREEZES, pipelineFreezes({ from: '2030-01-08T09:00:00.000Z' }));
    const processes = new FakeProcesses();
    const result = await kit.run(DETACH_BUILD, { steps, processes, env: { TEAMRIG_SESSION: 'alpha' } });
    assert.deepEqual(result, { code: 2, stdout: [`REFUSED ${FROZEN}`], stderr: [] });
    assert.deepEqual([processes.hidden, steps.ran], [[], []]);
  });

  it('refuses from the queue cutoff on, starting nothing', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    const processes = new FakeProcesses();
    const result = await kit.run(DETACH_BUILD, { steps, processes, env: { TEAMRIG_SESSION: 'alpha' } });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED queue cutoff 09:30-00:00 UTC (now 10:00 UTC)'], stderr: [] });
    assert.deepEqual([processes.hidden, steps.ran], [[], []]);
  });

  for (const [label, outcome, why] of [
    ['could not start it', { kind: 'failed', error: 'spawn EPERM' }, 'spawn EPERM'],
    ['finds no Node.js', { kind: 'missing' }, '/usr/bin/node was not found'],
  ] as const) {
    it(`refuses, saying why, when it ${label}`, async () => {
      const { kit, steps } = harness();
      const processes = new FakeProcesses().onStart('/usr/bin/node', outcome);
      const result = await kit.run(DETACH_BUILD, { steps, processes, env: { TEAMRIG_SESSION: 'alpha' } });
      assert.deepEqual(result, { code: 2, stdout: [`REFUSED build api did not start detached: ${why}`], stderr: [] });
      assert.deepEqual([steps.ran, parkedOf(kit, DETACHED_ID)], [[], undefined], 'no step is left parked with no dispatcher');
    });
  }

  for (const [label, argv, message] of [
    ['--pre-push, whose push waits for its result', ['queue', '--session', 'alpha', '--what', 'checks', '--pre-push', '--detach', '--', 'npm', 'test'], /--detach returns before the step runs and --pre-push decides a push/],
    ['--detached-run, which only --detach sets', ['queue', '--session', 'alpha', '--what', 'checks', '--detached-run', DETACHED_ID, '--detach', '--', 'npm', 'test'], /--detached-run is set by --detach: give only --detach/],
    ['a --detached-run id --detach did not make', ['queue', '--session', 'alpha', '--what', 'checks', '--detached-run', 'mine', '--', 'npm', 'test'], /--detached-run is set by --detach: run the step with --detach/],
  ] as const) {
    it(`prints the usage for ${label}, starting nothing`, async () => {
      const { kit, steps } = harness();
      const processes = new FakeProcesses();
      const result = await kit.run(argv, { steps, processes });
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr.join('\n'), message);
      assert.deepEqual([processes.hidden, steps.ran], [[], []]);
    });
  }

  it("prints the usage under a live parent lock, whose step waits for this one's result", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const processes = new FakeProcesses();
    const result = await kit.run(['queue', '--what', 'pre-commit checks', '--detach', '--', 'npm', 'test'], { steps, processes, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--detach under a live host lock/);
    assert.deepEqual([processes.hidden, steps.ran, kit.files.get(LOCK)], [[], [], heldBy()]);
  });
});

describe('teamrig queue --detached-run (T2227)', () => {
  it('runs the step --detach started without watching a shell, telling its session when it starts and, waking it, when it ends', async () => {
    const { kit, steps } = harness();
    const processes = new FakeProcesses();
    assert.equal((await kit.run(DETACH_BUILD, { steps, processes, env: { TEAMRIG_SESSION: 'alpha' } })).code, 0);
    const hiddenArgs = parkedOf(kit, DETACHED_ID)?.argv ?? [];
    const starters = new FakeStarterWatch();
    steps.ends(0, MINUTE).whileRunning(async () => starters.end());
    const result = await kit.run(hiddenArgs, { steps, starters });
    assert.deepEqual(result, { code: 0, stdout: [`2030-01-08 10:00:00 UTC detached run ${DETACHED_ID}: pid 4242`, '2030-01-08 10:00:02 UTC running: build api (killed after 1h30m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual([steps.ran[0]?.stop?.aborted, starters.openWatches], [false, 0], 'the shell that ran --detach ended long ago: it stops nothing');
    assert.deepEqual(await alphaLines(kit), [`queue ${DETACHED_ID} started: build api; log ${DETACHED_LOG}`, `queue ${DETACHED_ID} ended: build api: DONE exit 0; log ${DETACHED_LOG}`]);
    assert.deepEqual(await alphaWakes(kit), [`alpha: queue ${DETACHED_ID} ended: build api: DONE exit 0; log ${DETACHED_LOG}`], 'only the end wakes it');
    assert.equal(ledgerOf(kit).length, 2, "its start and end are recorded as any step's");
  });

  it('tells its session of a failed step with its exit code', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(DETACHED_BUILD, { steps: steps.ends(3) });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED exit 3']);
    assert.deepEqual(await alphaWakes(kit), [`alpha: queue ${DETACHED_ID} ended: build api: FAILED exit 3; log ${DETACHED_LOG}`]);
  });

  it('tells its session, waking it, when its step is refused after its wait, with no start line', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(DETACHED_BUILD, { steps, sessionProcesses: otherRuns() });
    const refusal = 'REFUSED host lock still held by po (heavy: build) since 2030-01-08 09:50 UTC';
    assert.deepEqual([result.code, result.stdout.at(-1)], [2, refusal]);
    const ended = `queue ${DETACHED_ID} ended: build api: ${refusal}; log ${DETACHED_LOG}`;
    assert.deepEqual([await alphaLines(kit), await alphaWakes(kit), steps.ran], [[ended], [`alpha: ${ended}`], []]);
    assert.equal(kit.files.get(DETACHED_RECORD), undefined, 'a refused run ends its record too');
  });

  it('keeps its run record from its start, marked running with its ledger step once its step runs, and removes it before its end line (T2742, T2942)', async () => {
    const { kit, steps } = harness();
    const seen: unknown[] = [];
    steps.ends(0, MINUTE).whileRunning(async () => {
      seen.push(JSON.parse(kit.files.get(DETACHED_RECORD) ?? 'null'));
    });
    assert.equal((await kit.run(DETACHED_BUILD, { steps })).code, 0);
    const step = { ledger: LEDGER, start: ledgerOf(kit)[0] };
    assert.deepEqual(seen, [{ v: 2, id: DETACHED_ID, team: 'app', session: 'alpha', what: 'build api', log: DETACHED_LOG, pid: 4242, startedAt: '2030-01-08T10:00:00.000Z', runningAt: '2030-01-08T10:00:02.000Z', step }]);
    assert.equal(kit.files.get(DETACHED_RECORD), undefined);
    assert.equal((await kit.run(['start'], { env: { TEAMRIG_SESSION: 'bravo' } })).code, 0);
    assert.equal((await alphaWakes(kit)).length, 1, 'a sweep after its own end tells nothing more');
  });

  it('runs on when its record cannot be written, saying so in its log', async () => {
    const { kit, steps } = harness();
    const files = new FaultyFiles(kit.files).fail('write', DETACHED_RECORD, systemError('EACCES', 'EACCES: permission denied'));
    const result = await kit.run(DETACHED_BUILD, { steps: steps.ends(0), files });
    const unwritten = (at: string): string => `2030-01-08 ${at} UTC its run record was not written, so a death of this run goes untold: EACCES: permission denied`;
    assert.deepEqual([result.code, result.stdout.filter((line) => line.includes('run record'))], [0, [unwritten('10:00:00'), unwritten('10:00:02'), unwritten('10:00:02')]], 'at its start, when its step runs and when its ledger step opens (T2942)');
  });
});

describe('teamrig queue hands a waiting step over when its shell ended under a live tab (T2304)', () => {
  const HANDED_ID = '20300108-100002-4242';
  const HANDED_LOG = join(TEAM_HOME, 'state', 'deploys', 'detached', `${HANDED_ID}.log`);
  const ARRIVED = String(Date.parse('2030-01-08T10:00:00.000Z'));
  const HANDED = `queue ${HANDED_ID} kept build api's place in line: its launching shell ended (bash.exe 4100) while it waited, so it runs on detached; do not run it again; log ${HANDED_LOG}; teamrig withdraw --session alpha --what "build api" stops it`;
  const GIT_STARTER = { pid: 4200, parentPid: SHELL.pid, name: 'git.exe', commandLine: 'git commit' };
  const STOPPED = "STOPPED before the host lock was free: nothing ran; re-run the same command in the background with no human's OK, unless you or the human stopped it on purpose";

  /** Runs `argv` with the lock held until `ending` ends one of `starters` at the first look again. */
  async function waitUntilEnded(argv: readonly string[], starters: FakeStarterWatch, ending: typeof SHELL, extra: { readonly processes?: FakeProcesses; readonly trees?: FakeTrees } = {}): Promise<{ kit: CliHarness; steps: FakeSteps; processes: FakeProcesses; result: CliResult }> {
    const { kit, steps } = harness({ ...TEAM, delivery: { wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const processes = extra.processes ?? new FakeProcesses();
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end(ending);
    };
    const result = await kit.run(argv, { steps, starters, sleep, processes, sessionProcesses: otherRuns(), ...(extra.trees === undefined ? {} : { trees: extra.trees }) });
    return { kit, steps, processes, result };
  }

  it("hands the step over to a detached run joining at its first arrival, tells and wakes its session, and records no refusal, as Claude Code's reaper ended the shell alone", async () => {
    const starters = new FakeStarterWatch();
    const { kit, steps, processes, result } = await waitUntilEnded(BUILD, starters, SHELL);
    assert.deepEqual(result, {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
        `QUEUED ${HANDED_ID}: build api runs detached; log ${HANDED_LOG}; alpha's inbox gets a line when it starts and when it ends`,
        `2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: detached run ${HANDED_ID} keeps its place in line`,
      ],
      stderr: [],
    });
    const args = ['queue', '--detached-run', HANDED_ID, '--session', 'alpha', '--arrived-at', ARRIVED, '--what', 'build api', '--', 'npm', 'run', 'build'];
    const parked = parkedOf(kit, HANDED_ID);
    assert.deepEqual([parked?.argv, parked?.log, processes.hidden[0]?.args, steps.ran, kit.files.get(LOCK), ledgerOf(kit), starters.openWatches], [args, HANDED_LOG, DISPATCHER, [], heldBy(), [], 0]);
    assert.deepEqual([await alphaLines(kit), await alphaWakes(kit)], [[HANDED], [`alpha: ${HANDED}`]]);

    const seen: string[] = [];
    const look = async (ms: number): Promise<void> => {
      seen.push(...(await kit.files.list(`${LOCK}.queue`)));
      await kit.clock.sleep(ms);
      await kit.files.remove(LOCK);
    };
    const hiddenArgs = parked?.argv ?? [];
    const ran = await kit.run(hiddenArgs, { steps: steps.ends(0, MINUTE), sleep: look, sessionProcesses: otherRuns() });
    assert.deepEqual([ran.code, steps.ran.length, new Set(seen).size], [0, 1, 1], 'one ticket, however many looks the wait took');
    assert.ok(seen[0]?.startsWith(`${ARRIVED.padStart(15, '0')}-`), `the detached run's ticket is named by the first arrival: ${seen[0] ?? 'none'}`);
  });

  for (const [label, starters, ending, argv, trees] of [
    ['its tab ended: Claude Code is gone, so no one wants the result', new FakeStarterWatch(), CLAUDE, BUILD, undefined],
    ["a git hook's step: its git command took the shell's end as the hook's", new FakeStarterWatch([GIT_STARTER, SHELL, CLAUDE]), SHELL, BUILD, undefined],
    ["a pre-push hook's checks: their push is gone", new FakeStarterWatch(), SHELL, ['queue', '--session', 'alpha', '--what', 'build api', '--pre-push', '--', 'npm', 'run', 'build'], new FakeTrees(cleanTree())],
  ] as const) {
    it(`stops, handing nothing over, when ${label}`, async () => {
      const { kit, processes, result } = await waitUntilEnded(argv, starters, ending, trees === undefined ? {} : { trees });
      assert.deepEqual([result.code, result.stdout.at(-1), processes.hidden, await alphaLines(kit)], [1, STOPPED, [], []]);
      assert.equal(ledgerOf(kit).length, 1, 'its stopped refusal');
    });
  }

  it('stops, recording why, when its detached run did not start', async () => {
    const processes = new FakeProcesses().onStart('/usr/bin/node', { kind: 'failed', error: 'spawn EPERM' });
    const { kit, result } = await waitUntilEnded(BUILD, new FakeStarterWatch(), SHELL, { processes });
    assert.deepEqual([result.code, result.stdout.at(-1), await alphaLines(kit)], [1, STOPPED, []]);
    const refusal = buildRefused('2030-01-08T10:00:02.000Z', 2_000, 'stopped', 'its launching shell ended (bash.exe 4100) while it waited; its detached run did not start: build api did not start detached: spawn EPERM');
    assert.deepEqual(ledgerOf(kit), [refusal]);
  });

  for (const [label, argv, message] of [
    ['--arrived-at by hand', ['queue', '--session', 'alpha', '--what', 'checks', '--arrived-at', ARRIVED, '--', 'npm', 'test'], /--arrived-at is set by queue when it hands a waiting step over/],
    ['--arrived-at past now', ['queue', '--detached-run', HANDED_ID, '--session', 'alpha', '--what', 'checks', '--arrived-at', String(Date.parse('2030-01-09T00:00:00.000Z')), '--', 'npm', 'test'], /--arrived-at takes the epoch milliseconds the step joined the line, at most now/],
    ['--arrived-at that is no time', ['queue', '--detached-run', HANDED_ID, '--session', 'alpha', '--what', 'checks', '--arrived-at', '1e12', '--', 'npm', 'test'], /--arrived-at takes the epoch milliseconds/],
  ] as const) {
    it(`prints the usage for ${label}, running nothing`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(argv, { steps });
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr.join('\n'), message);
      assert.deepEqual(steps.ran, []);
    });
  }
});

const SHIP_TOOL = '/repo/ship/tools/ship/ship.ts';
/** A team whose repo app names the ship tool its clean checkout /repo/ship holds, queued one step at a time. */
const SHIPPING = { ...TEAM, delivery: { queue: { admission: 'serial' }, repos: { app: { mainCheckout: MAIN_CHECKOUT, shipTool: SHIP_TOOL } } } };
/** A ship without --merge: a test step, as it moves no main branch (T3414). */
const SHIP_STEP = ['queue', '--session', 'alpha', '--what', 'ship T1', '--kind', 'test', '--', 'node', SHIP_TOOL, '/repo/app/.claude/worktrees/t1-cli', '/tasks/T1/plan.json'];
const MOVE = 'run git -C /repo/ship fetch -q origin && git -C /repo/ship checkout -q --detach origin/main, then queue the step again';
const STALE = `the ship tool ${SHIP_TOOL} is not origin/main's current code in a checkout with no change: ${MOVE}`;

/** The ship tool's checkout at main's current code, `base`, as of the last fetch. */
function shipGit(): FakeMergeGit {
  const git = new FakeMergeGit();
  const checkout = { top: '/repo/ship', branch: undefined, mainCheckout: MAIN_CHECKOUT, linked: true };
  git.checkouts.set('/repo/ship', checkout);
  git.checkouts.set('/repo/ship/tools/ship', checkout);
  git.heads.set('/repo/ship', 'base');
  git.tracking.set('origin/main', 'base');
  return git;
}

describe("teamrig queue runs a configured ship tool only from main's current code (T3223)", () => {
  it("runs a ship step whose tool's checkout is clean at main's current code", async () => {
    const { kit, steps } = harness(SHIPPING);
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: shipGit() });
    assert.deepEqual([result.code, steps.ran.length], [EXIT.ok, 1]);
  });

  it('refuses at once, running nothing and starting no detached run, a ship tool at an older main or with a change', async () => {
    const older = shipGit();
    older.heads.set('/repo/ship', 'old');
    older.ancestry.add('old>base');
    const changed = shipGit();
    changed.status.set('/repo/ship', [' M tools/ship/ship.ts']);
    for (const [name, git] of Object.entries({ older, changed })) {
      const { kit, steps } = harness(SHIPPING);
      assert.deepEqual(await kit.run(SHIP_STEP, { steps, mergeGit: git }), { code: EXIT.refused, stdout: [`REFUSED ${STALE}`], stderr: [] }, name);
      const processes = new FakeProcesses();
      const detached = await kit.run([...SHIP_STEP.slice(0, 7), '--detach', ...SHIP_STEP.slice(7)], { steps, mergeGit: git, processes });
      assert.deepEqual([detached.code, detached.stdout, processes.hidden, steps.ran, ledgerOf(kit)], [EXIT.refused, [`REFUSED ${STALE}`], [], [], []], `${name}, detached`);
    }
  });

  it('refuses at its start, recording its refusal, a ship step whose tool moved to another commit while it waited', async () => {
    const { kit, steps } = harness(SHIPPING);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const git = shipGit();
    const sleep = async (ms: number): Promise<void> => {
      git.heads.set('/repo/ship', 'old');
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
    const moved = `the ship tool ${SHIP_TOOL} changed from base while the step waited and is not origin/main's current code in a checkout with no change: ${MOVE}`;
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${moved}`, []]);
    assert.deepEqual(ledgerOf(kit).map((record) => (typeof record === 'object' && record !== null && 'outcome' in record ? record.outcome : undefined)), ['refused']);
  });

  const UNANSWERED = 'git rev-parse in /repo/ship did not answer: ended with 0xC0000142, as a process that died starting does';

  /** A sleep on the harness clock that records each wait of the ship tool check. */
  function rereads(kit: CliHarness): { sleep: (ms: number) => Promise<void>; slept: number[] } {
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      if (ms === SHIP_TOOL_REREAD_MS) {
        slept.push(ms);
      }
      await kit.clock.sleep(ms);
    };
    return { sleep, slept };
  }

  it("runs a ship step whose tool's checkout git did not answer, reading it again until git answers (T3368)", async () => {
    const { kit, steps } = harness(SHIPPING);
    const git = shipGit();
    git.unanswered.push(UNANSWERED, UNANSWERED);
    const { sleep, slept } = rereads(kit);
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep });
    assert.deepEqual([result.code, steps.ran.length, slept, git.unanswered], [EXIT.ok, 1, [SHIP_TOOL_REREAD_MS], []]);
  });

  it('refuses, naming the read git did not answer and never as a changed tool, when git keeps not answering (T3368)', async () => {
    const unread = `could not read the checkout of the ship tool ${SHIP_TOOL}, so the step did not run: ${UNANSWERED}, at each of ${SHIP_TOOL_READS} reads 15 s apart; git gave no answer, which says nothing of the tool, so queue the step again once git answers on this host`;
    for (const detach of [false, true]) {
      const { kit, steps } = harness(SHIPPING);
      const git = shipGit();
      git.unanswered.push(...Array.from({ length: 10 }, () => UNANSWERED));
      const { sleep, slept } = rereads(kit);
      const processes = new FakeProcesses();
      const argv = detach ? [...SHIP_STEP.slice(0, 7), '--detach', ...SHIP_STEP.slice(7)] : SHIP_STEP;
      const result = await kit.run(argv, { steps, mergeGit: git, sleep, processes });
      assert.deepEqual([result.code, result.stdout.at(-1), steps.ran, processes.hidden, slept.length], [EXIT.refused, `REFUSED ${unread}`, [], [], SHIP_TOOL_READS - 1], `detach ${String(detach)}`);
    }
  });

  it("refuses as stale a tool git did not answer for at its queueing that is not main's current code at its start (T3368)", async () => {
    const { kit, steps } = harness(SHIPPING);
    const git = shipGit();
    git.unanswered.push(UNANSWERED);
    git.heads.set('/repo/ship', 'old');
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git });
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${STALE}`, []]);
  });

  it('runs a ship step whose tool moved on to the newest main while it waited', async () => {
    const { kit, steps } = harness(SHIPPING);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const git = shipGit();
    const sleep = async (ms: number): Promise<void> => {
      git.heads.set('/repo/ship', 'next');
      git.tracking.set('origin/main', 'next');
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, steps.ran.length], [EXIT.ok, 1]);
  });
});

describe('teamrig queue runs a ship tool only under a kind that fits it (T3414)', () => {
  const REVIEW = SHIP_STEP.slice(9);
  const queued = (kind: string, tool: readonly string[]): string[] => ['queue', '--session', 'alpha', '--what', 'ship T1', '--kind', kind, '--', 'node', SHIP_TOOL, ...tool];

  it('refuses at once, running nothing, a ship without --merge under a kind that takes the ship slot', async () => {
    for (const kind of ['ship', 'merge', 'deploy']) {
      const { kit, steps } = harness(SHIPPING);
      const result = await kit.run(queued(kind, REVIEW), { steps, mergeGit: shipGit() });
      const reason = `a ship tool run without --merge moves no main branch, so it takes no ship slot: queue it with --kind test, not --kind ${kind}`;
      assert.deepEqual([result.code, result.stdout, steps.ran], [EXIT.refused, [`REFUSED ${reason}`], []], kind);
    }
  });

  it('refuses at once a merge, in either form, under a kind that takes no ship slot', async () => {
    for (const tool of [[...REVIEW, '--merge'], ['merge', REVIEW[0] ?? '']]) {
      const { kit, steps } = harness(SHIPPING);
      const result = await kit.run(queued('test', tool), { steps, mergeGit: shipGit() });
      const reason = 'a ship tool run that merges moves main, so it holds the ship slot: queue it with --kind ship or --kind merge, not --kind test';
      assert.deepEqual([result.code, result.stdout, steps.ran], [EXIT.refused, [`REFUSED ${reason}`], []], tool.join(' '));
    }
  });

  it('runs a merge under --kind ship or merge', async () => {
    for (const kind of ['ship', 'merge']) {
      const { kit, steps } = harness(SHIPPING);
      const result = await kit.run(queued(kind, [...REVIEW, '--merge']), { steps, mergeGit: shipGit() });
      assert.deepEqual([result.code, steps.ran.length], [EXIT.ok, 1], kind);
    }
  });
});

describe("teamrig queue refuses a waiting ship only when the code its tool runs changed, not when main moved on (T3419)", () => {
  /**
   * The ship tool's checkout pinned at main `base`, moved while the step waits to `b1`, a later main, with main gone on
   * to `b2`; at both the tool imports repos.ts and src/core/home.ts, reads repos.json, and names src/cli/main.ts in its
   * roots file, and `base..b1` differ in `changed`.
   */
  function movedTwice(kit: CliHarness, changed: readonly string[], to = 'b1'): { git: FakeMergeGit; sleep: (ms: number) => Promise<void> } {
    const git = shipGit();
    for (const commit of ['base', to]) {
      git.files.set(`${commit}:tools/ship/ship.ts`, "import { profiles } from './repos.ts';\nimport { teamHome } from '../../src/core/home.ts';\n");
      git.files.set(`${commit}:tools/ship/ship.roots.json`, '{"roots": ["src/cli/main.ts"]}');
      git.files.set(`${commit}:tools/ship/repos.ts`, "import { join } from 'node:path';\nexport const PROFILES_PATH = new URL('./repos.json', import.meta.url);\n");
      git.files.set(`${commit}:tools/ship/repos.json`, '{}');
      git.files.set(`${commit}:src/core/home.ts`, "export const teamHome = '';\n");
      git.files.set(`${commit}:src/cli/main.ts`, "export {};\n");
    }
    git.ancestry.add(`${to}>b2`);
    git.ancestry.add(`base>${to}`);
    git.diffs.set(`base..${to}`, changed);
    const sleep = async (ms: number): Promise<void> => {
      git.heads.set('/repo/ship', to);
      git.tracking.set('origin/main', 'b2');
      await kit.clock.sleep(ms);
    };
    return { git, sleep };
  }

  /** The refusal of a tool that moved from `base` while the step waited, naming `files` when it can tell them. */
  const movedFrom = (files: string): string => `the ship tool ${SHIP_TOOL} changed from base while the step waited${files} and is not origin/main's current code in a checkout with no change: ${MOVE}`;

  it("runs a ship whose checkout moved to a later main, main moving on again, when none of the tool's code changed", async () => {
    const { kit, steps } = harness(SHIPPING);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const { git, sleep } = movedTwice(kit, ['src/app.ts', 'docs/commands.md']);
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, steps.ran.length], [EXIT.ok, 1]);
  });

  it('refuses it at its start, naming each file of the code the tool runs that changed: an import, a src file, a data file, a root', async () => {
    for (const changed of [['tools/ship/repos.ts'], ['src/core/home.ts', 'src/app.ts'], ['tools/ship/repos.json'], ['src/cli/main.ts'], ['tools/ship/ship.roots.json']]) {
      const { kit, steps } = harness(SHIPPING);
      await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
      const { git, sleep } = movedTwice(kit, changed);
      const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
      const named = changed.filter((file) => file !== 'src/app.ts').join(', ');
      assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${movedFrom(` (${named})`)}`, []], named);
    }
  });

  it("refuses it when the commit it moved to is off main's history, or a file the tool runs is not there", async () => {
    const off = (git: FakeMergeGit): void => void git.ancestry.delete('b1>b2');
    const missing = (git: FakeMergeGit): void => void git.files.delete('b1:src/core/home.ts');
    for (const [name, spoil] of Object.entries({ off, missing })) {
      const { kit, steps } = harness(SHIPPING);
      await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
      const { git, sleep } = movedTwice(kit, ['src/app.ts']);
      spoil(git);
      const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
      assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${movedFrom('')}`, []], name);
    }
  });

  it('refuses it when the checkout moved back to a main before its pin, on main\'s history though it is', async () => {
    const { kit, steps } = harness(SHIPPING);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const { git, sleep } = movedTwice(kit, ['src/app.ts'], 'b0');
    git.ancestry.delete('base>b0');
    git.ancestry.add('b0>base');
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${movedFrom('')}`, []]);
  });

  it('refuses it when the checkout it moved to has a change', async () => {
    const { kit, steps } = harness(SHIPPING);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const { git, sleep: moving } = movedTwice(kit, ['src/app.ts']);
    const sleep = async (ms: number): Promise<void> => {
      git.status.set('/repo/ship', [' M tools/ship/repos.ts']);
      await moving(ms);
    };
    const result = await kit.run(SHIP_STEP, { steps, mergeGit: git, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [EXIT.refused, `REFUSED ${movedFrom('')}`, []]);
  });
});

describe("teamrig queue gives a ship step the task its worktree's branch names (T3286)", () => {
  const WORKTREE = '/repo/app/.claude/worktrees/t1-cli';
  const PLAN = '/tasks/T1/plan.json';

  /** The ship tool's checkout at main's current code, with the worktree on `branch` (undefined: a detached HEAD). */
  function worktreeGit(branch: string | undefined): FakeMergeGit {
    const git = shipGit();
    git.checkouts.set(WORKTREE, { top: WORKTREE, branch, mainCheckout: MAIN_CHECKOUT, linked: true });
    return git;
  }

  /** The task each of the ledger's records names, in order. */
  function tasksOf(kit: CliHarness): unknown[] {
    return ledgerOf(kit).map((record) => (typeof record === 'object' && record !== null && 'task' in record ? record.task : undefined));
  }

  for (const [label, flags, tool, branch, task] of [
    ['a ship whose line names no task', ['--kind', 'test'], [WORKTREE, PLAN], 'feat/t1-cli', 'T1'],
    ['a merge in the merge form', ['--kind', 'merge'], ['merge', WORKTREE, '--approved', 'abc1234'], 'feat/t1-cli', 'T1'],
    ['a ship whose --task names another, which wins', ['--kind', 'test', '--task', 'T9'], [WORKTREE, PLAN], 'feat/t1-cli', 'T9'],
    ['a worktree on no task branch, with none', ['--kind', 'test'], [WORKTREE, PLAN], 'release-notes', undefined],
    ['a worktree on a detached HEAD, with none', ['--kind', 'test'], [WORKTREE, PLAN], undefined, undefined],
  ] as const) {
    it(`records on its start and end records the task of ${label}`, async () => {
      const { kit, steps } = harness(SHIPPING);
      const result = await kit.run(['queue', '--session', 'alpha', '--what', 'teamrig ship', ...flags, '--', 'node', SHIP_TOOL, ...tool], { steps, mergeGit: worktreeGit(branch) });
      assert.deepEqual([result.code, tasksOf(kit)], [EXIT.ok, [task, task]]);
    });
  }

  it('names no task for a step that runs no ship tool, whatever the branch of a folder it names', async () => {
    const { kit, steps } = harness(SHIPPING);
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'checks', '--', 'node', '/repo/other/run.ts', WORKTREE, PLAN], { steps, mergeGit: worktreeGit('feat/t1-cli') });
    assert.deepEqual([result.code, tasksOf(kit)], [EXIT.ok, [undefined, undefined]]);
  });
});
