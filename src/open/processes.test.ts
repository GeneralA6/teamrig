import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeTreeKill } from '../delivery/tree-kill.ts';
import { exitText, nodeProcesses, outcomeOfError } from './processes.ts';

const NODE = process.execPath;
const DIR = mkdtempSync(join(tmpdir(), 'teamrig-processes-'));
const MISSING = 'teamrig-no-such-program';
/** Launchers left running hold their working folder on Windows, so they start outside DIR. */
const TEMP = tmpdir();

after(() => rmSync(DIR, { recursive: true, force: true }));

/** Waits up to 5 s for a file a background program writes. */
async function waitForFile(path: string): Promise<void> {
  for (let tries = 0; tries < 100 && !existsSync(path); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The process ids under `pid` in a `ps -A -o pid= -o ppid=` listing, children before their own children. */
function descendantsOf(pid: number, listing: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined) {
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
  }
  const found: number[] = [];
  for (let next = [pid]; next.length > 0; next = next.flatMap((each) => children.get(each) ?? [])) {
    found.push(...next.flatMap((each) => children.get(each) ?? []));
  }
  return found;
}

/**
 * Kills a process with every process it started, as Claude Code ends a hook past its timeout: on Windows through the
 * start-checked sweep, which never ends a stranger behind a reused id as `taskkill /T` can (T2336).
 */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (process.platform === 'win32') {
    await nodeTreeKill('win32')(child);
    return;
  }
  if (pid === undefined) {
    return;
  }
  const listing = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).stdout;
  for (const each of [pid, ...descendantsOf(pid, listing)]) {
    try {
      process.kill(each, 'SIGKILL');
    } catch {
      // Ended meanwhile.
    }
  }
}

/** Real child processes, each a short node script: nothing opens a terminal. */
describe('nodeProcesses', () => {
  const processes = nodeProcesses();

  it('starts a launcher that returns, as exited, and reports its exit code with its first error line', async () => {
    assert.deepEqual(await processes.start({ command: NODE, args: ['-e', ''], cwd: DIR, mode: 'exit' }), { kind: 'started', end: 'exited' });
    const failed = await processes.start({ command: NODE, args: ['-e', 'console.error("no server running\\nmore"); process.exit(3)'], cwd: DIR, mode: 'exit' });
    assert.deepEqual(failed, { kind: 'failed', error: 'exited with code 3: no server running' });
  });

  it('counts a launcher still running after the wait as started and running', async () => {
    const quick = nodeProcesses({ exitWaitMs: 50 });
    assert.deepEqual(await quick.start({ command: NODE, args: ['-e', 'setTimeout(() => {}, 1500)'], cwd: TEMP, mode: 'exit' }), { kind: 'started', end: 'running' });
  });

  it('starts a terminal window detached, as spawned', async () => {
    assert.deepEqual(await processes.start({ command: NODE, args: ['-e', ''], cwd: TEMP, mode: 'spawn' }), { kind: 'started', end: 'spawned' });
  });

  it('starts a hidden program detached, with the given variables', async () => {
    const marker = join(DIR, 'hidden.txt');
    const part = `${marker}.part`;
    // Written beside the marker and renamed in, so the marker exists only once its whole content does.
    const script = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(part)}, process.env.TEAMRIG_TEAM ?? ""); fs.renameSync(${JSON.stringify(part)}, ${JSON.stringify(marker)})`;
    const outcome = await processes.startHidden({ command: NODE, args: ['-e', script], cwd: TEMP, env: { ...process.env, TEAMRIG_TEAM: 'app' } });
    assert.deepEqual(outcome, { kind: 'started', end: 'spawned' });
    await waitForFile(marker);
    assert.equal(readFileSync(marker, 'utf8'), 'app');
  });

  it('starts a hidden program that outlives a kill of its starter with every process the starter started', async () => {
    const marker = join(DIR, 'outlived.txt');
    const part = `${marker}.part`;
    // Written a second after the start, long after the starter and its whole tree are killed; beside the marker and
    // renamed in, so the marker exists only once its whole content does.
    const program = `setTimeout(() => { const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(part)}, "alive"); fs.renameSync(${JSON.stringify(part)}, ${JSON.stringify(marker)}); }, 1000)`;
    const request = `{ command: process.execPath, args: ["-e", ${JSON.stringify(program)}], cwd: ${JSON.stringify(TEMP)}, env: process.env }`;
    // A hook that starts the program and keeps running, as the Stop hook does until Claude Code's timeout ends it.
    const starter = `import(${JSON.stringify(new URL('./processes.ts', import.meta.url).href)}).then(async ({ nodeProcesses }) => {
      console.log((await nodeProcesses().startHidden(${request})).kind);
      setInterval(() => undefined, 1000);
    })`;
    const hook = spawn(NODE, ['-e', starter], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    // An empty line when the starter ends without a word, so a broken starter fails here instead of hanging.
    const [first] = await Promise.race([once(hook.stdout, 'data'), once(hook, 'exit').then(() => [''])]);
    assert.equal(String(first).trim(), 'started');
    assert.ok(hook.pid !== undefined);
    await killTree(hook);
    await waitForFile(marker);
    assert.equal(readFileSync(marker, 'utf8'), 'alive');
  });

  it('reports a hidden program that cannot start for another reason than a missing program as failed', async () => {
    const notProgram = join(DIR, 'not-a-program.txt');
    writeFileSync(notProgram, 'text');
    const outcome = await processes.startHidden({ command: notProgram, args: [], cwd: TEMP, env: process.env });
    assert.equal(outcome.kind, 'failed');
    // Windows says `spawn EFTYPE`, POSIX `spawn <path> EACCES`.
    assert.match(outcome.kind === 'failed' ? outcome.error : '', /^exited with code 1: spawn .*\bE[A-Z]+$/);
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

describe('descendantsOf', () => {
  it('finds every process under one, through its children, and none of its parents or neighbours', () => {
    const listing = ['  1     0', ' 10     1', ' 11    10', ' 12    11', ' 13    10', ' 20     1', ''].join('\n');
    assert.deepEqual(descendantsOf(10, listing), [11, 13, 12]);
    assert.deepEqual(descendantsOf(20, listing), []);
  });
});

describe('outcomeOfError', () => {
  it('calls a missing program missing and words anything else', () => {
    assert.deepEqual(outcomeOfError(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), { kind: 'missing' });
    assert.deepEqual(outcomeOfError(new Error('EACCES')), { kind: 'failed', error: 'EACCES' });
  });
});
