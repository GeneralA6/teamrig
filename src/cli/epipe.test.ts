import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('main.ts', import.meta.url));

interface Ended {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs the real entry with long output (`help`) and closes the reading end before the child has started writing. */
function runClosedEarly(): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, 'help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    // Node takes far longer to start than this takes to run, so every write the child makes meets a closed pipe.
    child.stdout.destroy();
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('stdout closed early (`teamrig show T1 | head -2`)', () => {
  it('exits quietly: no EPIPE, no stack', async () => {
    const ended = await runClosedEarly();
    assert.doesNotMatch(ended.stderr, /EPIPE|\n\s+at /);
    assert.equal(ended.status, 0, ended.stderr);
  });
});
