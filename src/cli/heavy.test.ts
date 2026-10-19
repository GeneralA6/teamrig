import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIRST_IN_LINE_POLL_MS } from '../coordinator/host-lock.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FakeSteps } from '../testing/fake-steps.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const SHARED = `${LOCK}.shared`;
const MINUTE = 60_000;
const OTHER = 9001;

/** A lock another step holds: taken at 09:50 by `OTHER`, lasting to `expiresAt`. */
function heldBy(expiresAt: string = '2030-01-08T12:20:00.000Z'): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt });
}

/** `OTHER` runs, so its lock is live until it expires. */
function otherRuns(): FakeSessionProcesses {
  return new FakeSessionProcesses().add({ pid: OTHER, parentPid: 1, name: 'node', commandLine: 'node cli.ts heavy' });
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

const BUILD = ['heavy', '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'];

const SPECS = ['heavy', '--session', 'alpha', '--what', 'specs', '--small', '--', 'npm', 'test'];

/** A small step sharing the host: po's spec run, taken at 09:50 by `OTHER`, 2048 MB held for it. */
function sharedBy(): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 });
}

/** An ended run of `what` by `session` the day before, whose process tree held `peakTreeMb` at most. */
function ranBefore(session: string, what: string, peakTreeMb: number): string {
  return JSON.stringify({ type: 'heavy', id: `${session}-${peakTreeMb}`, session, what, startedAt: '2030-01-07T10:00:00.000Z', endedAt: '2030-01-07T10:05:00.000Z', exitCode: 0, peakTreeMb });
}

