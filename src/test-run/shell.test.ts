import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpuGate } from '../delivery/cpu.ts';
import { nodeTreeKill } from '../delivery/tree-kill.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostCpu } from '../testing/fake-host-cpu.ts';
import { commandLine, nodeShellRunner, unrunnableReason } from './shell.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-shell-'));
const ENV = { ...process.env, TEAMRIG_PROBE: 'probe value' };

after(() => rmSync(DIR, { recursive: true, force: true }));

/** A Node script in the temp folder, and the command line that runs it on this platform. */
function script(name: string, source: string): string {
  const path = join(DIR, name);
  writeFileSync(path, source);
  return commandLine([process.execPath, path], process.platform);
}

describe('commandLine', () => {
  it('runs one word as the command line itself', () => {
    assert.equal(commandLine(['npm run build && npm test'], 'linux'), 'npm run build && npm test');
    assert.equal(commandLine(['npm run build && npm test'], 'win32'), 'npm run build && npm test');
  });

  it('quotes each of several words a POSIX shell would read, so a glob is not expanded', () => {
    assert.equal(commandLine(['node', '--test', 'src/**/*.test.ts'], 'linux'), "node --test 'src/**/*.test.ts'");
    assert.equal(commandLine(['echo', "it's", 'a b', '$HOME', ''], 'darwin'), "echo 'it'\\''s' 'a b' '$HOME' ''");
    assert.equal(commandLine(['FOO=1', 'npx', 'jest', '--runInBand', 'a.test.ts:12'], 'linux'), 'FOO=1 npx jest --runInBand a.test.ts:12');
  });

  it('double-quotes each of several words cmd.exe would read, and leaves globs for the program', () => {
    assert.equal(commandLine(['node', '--test', 'src/**/*.test.ts'], 'win32'), 'node --test src/**/*.test.ts');
    assert.equal(commandLine(['C:\\Program Files\\nodejs\\node.exe', 'a&b', 'say "hi"', '50%', ''], 'win32'), '"C:\\Program Files\\nodejs\\node.exe" "a&b" "say \\"hi\\"" "50%" ""');
  });
});

describe('unrunnableReason', () => {
  it('refuses a blank command on every platform', () => {
    for (const platform of ['linux', 'win32'] as const) {
      for (const words of [[''], [' '], ['\n', '\t']]) {
        assert.match(unrunnableReason(words, platform) ?? '', /^the command after -- is empty/u);
      }
    }
  });

  it('refuses a word with a line break on Windows, where cmd.exe stops reading at it', () => {
    for (const words of [['bash', '-c', '\necho ran'], ['bash', '-c', 'echo one\necho two'], ['node -e "1"\r\nnode -e "2"']]) {
      assert.match(unrunnableReason(words, 'win32') ?? '', /line break, and cmd\.exe/u);
    }
  });

  it('lets a POSIX shell run a quoted line break, and Windows a command on one line', () => {
    assert.equal(unrunnableReason(['bash', '-c', '\necho ran'], 'linux'), undefined);
    assert.equal(unrunnableReason(['bash', '-c', 'echo ran'], 'win32'), undefined);
    assert.equal(unrunnableReason(['npm', 'test', ''], 'win32'), undefined);
  });

  it('refuses a word that is only &&, || or ;, which would reach the first program quoted, with the one-word hint (#661)', () => {
    for (const platform of ['linux', 'win32'] as const) {
      for (const operator of ['&&', '||', ';']) {
        const reason = unrunnableReason(['npm', 'run', 'build', operator, 'npm', 'test'], platform) ?? '';
        assert.ok(reason.startsWith(`the word "${operator}" of the command is a shell operator`), reason);
        assert.ok(reason.endsWith(`pass the whole chain as one quoted word: -- "npm run build ${operator} npm test"`), reason);
      }
    }
  });

  it('runs the chain as one word, and a word that holds an operator among other text, as today', () => {
    for (const platform of ['linux', 'win32'] as const) {
      assert.equal(unrunnableReason(['npm run build && npm test'], platform), undefined);
      assert.equal(unrunnableReason(['node', 'tool.js', 'a;b', '--x=&&', '||y'], platform), undefined);
      assert.equal(unrunnableReason([';'], platform), undefined);
    }
  });
});

