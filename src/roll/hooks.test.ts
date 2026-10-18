import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeHookRunner, type HookRequest } from './hooks.ts';

/** A real run of this Node binary with `script`: the runner's own spawn, with no shell. */
function request(script: string, overrides: Partial<HookRequest> = {}): { readonly lines: string[]; readonly request: HookRequest } {
  const lines: string[] = [];
  return {
    lines,
    request: { argv: [process.execPath, '-e', script], cwd: process.cwd(), env: { ...process.env, ROLL_PROBE: 'set' }, timeoutMs: 10_000, onLine: (line) => lines.push(line), ...overrides },
  };
}

describe('nodeHookRunner', () => {
  const runner = nodeHookRunner(process.platform);

  it('streams each stdout line, the last one without a newline too, and ends with the exit code', async () => {
    const { lines, request: run } = request('process.stdout.write("first\\r\\nsecond\\n" + process.env.ROLL_PROBE); process.exitCode = 75;');
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

  it('reports a program that cannot start, and an empty command', async () => {
    const { request: run } = request('');
    const missing = await runner.run({ ...run, argv: ['teamrig-no-such-program-0f8e2c4a'] });
    assert.equal(missing.kind, 'notStarted');
    assert.deepEqual(await runner.run({ ...run, argv: [] }), { kind: 'notStarted', error: 'no program to run' });
  });
});
