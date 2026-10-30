import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { StartedProcess, SweepHost } from '../coordinator/tree-kill.ts';
import { endingOf, livenessOf, parseWrittenProcess, signalPidCheck, signalPidKill, type PidCheck, type PidKill } from './process-liveness.ts';

/** A host that lists `rows`, or cannot list when they are undefined. */
const listing = (rows: readonly StartedProcess[] | undefined) => ({ list: () => Promise.resolve(rows) });

/** A host that lists `rows`, or cannot list when they are undefined, counting its lists and recording each kill. */
class KillingHost implements Pick<SweepHost, 'list' | 'kill'> {
  lists = 0;
  readonly kills: (readonly StartedProcess[])[] = [];
  private readonly rows: readonly StartedProcess[] | undefined;

  constructor(rows: readonly StartedProcess[] | undefined) {
    this.rows = rows;
  }

  list(): Promise<readonly StartedProcess[] | undefined> {
    this.lists += 1;
    return Promise.resolve(this.rows);
  }

  kill(targets: readonly StartedProcess[]): Promise<void> {
    this.kills.push(targets);
    return Promise.resolve();
  }
}

const killingHost = (rows: readonly StartedProcess[] | undefined): KillingHost => new KillingHost(rows);

/** A pid kill that records each pid it was asked to end. */
function pidKillRecorder(): PidKill & { readonly killed: number[] } {
  const killed: number[] = [];
  return Object.assign((pid: number) => {
    killed.push(pid);
  }, { killed });
}

/** A pid check that answers `answer` and records each pid it was asked about. */
function pidCheckAnswering(answer: boolean): PidCheck & { readonly asked: number[] } {
  const asked: number[] = [];
  return Object.assign((pid: number) => {
    asked.push(pid);
    return answer;
  }, { asked });
}

const written = { pid: 4242, writtenMs: 1_000_000 };

describe('parseWrittenProcess', () => {
  it('reads a pid and the time it wrote, and nothing from other text', () => {
    assert.deepEqual(parseWrittenProcess('4242 1000000\n'), written);
    assert.equal(parseWrittenProcess('4242'), undefined);
    assert.equal(parseWrittenProcess('4242 soon'), undefined);
  });
});

describe('livenessOf', () => {
  it('on Windows counts a process with its id that started before it wrote as running', async () => {
    const runs = livenessOf('win32', listing([{ pid: 4242, parent: 7, startedMs: 999_900 }]), pidCheckAnswering(false));
    assert.equal(await runs(written), true);
  });

  it('on Windows counts a process given its id after it ended as a stranger, not as it running on', async () => {
    const pidCheck = pidCheckAnswering(true);
    const runs = livenessOf('win32', listing([{ pid: 4242, parent: 7, startedMs: 1_000_500 }]), pidCheck);
    assert.equal(await runs(written), false);
    assert.deepEqual(pidCheck.asked, []);
  });

  it('on Windows counts a process no listed process holds the id of as ended', async () => {
    const runs = livenessOf('win32', listing([{ pid: 17, parent: 7, startedMs: 999_900 }]), pidCheckAnswering(true));
    assert.equal(await runs(written), false);
  });

  it('asks signal 0 when Windows cannot list its processes', async () => {
    const pidCheck = pidCheckAnswering(true);
    assert.equal(await livenessOf('win32', listing(undefined), pidCheck)(written), true);
    assert.deepEqual(pidCheck.asked, [4242]);
  });

  it('asks signal 0 on POSIX, which does not reuse an id that soon', async () => {
    const pidCheck = pidCheckAnswering(false);
    assert.equal(await livenessOf('linux', listing([{ pid: 4242, parent: 7, startedMs: 999_900 }]), pidCheck)(written), false);
    assert.deepEqual(pidCheck.asked, [4242]);
  });
});

describe('endingOf', () => {
  it('on Windows ends the listed writer by its id and start, and signals nothing', async () => {
    const writer = { pid: 4242, parent: 7, startedMs: 999_900 };
    const host = killingHost([{ pid: 17, parent: 7, startedMs: 999_000 }, writer]);
    const pidKill = pidKillRecorder();
    await endingOf('win32', host, pidKill)(written);
    assert.deepEqual([host.kills, pidKill.killed], [[[writer]], []]);
  });

  it('on Windows leaves alone a stranger given the id after the writer ended', async () => {
    const host = killingHost([{ pid: 4242, parent: 7, startedMs: 1_000_500 }]);
    const pidKill = pidKillRecorder();
    await endingOf('win32', host, pidKill)(written);
    assert.deepEqual([host.kills, pidKill.killed], [[], []]);
  });

  it('on Windows ends nothing when the host cannot be listed, since the bare id may be a stranger’s', async () => {
    const host = killingHost(undefined);
    const pidKill = pidKillRecorder();
    await endingOf('win32', host, pidKill)(written);
    assert.deepEqual([host.kills, pidKill.killed], [[], []]);
  });

  it('on POSIX signals the id and lists nothing', async () => {
    const host = killingHost([]);
    const pidKill = pidKillRecorder();
    await endingOf('linux', host, pidKill)(written);
    assert.deepEqual([host.lists, host.kills, pidKill.killed], [0, [], [4242]]);
  });
});

describe('signalPidCheck', () => {
  it('finds this process running', () => {
    assert.equal(signalPidCheck(process.pid), true);
  });
});

describe('signalPidKill', () => {
  it('ends a running process', { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const exited = once(child, 'exit');
      const pid = child.pid;
      assert.ok(pid !== undefined, 'the child started');
      signalPidKill(pid);
      await exited;
    } finally {
      child.kill();
    }
  });

  it('takes an id no process holds as already ended', () => {
    assert.doesNotThrow(() => signalPidKill(2 ** 22 + 7));
  });
});
