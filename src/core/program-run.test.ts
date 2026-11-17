import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeProgramRunner } from './program-run.ts';

/** Long enough for a node start on a loaded machine. */
const TIMEOUT_MS = 30_000;

describe('nodeProgramRunner', () => {
  it('runs a program with no shell and gives its end, stdout and stderr', async () => {
    const result = await nodeProgramRunner(TIMEOUT_MS)({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'],
    });
    assert.deepEqual(result, { end: { kind: 'exited', code: 3 }, stdout: 'out', stderr: 'err' });
  });

  it('rejects when the program is not there', async () => {
    await assert.rejects(nodeProgramRunner(TIMEOUT_MS)({ program: 'teamrig-no-such-program', args: [] }), { code: 'ENOENT' });
  });
});
