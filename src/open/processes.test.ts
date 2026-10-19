import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitText, nodeProcesses, outcomeOfError } from './processes.ts';

const NODE = process.execPath;
const DIR = mkdtempSync(join(tmpdir(), 'teamrig-processes-'));
const MISSING = 'teamrig-no-such-program';
/** Launchers left running hold their working folder on Windows, so they start outside DIR. */
const TEMP = tmpdir();

after(() => rmSync(DIR, { recursive: true, force: true }));

/** Real child processes, each a short node script: nothing opens a terminal. */
describe('nodeProcesses', () => {
  const processes = nodeProcesses();

  it('starts a launcher that returns, and reports its exit code with its first error line', async () => {
    assert.deepEqual(await processes.start({ command: NODE, args: ['-e', ''], cwd: DIR, mode: 'exit' }), { kind: 'started' });
    const failed = await processes.start({ command: NODE, args: ['-e', 'console.error("no server running\\nmore"); process.exit(3)'], cwd: DIR, mode: 'exit' });
    assert.deepEqual(failed, { kind: 'failed', error: 'exited with code 3: no server running' });
  });

  it('counts a launcher still running after the wait as started', async () => {
    const quick = nodeProcesses({ exitWaitMs: 50 });
    assert.deepEqual(await quick.start({ command: NODE, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: TEMP, mode: 'exit' }), { kind: 'started' });
  });

  it('starts a terminal window detached', async () => {
    assert.deepEqual(await processes.start({ command: NODE, args: ['-e', ''], cwd: TEMP, mode: 'spawn' }), { kind: 'started' });
  });

  it('starts a hidden program detached, with the given variables', async () => {
    const marker = join(DIR, 'hidden.txt');
    const part = `${marker}.part`;
    // Written beside the marker and renamed in, so the marker exists only once its whole content does.
    const script = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(part)}, process.env.TEAMRIG_TEAM ?? ""); fs.renameSync(${JSON.stringify(part)}, ${JSON.stringify(marker)})`;
    const outcome = await processes.startHidden({ command: NODE, args: ['-e', script], cwd: TEMP, env: { ...process.env, TEAMRIG_TEAM: 'app' } });
    assert.deepEqual(outcome, { kind: 'started' });
    for (let tries = 0; tries < 100 && !existsSync(marker); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readFileSync(marker, 'utf8'), 'app');
  });

  it('reports a program that is not installed as missing', async () => {
    assert.deepEqual(await processes.start({ command: MISSING, args: [], cwd: DIR, mode: 'exit' }), { kind: 'missing' });
    assert.deepEqual(await processes.start({ command: MISSING, args: [], cwd: DIR, mode: 'spawn' }), { kind: 'missing' });
    assert.deepEqual(await processes.run({ command: MISSING, args: [], cwd: DIR, env: process.env }), { kind: 'missing' });
    assert.deepEqual(await processes.startHidden({ command: MISSING, args: [], cwd: TEMP, env: process.env }), { kind: 'missing' });
  });

  it('reports a request it cannot even start as failed, without throwing', async () => {
    const args = ['bad\0argument'];
    for (const outcome of [
      await processes.start({ command: NODE, args, cwd: DIR, mode: 'exit' }),
      await processes.start({ command: NODE, args, cwd: TEMP, mode: 'spawn' }),
      await processes.run({ command: NODE, args, cwd: DIR, env: process.env }),
      await processes.startHidden({ command: NODE, args, cwd: TEMP, env: process.env }),
    ]) {
      assert.equal(outcome.kind, 'failed');
    }
  });

  it('runs a program in its folder with the given variables, and ignores Ctrl+C until it exits', async () => {
    writeFileSync(join(DIR, 'marker.txt'), '');
    const interrupts = new EventEmitter();
    const attached = nodeProcesses({ interrupts });
    const script = 'process.exit(process.env.TEAMRIG_SESSION === "api" && require("node:fs").existsSync("marker.txt") ? 7 : 8)';
    const running = attached.run({ command: NODE, args: ['-e', script], cwd: DIR, env: { ...process.env, TEAMRIG_SESSION: 'api' } });
    assert.equal(interrupts.listenerCount('SIGINT'), 1);
    interrupts.emit('SIGINT');
    assert.deepEqual(await running, { kind: 'exited', code: 7 });
    assert.equal(interrupts.listenerCount('SIGINT'), 0);
  });

});

describe('exitText', () => {
  it('names the exit code or the signal, then the first error line', () => {
    assert.equal(exitText(2, ''), 'exited with code 2');
    assert.equal(exitText(null, '\n  boom\nmore'), 'ended by a signal: boom');
    assert.equal(exitText(1, 'x'.repeat(400)), `exited with code 1: ${'x'.repeat(300)}`);
  });
});

describe('outcomeOfError', () => {
  it('calls a missing program missing and words anything else', () => {
    assert.deepEqual(outcomeOfError(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), { kind: 'missing' });
    assert.deepEqual(outcomeOfError(new Error('EACCES')), { kind: 'failed', error: 'EACCES' });
  });
});
