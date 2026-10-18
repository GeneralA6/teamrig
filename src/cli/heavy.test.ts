import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FakeSteps } from '../testing/fake-steps.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
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
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
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
    assert.deepEqual(ledgerOf(kit)[1], { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', startedAt: '2030-01-08T10:00:00.000Z', endedAt: '2030-01-08T10:45:00.000Z', exitCode: 124 });
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
    assert.deepEqual(kit.clock.sleeps, [30_000, 30_000]);
    assert.equal(kit.files.get(LOCK), heldBy());
  });

  it('takes over a lock its process left behind', async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK)], [0, 'DONE exit 0', undefined]);
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