describe('teamrig heavy', () => {
  it('runs the command under the host lock, records its start and end, and prints DONE', async () => {
    const { kit, steps } = harness();
    let lockWhileRunning: unknown;
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      lockWhileRunning = JSON.parse(kit.files.get(LOCK) ?? '{}');
    });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 0, stdout: ['2030-01-08T10:00:00.000Z running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual(lockWhileRunning, {
      token: 'id-1',
      pid: 4242,
      session: 'alpha',
      purpose: 'heavy: build api',
      acquiredAt: '2030-01-08T10:00:00.000Z',
      expiresAt: '2030-01-08T12:30:00.000Z',
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:00.000Z', exitCode: 0 }]);
  });

  it('runs the command line in the shell, in the current folder with the environment as it is, limited to 45 minutes', async () => {
    const { kit, steps } = harness();
    await kit.run(['heavy', '--session', 'alpha', '--what', 'tests', '--', 'node', '--test', 'src/**/*.test.ts'], { steps, env: { PROBE: 'yes' } });
    const [request] = steps.ran;
    assert.equal(request?.command, "node --test 'src/**/*.test.ts'");
    assert.equal(request?.cwd, APP);
    assert.equal(request?.env['PROBE'], 'yes');
    assert.equal(request?.timeoutMs, 45 * MINUTE);
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
        '2030-01-08T10:00:00.000Z running: build api (killed after 45m)',
        '2030-01-08T10:45:00.000Z timed out after 45m: killed its process tree',
        'TIMED OUT killed, recorded as exit 124',
      ],
      stderr: [],
    });
    assert.deepEqual(ledgerOf(kit)[1], { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: '2030-01-08T10:45:00.000Z', exitCode: 124 });
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
    const result = await kit.run(['heavy', '--session', 'alpha', '--what', 'replay', '--max-minutes', '90', '--', 'npm', 'run', 'replay'], { steps });
    assert.equal(result.stdout[0], '2030-01-08T10:00:00.000Z running: replay (killed after 1h30m)');
    assert.equal(steps.ran[0]?.timeoutMs, 90 * MINUTE);
  });

  for (const minutes of ['0', '141', '1.5', 'soon']) {
    it(`refuses --max-minutes ${minutes} before taking the lock`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(['heavy', '--session', 'alpha', '--what', 'replay', '--max-minutes', minutes, '--', 'npm', 'test'], { steps });
      assert.equal(result.code, 64);
      assert.match(result.stderr.join('\n'), /--max-minutes is a whole number from 1 to 140 \(coordinator\.heavy\.lockTtlMinutes less 10\)/);
      assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
    });
  }

  it('refuses from the heavy cutoff on, before taking the lock', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { schedule: { heavyCutoffUtc: '09:30' } } });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED nothing heavy after 09:30 UTC (now 2030-01-08 10:00)'], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it('waits for a held lock, and refuses when the wait ran past the cutoff', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { schedule: { heavyCutoffUtc: '10:30' } } });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08T10:00:00.000Z waiting for the host lock: po (heavy: build) since 2030-01-08 09:50', 'REFUSED nothing heavy after 10:30 UTC (now 2030-01-08 10:40)'],
      stderr: [],
    });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it('refuses when the lock is still held after the wait, leaving it to its holder', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08T10:00:00.000Z waiting for the host lock: po (heavy: build) since 2030-01-08 09:50', 'REFUSED host lock still held by po (heavy: build) since 2030-01-08 09:50'],
      stderr: [],
    });
    assert.deepEqual(kit.clock.sleeps, Array.from({ length: MINUTE / FIRST_IN_LINE_POLL_MS }, () => FIRST_IN_LINE_POLL_MS), 'the first in line looks every 2 s');
    assert.equal(kit.files.get(LOCK), heldBy());
  });

  it('records when the step began to wait and what its process tree and the host held while it ran', async () => {
    const { kit, steps } = harness();
    steps.ends(0, 5 * MINUTE);
    const memory = new FakeHostMemory().measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    assert.equal((await kit.run(BUILD, { steps, memory, sessionProcesses: otherRuns() })).code, 0);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }], "its own process's tree, every 15 s");
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:03:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:08:00.000Z', exitCode: 0, peakTreeMb: 1900, lowFreeMb: 6400 }]);
  });

  it('watches no memory when the config samples it every 0 seconds', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { memorySampleSeconds: 0 } } });
    const memory = new FakeHostMemory().measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    assert.equal((await kit.run(BUILD, { steps, memory })).code, 0);
    assert.deepEqual(memory.watches, []);
    assert.equal(ledgerOf(kit).some((record) => JSON.stringify(record).includes('peakTreeMb')), false);
  });

  it('takes over a lock its process left behind', async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK)], [0, 'DONE exit 0', undefined]);
  });

  it("gives its command the lock's token, so a heavy step the command starts runs under this lock", async () => {
    const { kit, steps } = harness();
    await kit.run(BUILD, { steps });
    assert.equal(steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], 'id-1');
  });

  it("runs a step its parent's live lock covers at once, in the parent's session, without a ledger record", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(['heavy', '--what', 'pre-commit checks', '--', 'npm', 'test'], {
      steps: steps.ends(0, MINUTE),
      sessionProcesses: otherRuns(),
      env: { TEAMRIG_HOST_LOCK: 'other' },
    });
    assert.deepEqual(result, {
      code: 0,
      stdout: ['2030-01-08T10:00:00.000Z running: pre-commit checks under the host lock of po (heavy: build) since 2030-01-08 09:50 (killed after 45m)', 'DONE exit 0'],
      stderr: [],
    });
    assert.deepEqual([steps.ran.length, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], kit.clock.sleeps], [1, 'other', []]);
    assert.deepEqual([kit.files.get(LOCK), kit.files.get(LEDGER)], [heldBy(), undefined], "the parent's lock stays, and its record covers the step");
  });

  it('runs under a parent lock even from the heavy cutoff on, since its parent started before it', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { schedule: { heavyCutoffUtc: '09:30' } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.deepEqual([result.code, steps.ran.length], [0, 1]);
  });

  /** The lock taken carries its ticket's token, also when taking it first removes a lock left behind. */
  for (const [label, lock] of [
    ['a lock its process left behind', heldBy()],
    ['no lock at all', undefined],
  ] as const) {
    it(`takes the lock as usual when $TEAMRIG_HOST_LOCK names ${label}`, async () => {
      const { kit, steps } = harness();
      if (lock !== undefined) {
        await kit.files.write(LOCK, lock);
      }
      const result = await kit.run(BUILD, { steps, env: { TEAMRIG_HOST_LOCK: 'other' } });
      assert.deepEqual(result.stdout.slice(0, 2), [
        '2030-01-08T10:00:00.000Z $TEAMRIG_HOST_LOCK names no live host lock: taking the lock as usual',
        '2030-01-08T10:00:00.000Z running: build api (killed after 45m)',
      ]);
      assert.deepEqual([result.code, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], ledgerOf(kit).length], [0, 'id-1', 2]);
    });
  }

  it('waits for a live lock whose token is not the one in $TEAMRIG_HOST_LOCK', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'someone-else' } });
    assert.deepEqual([result.code, steps.ran, kit.files.get(LOCK)], [2, [], heldBy()]);
  });

  it('takes the session this Claude Code tab is bound to when none is named', async () => {
    const { kit, steps } = harness();
    const tab = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' };
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: tab });
    const result = await kit.run(['heavy', '--what', 'pre-commit checks', '--', 'npm', 'test'], { steps, env: tab });
    assert.equal(result.code, 0);
    assert.deepEqual(
      ledgerOf(kit).map((record) => JSON.stringify(record).includes('"session":"alpha"')),
      [true, true],
    );
  });

  it('prints the usage when no session is named and the tab is bound to none', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['heavy', '--what', 'build', '--', 'npm', 'test'], { steps, env: { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' } });
    assert.deepEqual([result.code, steps.ran], [64, []]);
  });

  it("keeps the lock and ledger where the team's config puts them", async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { dir: 'data/deploys', heavy: { lockPath: 'data/deploys/host.lock' } } });
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
    const result = await kit.run(['heavy', '--session', 'zulu', '--what', 'build', '--', 'npm', 'test'], { steps });
    assert.equal(result.code, 2);
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
  });

  for (const [label, argv] of [
    ['no session', ['heavy', '--what', 'build', '--', 'npm', 'test']],
    ['no label', ['heavy', '--session', 'alpha', '--', 'npm', 'test']],
    ['no command', ['heavy', '--session', 'alpha', '--what', 'build', '--']],
    ['a word before --', ['heavy', '--session', 'alpha', '--what', 'build', 'npm', '--', 'test']],
  ] as const) {
    it(`prints the usage for ${label}`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(argv, { steps });
      assert.equal(result.code, 64);
      assert.deepEqual(steps.ran, []);
    });
  }
});