describe('nodeShellRunner', () => {
  const shell = nodeShellRunner();

  it('keeps stdout and stderr together in the order they arrived', async () => {
    const command = script(
      'order.mjs',
      "const wait = () => new Promise((done) => setTimeout(done, 40));\nprocess.stdout.write('one\\n'); await wait();\nprocess.stderr.write('two\\n'); await wait();\nprocess.stdout.write('three é\\n');\n",
    );
    assert.deepEqual(await shell.run({ command, cwd: DIR, env: ENV, idleMs: 0 }), { end: { kind: 'exited', code: 0 }, output: 'one\ntwo\nthree é\n' });
  });

  it('reports a failing exit code with what was printed', async () => {
    const command = script('fail.mjs', "console.error('broke');\nprocess.exitCode = 3;\n");
    assert.deepEqual(await shell.run({ command, cwd: DIR, env: ENV, idleMs: 0 }), { end: { kind: 'exited', code: 3 }, output: 'broke\n' });
  });

  it('runs in the folder and environment given, with stdin already at its end', async () => {
    const command = script(
      'where.mjs',
      "let input = '';\nprocess.stdin.on('data', (chunk) => { input += chunk; });\nprocess.stdin.on('end', () => console.log(JSON.stringify({ cwd: process.cwd(), probe: process.env.TEAMRIG_PROBE, input })));\n",
    );
    const { end, output } = await shell.run({ command, cwd: DIR, env: ENV, idleMs: 0 });
    assert.deepEqual(end, { kind: 'exited', code: 0 });
    assert.deepEqual(JSON.parse(output), { cwd: realpathSync(DIR), probe: 'probe value', input: '' });
  });

  it('rejects when the command cannot start, such as in a missing folder', async () => {
    await assert.rejects(shell.run({ command: 'node --version', cwd: join(DIR, 'missing'), env: ENV, idleMs: 0 }), /ENOENT/);
  });
});

describe('nodeShellRunner idle stop (#1532)', () => {
  // A host with CPU to spare, so the silence limit is not stretched.
  const calm = new CpuGate(new FakeHostCpu(80), new FakeClock().sleep, 25);
  const kill = nodeTreeKill(process.platform);

  /** Whether a process id still names a live process; one this user may not signal is alive too. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
  }

  /** Waits up to `ms` for the process to be gone (its new parent reaps it), and says whether it is. */
  async function gone(pid: number, ms: number): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 50) {
      if (!alive(pid)) {
        return true;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    return !alive(pid);
  }

  it('stops a command that prints once and never ends, with the process it started, keeping what it printed', async () => {
    const command = script(
      'hang.mjs',
      "import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nprocess.stdout.write(`grandchild ${child.pid}\\n`);\nsetInterval(() => {}, 1000);\n",
    );
    // The silence clock starts at spawn: a loaded host may take seconds to start node, so the first output gets a
    // load-tolerant window, as in the coverage gate's own spec; the silence after it still ends the run.
    const idleMs = 10_000;
    const { end, output } = await nodeShellRunner(process.platform, kill, calm).run({ command, cwd: DIR, env: ENV, idleMs });
    assert.deepEqual(end, { kind: 'idle', silentMs: idleMs });
    const pid = Number(/grandchild (\d+)/.exec(output)?.[1]);
    assert.ok(pid > 0, output);
    assert.equal(await gone(pid, 5_000), true, 'the process the command started is ended with it');
  });

  it('times nothing before the idleFrom output, then stops a command silent after it (a queued run waiting its turn)', async () => {
    const command = script(
      'queued.mjs',
      "process.stdout.write('waiting for the host lock\\n');\nsetTimeout(() => { process.stdout.write('12:00:00 UTC running: test: npm test\\n'); setInterval(() => {}, 1000); }, 2500);\n",
    );
    const idleMs = 1_000;
    const { end, output } = await nodeShellRunner(process.platform, kill, calm).run({ command, cwd: DIR, env: ENV, idleMs, idleFrom: 'running: test: npm test' });
    assert.ok(output.includes('running: test: npm test'), `the wait past idleMs is not taken for a hang: ${output}`);
    assert.deepEqual(end, { kind: 'idle', silentMs: idleMs });
  });

  it('never stops a silent command when idleMs is 0', async () => {
    const command = script('quiet.mjs', 'setTimeout(() => { process.exitCode = 4; }, 300);\n');
    assert.deepEqual(await nodeShellRunner(process.platform, kill, calm).run({ command, cwd: DIR, env: ENV, idleMs: 0 }), { end: { kind: 'exited', code: 4 }, output: '' });
  });

  it('ends the command group when this process is ended on POSIX, listens for nothing on Windows, and stops listening once the run ends', async () => {
    const signals = new EventEmitter();
    const listening = (): number[] => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => signals.listenerCount(signal));
    const command = script('wait.mjs', "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n");
    const grouped = process.platform !== 'win32';
    // Windows runs the command in the console's own group, which Ctrl-C reaches with no help: the runner listens for
    // nothing there, so the idle stop ends this run instead.
    const run = nodeShellRunner(process.platform, kill, calm, signals).run({ command, cwd: DIR, env: ENV, idleMs: grouped ? 0 : 3_000 });
    // The listeners go on as the run starts, before its first wait.
    assert.deepEqual(listening(), grouped ? [1, 1, 1] : [0, 0, 0]);
    if (grouped) {
      await new Promise((done) => setTimeout(done, 200));
      signals.emit('SIGTERM');
    }
    const { end } = await run;
    assert.deepEqual(end, grouped ? { kind: 'signal', signal: 'SIGKILL' } : { kind: 'idle', silentMs: 3_000 });
    assert.deepEqual(listening(), [0, 0, 0]);
  });
});
