import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { exitCodeOf, nodeStepRunner, nodeTreeKill, STOPPED_EXIT, TIMED_OUT_EXIT, type TreeKill } from './steps.ts';

/**
 * The real tree kill, held until `started` exists: under load the shell can take longer than a short limit to start
 * the step's grandchild, and a kill that lands while it is being started can miss it (T645). Waits at most 10 s.
 */
function killOnceStarted(started: string, kill: TreeKill): TreeKill {
  return (pid) => {
    void (async () => {
      for (let tries = 0; tries < 200 && !existsSync(started); tries += 1) {
        await wait(50);
      }
      kill(pid);
    })();
  };
}

/** Whether process `pid` runs: signal 0 only checks, and EPERM means it runs as another user. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Whether process `pid` ends within `ms`: a tree kill returns before the last process in it has ended. */
async function endsWithin(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms && isRunning(pid); waited += 50) {
    await wait(50);
  }
  return !isRunning(pid);
}

describe('exitCodeOf', () => {
  it('records a step’s own exit code, 124 for one killed at its limit, 129 for one its stop killed and 1 for one a signal stopped', () => {
    assert.equal(exitCodeOf({ kind: 'exited', code: 3 }), 3);
    assert.equal(exitCodeOf({ kind: 'timedOut' }), TIMED_OUT_EXIT);
    assert.equal(exitCodeOf({ kind: 'stopped' }), STOPPED_EXIT);
    assert.equal(exitCodeOf({ kind: 'signal', signal: 'SIGTERM' }), 1);
  });
});

describe('nodeStepRunner', () => {
  let dir = '';
  const runner = nodeStepRunner(process.platform);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'teamrig-steps-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the command line in the shell and returns its exit code', async () => {
    const end = await runner.run({ command: 'node -e "process.exit(3)"', cwd: dir, env: process.env, timeoutMs: 30_000 });
    assert.deepEqual(end, { kind: 'exited', code: 3 });
  });

  it('runs in the folder and environment it is given', async () => {
    const script = 'process.exit(process.cwd() === process.argv[2] && process.env.HEAVY_PROBE === "yes" ? 0 : 5)';
    await writeFile(join(dir, 'probe.cjs'), script);
    const end = await runner.run({ command: `node probe.cjs "${dir}"`, cwd: dir, env: { ...process.env, HEAVY_PROBE: 'yes' }, timeoutMs: 30_000 });
    assert.deepEqual(end, { kind: 'exited', code: 0 });
  });

  /** A step that starts a grandchild, which writes its pid to `started` once it runs, then idles 10 s. */
  async function stepWithGrandchild(started: string): Promise<string> {
    await writeFile(join(dir, 'grandchild.cjs'), `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => undefined, 10_000);`);
    await writeFile(join(dir, 'child.cjs'), `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'grandchild.cjs'))}, process.argv[2]], { stdio: 'ignore' }); setInterval(() => undefined, 1000);`);
    return `node child.cjs "${started}"`;
  }

  it('kills the step with every process it started once its time is up', async () => {
    const started = join(dir, 'timed-out-grandchild-started');
    const killing = nodeStepRunner(process.platform, killOnceStarted(started, nodeTreeKill(process.platform)));
    const end = await killing.run({ command: await stepWithGrandchild(started), cwd: dir, env: process.env, timeoutMs: 500 });
    assert.deepEqual(end, { kind: 'timedOut' });
    const grandchild = Number(await readFile(started, 'utf8'));
    assert.equal(await endsWithin(grandchild, 5_000), true, 'the grandchild was killed with its parent');
  });

  it('kills the step with every process it started once its stop aborts, well before its time is up', async () => {
    const started = join(dir, 'stopped-grandchild-started');
    const killing = nodeStepRunner(process.platform, killOnceStarted(started, nodeTreeKill(process.platform)));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 500);
    const end = await killing.run({ command: await stepWithGrandchild(started), cwd: dir, env: process.env, timeoutMs: 60_000, stop: stop.signal });
    assert.deepEqual(end, { kind: 'stopped' });
    const grandchild = Number(await readFile(started, 'utf8'));
    assert.equal(await endsWithin(grandchild, 5_000), true, 'the grandchild was killed with its parent');
  });

  it('kills a step at once whose stop aborted before it started', async () => {
    const started = Date.now();
    const end = await runner.run({ command: 'node -e "setTimeout(() => undefined, 30000)"', cwd: dir, env: process.env, timeoutMs: 60_000, stop: AbortSignal.abort() });
    assert.deepEqual(end, { kind: 'stopped' });
    assert.ok(Date.now() - started < 20_000, 'it never ran its course');
  });

  it('ends as its command did when its stop aborts only after it', async () => {
    const stop = new AbortController();
    const end = await runner.run({ command: 'node -e "process.exit(4)"', cwd: dir, env: process.env, timeoutMs: 30_000, stop: stop.signal });
    stop.abort();
    assert.deepEqual(end, { kind: 'exited', code: 4 });
  });

  it('rejects when the step cannot start', async () => {
    await assert.rejects(runner.run({ command: 'node -e "0"', cwd: join(dir, 'missing'), env: process.env, timeoutMs: 30_000 }));
  });
});
