import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { exitCodeOf, nodeStepRunner, TIMED_OUT_EXIT } from './steps.ts';

describe('exitCodeOf', () => {
  it('records a step’s own exit code, 124 for one killed at its limit and 1 for one a signal stopped', () => {
    assert.equal(exitCodeOf({ kind: 'exited', code: 3 }), 3);
    assert.equal(exitCodeOf({ kind: 'timedOut' }), TIMED_OUT_EXIT);
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

  it('kills the step with every process it started once its time is up', async () => {
    const marker = join(dir, 'grandchild-lived');
    await writeFile(join(dir, 'grandchild.cjs'), `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'), 1500);`);
    await writeFile(join(dir, 'child.cjs'), `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'grandchild.cjs'))}], { stdio: 'ignore' }); setInterval(() => undefined, 1000);`);
    const end = await runner.run({ command: 'node child.cjs', cwd: dir, env: process.env, timeoutMs: 500 });
    assert.deepEqual(end, { kind: 'timedOut' });
    await wait(2_500);
    assert.equal(existsSync(marker), false, 'the grandchild was killed with its parent');
  });

  it('rejects when the step cannot start', async () => {
    await assert.rejects(runner.run({ command: 'node -e "0"', cwd: join(dir, 'missing'), env: process.env, timeoutMs: 30_000 }));
  });
});
