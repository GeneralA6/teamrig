import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { nodeTreeKill, type TreeKill } from '../../src/delivery/tree-kill.ts';
import { hangFinding, hasRunnerHangBug, runSuite, watchSuite, type SuiteChild, type SuiteEcho, type SuiteEnd } from './suite-run.ts';

/** A suite the test drives: it writes to its streams and emits `close` or `error` itself. */
class FakeSuiteChild extends EventEmitter implements SuiteChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  /** Each signal sent through its handle: the tree kill's own fallback, never the watch's. */
  readonly signals: NodeJS.Signals[] = [];

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

/** A stream that keeps what is written to it. */
class Collected extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    done();
  }

  text(): string {
    return this.chunks.join('');
  }
}

function echoes(): SuiteEcho & { readonly out: Collected; readonly err: Collected } {
  return { out: new Collected(), err: new Collected() };
}

/** A tree kill that records each pid and settles only when the test releases it. */
function heldKill(): { readonly kill: TreeKill; readonly pids: (number | undefined)[]; release(): void } {
  const pids: (number | undefined)[] = [];
  let release = (): void => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    kill: (held) => {
      pids.push(held.pid);
      return done;
    },
    pids,
    release: () => release(),
  };
}

/** Lets stream events and settled promises run; immediates are not faked by the timers mock. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Whether the promise has settled by now. */
async function settled(promise: Promise<SuiteEnd>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await flush();
  return done;
}

describe('watchSuite', () => {
  it('echoes stdout and stderr as they come and reports the exit status', async () => {
    const child = new FakeSuiteChild(4321);
    const echo = echoes();
    const held = heldKill();
    const end = watchSuite(child, 1_000, held.kill, echo);
    child.stdout.write('▶ files\n');
    child.stderr.write('a warning\n');
    await flush();
    child.emit('close', 3);
    assert.deepEqual(await end, { kind: 'exited', status: 3 });
    assert.equal(echo.out.text(), '▶ files\n');
    assert.equal(echo.err.text(), 'a warning\n');
    assert.deepEqual(held.pids, []);
  });

  it('kills the tree once the suite is silent for the limit, each output starting the limit again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = new FakeSuiteChild(77);
    const held = heldKill();
    const end = watchSuite(child, 1_000, held.kill, echoes());
    t.mock.timers.tick(999);
    child.stderr.write('still running\n');
    await flush();
    t.mock.timers.tick(999);
    assert.deepEqual(held.pids, [], 'output 999 ms ago keeps the suite alive');
    t.mock.timers.tick(1);
    assert.deepEqual(held.pids, [77]);
    child.stdout.write('a last line while it dies\n');
    await flush();
    t.mock.timers.tick(1_000);
    assert.deepEqual(held.pids, [77], 'output after the kill starts no second one');
    child.emit('close', null);
    assert.equal(await settled(end), false, 'the end waits for the kill to finish');
    held.release();
    assert.deepEqual(await end, { kind: 'idle', idleMs: 1_000 });
  });

  it('hands a silent suite that has no pid to the kill, which ends nothing, and reports it idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = new FakeSuiteChild(undefined);
    const end = watchSuite(child, 500, nodeTreeKill(process.platform), echoes());
    t.mock.timers.tick(500);
    child.emit('close', null);
    assert.deepEqual(await end, { kind: 'idle', idleMs: 500 });
    assert.deepEqual(child.signals, []);
  });

  it('rejects when the suite cannot start, and kills nothing later', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = new FakeSuiteChild(4321);
    const held = heldKill();
    const end = watchSuite(child, 500, held.kill, echoes());
    child.emit('error', new Error('spawn ENOENT'));
    await assert.rejects(end, /spawn ENOENT/);
    t.mock.timers.tick(500);
    assert.deepEqual(held.pids, []);
  });
});

describe('runSuite', () => {
  const kill = nodeTreeKill(process.platform);

  it('runs a real program, echoes its output and reports its exit status', async () => {
    const echo = echoes();
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;";
    const end = await runSuite({ program: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env, idleMs: 60_000 }, process.platform, kill, echo);
    assert.deepEqual(end, { kind: 'exited', status: 3 });
    assert.equal(echo.out.text(), 'out');
    assert.equal(echo.err.text(), 'err');
  });

  it('kills a real program that prints once and then never ends', async () => {
    const echo = echoes();
    const script = "process.stdout.write('started'); setInterval(() => {}, 1000);";
    const end = await runSuite({ program: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env, idleMs: 500 }, process.platform, kill, echo);
    assert.deepEqual(end, { kind: 'idle', idleMs: 500 });
    assert.equal(echo.out.text(), 'started');
  });
});

describe('hasRunnerHangBug', () => {
  it('holds for every Node before the fix: 22.x, 24 before 24.18, 25, and 26 before 26.2', () => {
    for (const version of ['20.19.0', '22.19.0', '22.23.4', '24.17.0', '25.9.0', '26.1.0']) {
      assert.equal(hasRunnerHangBug(version), true, version);
    }
    for (const version of ['24.18.0', '24.22.1', '26.2.0', '27.0.0']) {
      assert.equal(hasRunnerHangBug(version), false, version);
    }
  });
});

describe('hangFinding', () => {
  it('names the Node runner bug when this Node has it', () => {
    assert.equal(
      hangFinding(300_000, '22.19.0'),
      "the test run printed nothing for 300 s and was stopped with every process it started; Node 22.19.0's test runner can loop forever on a test file's output (nodejs/node#62704): run the gate on Node 24.18 or later",
    );
  });

  it('points at a test file that never ends on a Node without the bug', () => {
    assert.equal(
      hangFinding(1_000, '24.22.1'),
      'the test run printed nothing for 1 s and was stopped with every process it started; find the test file that never ends, one the run never reported',
    );
  });
});
