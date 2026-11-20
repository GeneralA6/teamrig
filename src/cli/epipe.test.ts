import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ignoreClosedPipe, processOutput } from './node-main.ts';

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

describe('ignoreClosedPipe', () => {
  /** A stream error with the given errno code, as node raises it on a failed write. */
  function streamError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`write ${code}`), { code });
  }

  it('swallows EPIPE, so a closed reader ends no run', () => {
    const stream = new PassThrough();
    ignoreClosedPipe(stream);
    assert.doesNotThrow(() => stream.emit('error', streamError('EPIPE')));
  });

  it('throws any other stream error as before', () => {
    const stream = new PassThrough();
    ignoreClosedPipe(stream);
    assert.throws(() => stream.emit('error', streamError('EIO')), /write EIO/);
  });

  it('gives a signal that aborts at the EPIPE, so a command that only prints can end with its reader', () => {
    const stream = new PassThrough();
    const closed = ignoreClosedPipe(stream);
    assert.equal(closed.aborted, false);
    stream.emit('error', streamError('EPIPE'));
    assert.equal(closed.aborted, true);
  });

  it('leaves the signal alone at any other stream error', () => {
    const stream = new PassThrough();
    const closed = ignoreClosedPipe(stream);
    assert.throws(() => stream.emit('error', streamError('EIO')));
    assert.equal(closed.aborted, false);
  });
});

describe('processOutput', () => {
  it("carries stdout's signal as the output's closed", () => {
    const closed = new AbortController();
    assert.equal(processOutput(closed.signal).closed, closed.signal);
  });
});
