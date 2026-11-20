import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProgramOutputCapError, nodeProgramRunner } from './program-runner.ts';

/** Long enough for a Node start on a loaded host; the stop spec sets its own short limit. */
const LIMIT_MS = 30_000;

describe('nodeProgramRunner', () => {
  it('runs a program with no shell and gives its end, stdout and stderr', async () => {
    const result = await nodeProgramRunner(LIMIT_MS)({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'],
    });
    assert.deepEqual(result, { end: { kind: 'exited', code: 3 }, stdout: 'out', stderr: 'err' });
  });

  it('runs the program in the environment the request sets, and in its own when it sets none', async () => {
    const print = ['-e', 'process.stdout.write(process.env.TEAMRIG_PROGRAM_PROBE ?? "unset")'];
    const set = await nodeProgramRunner(LIMIT_MS)({ program: process.execPath, args: print, env: { ...process.env, TEAMRIG_PROGRAM_PROBE: 'from the request' } });
    const own = await nodeProgramRunner(LIMIT_MS)({ program: process.execPath, args: print });
    assert.equal(set.stdout, 'from the request');
    assert.equal(own.stdout, 'unset');
  });

  it('rejects when the program is not there', async () => {
    await assert.rejects(nodeProgramRunner(LIMIT_MS)({ program: 'teamrig-no-such-program', args: [] }), { code: 'ENOENT' });
  });

  it('stops a program that outlives its time limit and gives the signal', async () => {
    const result = await nodeProgramRunner(200)({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    assert.deepEqual(result, { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
  });

  it('stops a program that prints more than its cap, stdout and stderr together, and uses none of it', async () => {
    const flood = ['-e', 'process.stderr.write("e".repeat(2048)); setInterval(() => process.stdout.write("o".repeat(1024)), 5)'];
    await assert.rejects(
      nodeProgramRunner(LIMIT_MS, 4096)({ program: process.execPath, args: flood }),
      new ProgramOutputCapError(process.execPath, 4096),
    );
  });

  it('gives all of an output that fits its cap exactly', async () => {
    const fits = ['-e', 'process.stdout.write("o".repeat(4000)); process.stderr.write("e".repeat(96))'];
    const result = await nodeProgramRunner(LIMIT_MS, 4096)({ program: process.execPath, args: fits });
    assert.deepEqual(result, { end: { kind: 'exited', code: 0 }, stdout: 'o'.repeat(4000), stderr: 'e'.repeat(96) });
  });

  it('reads whole a character that arrives split across two chunks', async () => {
    const split = ['-e', 'const b = Buffer.from("é"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 200)'];
    const result = await nodeProgramRunner(LIMIT_MS, 4096)({ program: process.execPath, args: split });
    assert.equal(result.stdout, 'é');
  });

  it('names the program and the cap in the error of a stopped run', () => {
    assert.equal(new ProgramOutputCapError('gh', 4096).message, 'gh printed more than 4096 bytes, so teamrig stopped it and used none of it');
  });
});