describe('teamrig heavy --small', () => {
  it('shares the host instead of taking the lock, holds its share while it runs and records it as shared', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [kit.files.get(LOCK), JSON.parse(kit.files.get(`${SHARED}/id-1.json`) ?? '{}')];
    });
    const result = await kit.run(SPECS, { steps });
    const lines = ['2030-01-08T10:00:00.000Z sharing the host: 2048 MB held for it (8000 MB free, 0 other small steps)', '2030-01-08T10:00:00.000Z running: specs (killed after 45m)', 'DONE exit 0'];
    assert.deepEqual(result, { code: 0, stdout: lines, stderr: [] });
    const share = { token: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: specs', acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', reserveMb: 2048 };
    assert.deepEqual(whileRunning, [undefined, share]);
    assert.equal(kit.files.get(`${SHARED}/id-1.json`), undefined, 'the share is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'specs', queuedAt: '2030-01-08T10:00:00.000Z', shared: true, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:00.000Z', exitCode: 0 }]);
  });

  it('holds for it the most its latest 20 runs under the same session and label held, with a quarter more', async () => {
    const { kit, steps } = harness();
    const runs = [ranBefore('alpha', 'specs', 9000), ...Array.from({ length: 19 }, () => ranBefore('alpha', 'specs', 1000)), ranBefore('alpha', 'specs', 1900)];
    await kit.files.append(LEDGER, `${[...runs, ranBefore('bravo', 'specs', 9000), ranBefore('alpha', 'lint', 9000)].join('\n')}\n`);
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps });
    assert.equal(stdout[0], '2030-01-08T10:00:00.000Z sharing the host: 2375 MB held for it (8000 MB free, 0 other small steps)');
  });

  it('joins a small step sharing the host while the memory allows it', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { smallReserveMb: 1000, memoryFloorMb: 4000 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], '2030-01-08T10:00:00.000Z sharing the host: 1000 MB held for it (8000 MB free, 1 other small step)');
  });

  it('waits while the small steps sharing the host hold the memory it needs, then refuses', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const memory = new FakeHostMemory();
    memory.free = 6000;
    const result = await kit.run(SPECS, { steps, memory, sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50; 6000 MB free, 2048 MB held for it, 6144 MB needed';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08T10:00:00.000Z waiting to share the host: ${held}`, `REFUSED host memory still held by ${held}`], stderr: [] });
    assert.deepEqual([ledgerOf(kit), kit.files.get(`${SHARED}/id-1.json`)], [[], undefined]);
  });

  it('makes a step without it wait for the small steps sharing the host, then refuse, leaving no lock', async () => {
    const { kit, steps } = harness({ ...TEAM, coordinator: { heavy: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08T10:00:00.000Z waiting for the host lock: ${held}`, `REFUSED host lock still held by ${held}`], stderr: [] });
    assert.equal(kit.files.get(LOCK), undefined);
  });
});

