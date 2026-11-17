import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_PID, CliHarness } from '../../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../../testing/fake-session-processes.ts';

const SCRIPT = 'C:\\kit\\dist\\cli\\main.js';
const STARTED = Date.parse('2030-01-08T09:00:00Z');

function launch(session: string): string {
  return `"C:\\node\\node.exe" ${SCRIPT} launch ${session} --team app --project C:\\w\\app --no-prompt`;
}

/** A terminal with two live tabs (alpha, and this CLI's own under beta), and two launchers whose terminal ended. */
function host(): FakeSessionProcesses {
  return new FakeSessionProcesses()
    .add({ pid: 10, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt' }, STARTED)
    .add({ pid: 20, parentPid: 10, name: 'node.exe', commandLine: launch('alpha') }, STARTED + 1_000)
    .add({ pid: 21, parentPid: 20, name: 'claude.exe', commandLine: 'claude' }, STARTED + 2_000)
    .add({ pid: 30, parentPid: 10, name: 'node.exe', commandLine: launch('beta') }, STARTED + 3_000)
    .add({ pid: CLI_PID, parentPid: 30, name: 'node.exe', commandLine: `node ${SCRIPT} cleanup launchers` }, STARTED + 4_000)
    .add({ pid: 40, parentPid: 11, name: 'node.exe', commandLine: launch('gamma') }, STARTED + 5_000)
    .add({ pid: 41, parentPid: 40, name: 'claude.exe', commandLine: 'claude' }, STARTED + 6_000)
    .add({ pid: 50, parentPid: 11, name: 'node.exe', commandLine: launch('delta') }, STARTED + 7_000);
}

describe('teamrig cleanup launchers', () => {
  it('without --yes prints each launcher and which lost their tab, and ends nothing', async () => {
    const processes = host();
    const result = await new CliHarness().run(['cleanup', 'launchers'], { sessionProcesses: processes });
    assert.equal(result.code, 0);
    assert.deepEqual(
      result.stdout.map((line) => line.split(',')[0]),
      ['LIVE pid 20 app/alpha', 'LIVE pid 30 app/beta', 'ORPHANED pid 40 app/gamma', 'ORPHANED pid 50 app/delta', '4 launcher(s)', 'DRY RUN ended nothing; run it again with --yes to end the 2 orphaned'],
    );
    assert.match(result.stdout[2] ?? '', /starter 11 \(gone\): its terminal has ended$/);
    assert.deepEqual(processes.ends, []);
  });

  it('with --yes ends each orphaned launcher and what it started, and leaves the live ones and its own tab', async () => {
    const processes = host();
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.equal(result.code, 0);
    assert.deepEqual(processes.ends, [{ pid: 40, how: 'force' }, { pid: 50, how: 'force' }]);
    assert.deepEqual(result.stdout.slice(-2), ['ENDED pid 40 gamma and the processes it started', 'ENDED pid 50 delta and the processes it started']);
    assert.deepEqual([processes.alive(41), processes.alive(20), processes.alive(30)], [false, true, true]);
  });

  it('leaves an id that runs something else by the time it would end it, and fails on a failed end', async () => {
    const processes = host().failEnd(50, 'access denied');
    // The census sees gamma at 40; by the end, 40 is notepad.
    processes.whenListed(() => processes.add({ pid: 40, parentPid: 1, name: 'notepad.exe', commandLine: 'notepad' }));
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.equal(result.code, 1);
    assert.deepEqual(processes.ends, [{ pid: 50, how: 'force' }]);
    assert.deepEqual(result.stdout.slice(-2), ['GONE pid 40 gamma: it had ended already', 'FAILED pid 50 delta: access denied']);
  });

  it('leaves an id a reopened tab of the same session took, by its other starter or its other start', async () => {
    const processes = host();
    // After the census, gamma's 40 is a new launch of gamma from a live terminal, and delta's 50 a new launch of delta
    // under the same (reused) starter id but started later.
    processes.whenListed(() =>
      processes
        .add({ pid: 40, parentPid: 10, name: 'node.exe', commandLine: launch('gamma') }, STARTED + 5_000)
        .add({ pid: 50, parentPid: 11, name: 'node.exe', commandLine: launch('delta') }, STARTED + 9_000),
    );
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.equal(result.code, 0);
    assert.deepEqual(processes.ends, []);
    assert.deepEqual(result.stdout.slice(-2), ['GONE pid 40 gamma: it had ended already', 'GONE pid 50 delta: it had ended already']);
  });

  it('ends nothing and fails when the start of an orphan cannot be re-read', async () => {
    const processes = host();
    processes.whenListed(() => processes.hideListing());
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.equal(result.code, 1);
    assert.deepEqual(processes.ends, []);
    assert.equal(result.stdout.at(-1), 'FAILED pid 50 delta: its start could not be re-read, so it was left running');
  });

  it("never ends its own tab's launcher, even when that one's terminal is gone", async () => {
    const processes = new FakeSessionProcesses()
      .add({ pid: 30, parentPid: 12, name: 'node.exe', commandLine: launch('beta') }, STARTED)
      .add({ pid: CLI_PID, parentPid: 30, name: 'node.exe', commandLine: `node ${SCRIPT} cleanup launchers` }, STARTED + 1_000);
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.deepEqual([result.code, result.stdout.at(-1), processes.ends], [0, '1 launcher(s), 0 orphaned', []]);
  });

  it('says none is orphaned and offers nothing when every launcher has its tab', async () => {
    const processes = new FakeSessionProcesses().add({ pid: 10, parentPid: 1, name: 'bash', commandLine: 'bash' }).add({ pid: 20, parentPid: 10, name: 'node', commandLine: `/usr/bin/node /opt/main.js launch api --team shop` });
    const result = await new CliHarness().run(['cleanup', 'launchers'], { sessionProcesses: processes });
    assert.deepEqual(result.stdout, ['LIVE pid 20 shop/api, start unknown, starter 10 bash', '1 launcher(s), 0 orphaned']);
  });

  it('fails and ends nothing when the processes cannot be listed', async () => {
    const processes = host().hideListing();
    const result = await new CliHarness().run(['cleanup', 'launchers', '--yes'], { sessionProcesses: processes });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, ["FAILED the host's processes could not be listed, so nothing was read or ended"]);
    assert.deepEqual(processes.ends, []);
  });
});
