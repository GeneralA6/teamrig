import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { STEP_PRIORITY } from './priority.ts';
import { exitCodeOf, nodeStepRunner, STOPPED_EXIT, TIMED_OUT_EXIT } from './steps.ts';
import { nodeTreeKill, type TreeKill } from './tree-kill.ts';
import { livenessOf, parseWrittenProcess, WRITE_PROCESS_SCRIPT, type WrittenProcess } from '../testing/process-liveness.ts';

/**
 * The real tree kill, held until `started` exists, so the spec kills a grandchild that runs, not a step whose shell
 * had yet to start it under load (T645). Waits at most 10 s; settles once the kill is done.
 */
function killOnceStarted(started: string, kill: TreeKill): TreeKill {
  return async (held) => {
    for (let tries = 0; tries < 200 && !existsSync(started); tries += 1) {
      await wait(50);
    }
    await kill(held);
  };
}

/** Whether a process the spec started still runs, told apart from a later process Windows gave its id (T990). */
const runs = livenessOf(process.platform);

/** Whether `written` ends within `ms`: a tree kill returns before the last process in it has ended. */
async function endsWithin(written: WrittenProcess, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms && (await runs(written)); waited += 50) {
    await wait(50);
  }
  return !(await runs(written));
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
    // Windows frees an ended step's hold on its folder (its working directory) a moment after the
    // process ends, so under load the first rmdir can meet EBUSY; rm retries those.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  /** A step that starts a grandchild, which writes its pid and the time to `started` once it runs, then idles 10 s. */
  async function stepWithGrandchild(started: string): Promise<string> {
    await writeFile(join(dir, 'grandchild.cjs'), `${WRITE_PROCESS_SCRIPT}; setTimeout(() => undefined, 10_000);`);
    await writeFile(join(dir, 'child.cjs'), `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'grandchild.cjs'))}, process.argv[2]], { stdio: 'ignore' }); setInterval(() => undefined, 1000);`);
    return `node child.cjs "${started}"`;
  }

  it('kills the step with every process it started once its time is up, before it reports the end', async () => {
    const pidFile = join(dir, 'timed-out-grandchild-started');
    const end = await runner.run({ command: await stepWithGrandchild(pidFile), cwd: dir, env: process.env, timeoutMs: 1_000 });
    assert.deepEqual(end, { kind: 'timedOut' });
    const grandchild = async (): Promise<WrittenProcess | undefined> => (existsSync(pidFile) ? parseWrittenProcess(await readFile(pidFile, 'utf8')) : undefined);
    const atEnd = await grandchild();
    // A grandchild still starting when the kill ran would write its id late and run on.
    await wait(1_000);
    const late = await grandchild();
    try {
      assert.equal(atEnd !== undefined && (await runs(atEnd)), false, 'the grandchild had ended when the step was reported');
      assert.equal(late !== undefined && (await runs(late)), false, 'no grandchild runs on after its step');
    } finally {
      if (late !== undefined && (await runs(late))) {
        process.kill(late.pid);
      }
    }
  });

  it('reports a step killed at its limit only once its kill is done', async () => {
    const events: string[] = [];
    const treeKill = nodeTreeKill(process.platform);
    const slowKill: TreeKill = async (held) => {
      await treeKill(held);
      await wait(200);
      events.push('kill done');
    };
    const end = await nodeStepRunner(process.platform, slowKill).run({ command: 'node -e "setInterval(() => undefined, 1000)"', cwd: dir, env: process.env, timeoutMs: 300 });
    events.push('reported');
    assert.deepEqual(end, { kind: 'timedOut' });
    assert.deepEqual(events, ['kill done', 'reported']);
  });

  it('kills the step with every process it started once its stop aborts, well before its time is up', async () => {
    const started = join(dir, 'stopped-grandchild-started');
    const killing = nodeStepRunner(process.platform, killOnceStarted(started, nodeTreeKill(process.platform)));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 500);
    const end = await killing.run({ command: await stepWithGrandchild(started), cwd: dir, env: process.env, timeoutMs: 60_000, stop: stop.signal });
    assert.deepEqual(end, { kind: 'stopped' });
    const grandchild = parseWrittenProcess(await readFile(started, 'utf8'));
    assert.ok(grandchild !== undefined, 'the grandchild wrote its pid and the time');
    assert.equal(await endsWithin(grandchild, 5_000), true, 'the grandchild was killed with its parent');
  });

  it('kills a step at once whose stop aborted before it started', async () => {
    const treeKill = nodeTreeKill(process.platform);
    const killed: (number | undefined)[] = [];
    const recording = nodeStepRunner(process.platform, (held) => {
      killed.push(held.pid);
      return treeKill(held);
    });
    const ranItsCourse = join(dir, 'aborted-step-ran-its-course');
    // A clock bound fails under load, where one tree kill can take 20 s (T990): the kill must begin while run starts
    // the step, and the step, killed, never writes the file it writes after 2 minutes.
    const running = recording.run({
      command: `node -e "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], ''), 120000)" "${ranItsCourse}"`,
      cwd: dir,
      env: process.env,
      timeoutMs: 300_000,
      stop: AbortSignal.abort(),
    });
    assert.equal(killed.length, 1, 'the kill began as the step started');
    assert.deepEqual(await running, { kind: 'stopped' });
    assert.equal(existsSync(ranItsCourse), false, 'it never ran its course');
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

  it('lowers the step it started to below-normal priority', async () => {
    const lowered: Array<readonly [number, number]> = [];
    const recording = nodeStepRunner(process.platform, nodeTreeKill(process.platform), {
      of: () => constants.priority.PRIORITY_NORMAL,
      set: (pid, priority) => lowered.push([pid, priority]),
    });
    await recording.run({ command: 'node -e "0"', cwd: dir, env: process.env, timeoutMs: 30_000 });
    assert.equal(lowered.length, 1);
    assert.equal(lowered[0]?.[1], STEP_PRIORITY);
  });

  it('runs the processes its step starts at below-normal priority on this host', async () => {
    const seen = join(dir, 'priority-seen');
    await writeFile(join(dir, 'priority.cjs'), 'require("node:fs").writeFileSync(process.argv[2], String(require("node:os").getPriority()))');
    const end = await runner.run({ command: `node priority.cjs "${seen}"`, cwd: dir, env: process.env, timeoutMs: 30_000 });
    assert.deepEqual(end, { kind: 'exited', code: 0 });
    assert.equal(Number(await readFile(seen, 'utf8')), STEP_PRIORITY);
  });
});
