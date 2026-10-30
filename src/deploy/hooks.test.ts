import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { STEP_PRIORITY } from '../delivery/priority.ts';
import { nodeTreeKill } from '../delivery/tree-kill.ts';
import { hookEndText, hookExitCode, nodeHookRunner, succeeded, type HookEnd, type HookRequest } from './hooks.ts';

const ENDS: readonly HookEnd[] = [{ kind: 'exited', code: 3 }, { kind: 'timedOut' }, { kind: 'signal', signal: 'SIGKILL' }, { kind: 'notStarted', error: 'ENOENT' }, { kind: 'stopped' }];

describe('hook ends', () => {
  it('records a hook’s own code, 124 at its time limit, 1 for a signal or a hook that did not start, and 129 for one its stop killed', () => {
    assert.deepEqual(ENDS.map(hookExitCode), [3, 124, 1, 1, 129]);
  });

  it('says how each ended, and succeeds only on exit 0', () => {
    assert.deepEqual(ENDS.map(hookEndText), ['exited 3', 'was killed at its time limit', 'was stopped by SIGKILL', 'could not start (ENOENT)', 'was killed when its launching shell ended']);
    assert.deepEqual([{ kind: 'exited', code: 0 } as const, ...ENDS].map(succeeded), [true, false, false, false, false, false]);
  });
});

/** A real run of this Node binary with `script`: the runner's own spawn, with no shell. */
function request(script: string, overrides: Partial<HookRequest> = {}): { readonly lines: string[]; readonly request: HookRequest } {
  const lines: string[] = [];
  return {
    lines,
    request: { argv: [process.execPath, '-e', script], cwd: process.cwd(), env: { ...process.env, HOOK_PROBE: 'set' }, timeoutMs: 10_000, onLine: (line) => lines.push(line), ...overrides },
  };
}

describe('nodeHookRunner', () => {
  const runner = nodeHookRunner(process.platform);

  it('streams each stdout line, the last one without a newline too, and ends with the exit code', async () => {
    const { lines, request: run } = request('process.stdout.write("first\\r\\nsecond\\n" + process.env.HOOK_PROBE); process.exitCode = 75;');
    assert.deepEqual(await runner.run(run), { kind: 'exited', code: 75 });
    assert.deepEqual(lines, ['first', 'second', 'set']);
  });

  it('passes each argument as one word, read by no shell', async () => {
    const { lines, request: run } = request('console.log(JSON.stringify(process.argv.slice(1)))', {});
    const words = ['a && echo injected', '%PATH%', '$HOME', '"quoted"'];
    assert.deepEqual(await runner.run({ ...run, argv: [...run.argv, ...words] }), { kind: 'exited', code: 0 });
    assert.deepEqual(lines, [JSON.stringify(words)]);
  });

  it('closes stdin, so a hook that reads it ends at once', async () => {
    const { lines, request: run } = request('let n = 0; process.stdin.on("data", (d) => { n += d.length; }); process.stdin.on("end", () => console.log("read " + n));');
    assert.deepEqual(await runner.run(run), { kind: 'exited', code: 0 });
    assert.deepEqual(lines, ['read 0']);
  });

  it('kills a hook at its time limit', async () => {
    const { request: run } = request('setInterval(() => undefined, 1000)', { timeoutMs: 300 });
    assert.deepEqual(await runner.run(run), { kind: 'timedOut' });
  });

  it('kills a hook once its stop aborts, well before its time is up, and one whose stop aborted before it started', async () => {
    const stop = new AbortController();
    const { request: run } = request('setInterval(() => undefined, 1000)', { timeoutMs: 60_000, stop: stop.signal });
    setTimeout(() => stop.abort(), 300);
    assert.deepEqual(await runner.run(run), { kind: 'stopped' });
    assert.deepEqual(await runner.run(run), { kind: 'stopped' });
  });

  it('reports a program that cannot start, and an empty command', async () => {
    const { request: run } = request('');
    const missing = await runner.run({ ...run, argv: ['teamrig-no-such-program-0f8e2c4a'] });
    assert.equal(missing.kind, 'notStarted');
    assert.deepEqual(await runner.run({ ...run, argv: [] }), { kind: 'notStarted', error: 'no program to run' });
  });

  it('lowers the hook it started to below-normal priority', async () => {
    const lowered: Array<readonly [number, number]> = [];
    const recording = nodeHookRunner(process.platform, nodeTreeKill(process.platform), {
      of: () => constants.priority.PRIORITY_NORMAL,
      set: (pid, priority) => lowered.push([pid, priority]),
    });
    assert.deepEqual(await recording.run(request('').request), { kind: 'exited', code: 0 });
    assert.equal(lowered.length, 1);
    assert.equal(lowered[0]?.[1], STEP_PRIORITY);
  });

  it('runs its hook at below-normal priority on this host', async () => {
    const { lines, request: run } = request('console.log(require("node:os").getPriority())');
    assert.deepEqual(await runner.run(run), { kind: 'exited', code: 0 });
    assert.deepEqual(lines, [String(STEP_PRIORITY)]);
  });
});
