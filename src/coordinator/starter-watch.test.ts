import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessInfo } from '../open/session-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { endingOf, livenessOf } from '../testing/process-liveness.ts';
import { endedText, LAUNCHER_PID_ENV, launchingShellOf, nodeEvery, SHELL_PID_ENV, STARTER_CHECK_MS, starterWatch, startersOf, type Every } from './starter-watch.ts';

const TERMINAL: ProcessInfo = { pid: 10, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt' };
const CLAUDE: ProcessInfo = { pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' };
const SHELL: ProcessInfo = { pid: 12, parentPid: 11, name: 'bash.exe', commandLine: 'bash -c teamrig heavy' };
const SELF: ProcessInfo = { pid: 13, parentPid: 12, name: 'node.exe', commandLine: 'teamrig heavy' };
/** Under Git Bash: the launcher's `sh` stub, started by a forked copy of SHELL (pid 15) that has ended, and the CLI it runs. */
const STUB: ProcessInfo = { pid: 14, parentPid: 15, name: 'sh.exe', commandLine: 'sh teamrig heavy' };
const LAUNCHED: ProcessInfo = { pid: 16, parentPid: 14, name: 'node.exe', commandLine: 'node main.js heavy' };

/** An `Every` the test runs by hand: it keeps the check and each period asked, and whether its stop was called. */
class ManualEvery {
  readonly periods: number[] = [];
  cancelled = false;
  private check: () => void = () => undefined;

  readonly every: Every = (everyMs, check) => {
    this.periods.push(everyMs);
    this.check = check;
    return () => {
      this.cancelled = true;
    };
  };

  /** One check, as the timer would run it while not stopped. */
  tick(): void {
    if (!this.cancelled) {
      this.check();
    }
  }
}

/** A tab's processes: its terminal, its Claude Code, the Bash tool's shell and this step. */
function tab(): FakeSessionProcesses {
  return new FakeSessionProcesses().add(TERMINAL).add(CLAUDE).add(SHELL).add(SELF);
}

/**
 * How long a spec waits on a real chain of processes (a shell, the launcher, a node CLI listing the host's processes)
 * to write its file. A pass takes up to about 10 s on a busy Windows host and went past 15 s at full CPU (10-23), so
 * this wait catches a hang, never a slow host.
 */
const REAL_WAIT_MS = 60_000;
/** A real watcher quits on its own after this, once the spec has stopped waiting on both of its files. */
const REAL_QUIT_MS = 2 * REAL_WAIT_MS + 30_000;

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** Whether another process has written the file: writeFileSync creates it before it writes its text. */
function written(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8') !== '';
}

/**
 * Ends a watcher a test started, known by the `ready` file it wrote: its id first, and the file's time as when it wrote.
 * One that wrote `ended` exits by itself, and as it exits under the coverage gate it writes its V8 coverage file, which
 * a kill would leave cut short, failing the whole run's coverage report ("Unexpected end of JSON input"); so it gets
 * time to exit first. One still running after that, or one that never saw its starter end, is ended by what it is,
 * never by its bare id, which on Windows may by then be a stranger's (T1562).
 */
async function endWatcher(ready: string, ended: string): Promise<void> {
  const [pid] = written(ready) ? readFileSync(ready, 'utf8').split(',').map(Number) : [];
  if (pid === undefined) {
    return;
  }
  const watcher = { pid, writtenMs: statSync(ready).mtimeMs };
  if (written(ended)) {
    const runs = livenessOf(process.platform);
    await until(async () => !(await runs(watcher)), REAL_WAIT_MS);
  }
  await endingOf(process.platform)(watcher);
}

describe('startersOf', () => {
  it('keeps the starters up to and with the nearest Claude Code, else every one', () => {
    assert.deepEqual(startersOf([SELF, SHELL, CLAUDE, TERMINAL]), [SHELL, CLAUDE]);
    assert.deepEqual(startersOf([SELF, SHELL, TERMINAL]), [SHELL, TERMINAL]);
    assert.deepEqual(startersOf([SELF]), []);
    assert.deepEqual(startersOf([]), []);
  });

  it("goes on with the launching shell's line where the own line stops short of it, and adds no starter twice", () => {
    assert.deepEqual(startersOf([LAUNCHED, STUB], [SHELL, CLAUDE, TERMINAL]), [STUB, SHELL, CLAUDE]);
    assert.deepEqual(startersOf([SELF, SHELL, CLAUDE, TERMINAL], [SHELL, CLAUDE, TERMINAL]), [SHELL, CLAUDE]);
    assert.deepEqual(startersOf([], [SHELL, CLAUDE]), [SHELL, CLAUDE]);
  });
});

describe('launchingShellOf', () => {
  it("reads the shell the launcher recorded when that launcher is this process's starter", () => {
    assert.equal(launchingShellOf({ [SHELL_PID_ENV]: '12', [LAUNCHER_PID_ENV]: '14' }, 14), 12);
  });

  it("ignores a record inherited from an outer launcher, a missing one and one that names no process", () => {
    assert.equal(launchingShellOf({ [SHELL_PID_ENV]: '12', [LAUNCHER_PID_ENV]: '14' }, 16), undefined);
    assert.equal(launchingShellOf({}, 14), undefined);
    assert.equal(launchingShellOf({ [LAUNCHER_PID_ENV]: '14' }, 14), undefined);
    for (const shell of ['0', '-3', '1.5', 'bash']) {
      assert.equal(launchingShellOf({ [SHELL_PID_ENV]: shell, [LAUNCHER_PID_ENV]: '14' }, 14), undefined, shell);
    }
  });
});

describe('starterWatch', () => {
  it('checks each starter every 5 seconds, and once one ended, stops the checks and aborts', async () => {
    const processes = tab();
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: SELF.pid, shell: undefined }, manual.every).watch();
    assert.deepEqual([watching.starters, manual.periods], [[SHELL, CLAUDE], [STARTER_CHECK_MS]]);
    manual.tick();
    assert.deepEqual([watching.stop.aborted, watching.ended(), endedText(watching)], [false, undefined, 'a process that started it']);
    processes.exit(SHELL.pid);
    manual.tick();
    assert.deepEqual([watching.stop.aborted, watching.ended(), endedText(watching), manual.cancelled], [true, SHELL, 'bash.exe 12', true]);
  });

  it('finds Claude Code ended though the shell under it runs on, as a launcher stub does on Windows', async () => {
    const processes = tab();
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: SELF.pid, shell: undefined }, manual.every, 200).watch();
    processes.exit(CLAUDE.pid);
    manual.tick();
    assert.deepEqual([manual.periods, watching.ended(), watching.stop.aborted], [[200], CLAUDE, true]);
  });

  it("under Git Bash, finds the shell ended through the launcher's record, where its own line ends at the launcher stub", async () => {
    const processes = tab().add(STUB).add(LAUNCHED);
    const unnamed = await starterWatch(processes, { pid: LAUNCHED.pid, shell: undefined }, new ManualEvery().every).watch();
    assert.deepEqual(unnamed.starters, [STUB], 'without the record the stub alone is watched, and it runs on');
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: LAUNCHED.pid, shell: SHELL.pid }, manual.every).watch();
    assert.deepEqual(watching.starters, [STUB, SHELL, CLAUDE]);
    processes.exit(SHELL.pid);
    manual.tick();
    assert.deepEqual([watching.ended(), watching.stop.aborted], [SHELL, true]);
  });

  it('checks nothing and never aborts when the system will not list the starters, or lists none', async () => {
    for (const [processes, pid, shell] of [[tab().hideLineage(), SELF.pid, SHELL.pid], [tab(), 99, undefined]] as const) {
      const manual = new ManualEvery();
      const watching = await starterWatch(processes, { pid, shell }, manual.every).watch();
      watching.close();
      assert.deepEqual([watching.starters, manual.periods, watching.stop.aborted, watching.ended()], [[], [], false, undefined]);
    }
  });

  it('stops checking once closed', async () => {
    const manual = new ManualEvery();
    const watching = await starterWatch(tab(), { pid: SELF.pid, shell: undefined }, manual.every).watch();
    watching.close();
    assert.equal(manual.cancelled, true);
  });
});

describe('nodeEvery', () => {
  it('runs the check every period until stopped', async () => {
    let calls = 0;
    const stop = nodeEvery(5, () => {
      calls += 1;
    });
    assert.equal(await until(() => calls >= 2), true);
    stop();
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, stoppedAt);
  });
});

describe('starterWatch on this machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamrig-starter-watch-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the process that started a watcher ended once that process is killed', async () => {
    const ready = join(dir, 'ready.txt');
    const ended = join(dir, 'ended.txt');
    const watcher = join(dir, 'watcher.mjs');
    writeFileSync(
      watcher,
      [
        "import { writeFileSync } from 'node:fs';",
        `import { nodeEvery, starterWatch } from ${JSON.stringify(new URL('./starter-watch.ts', import.meta.url).href)};`,
        `import { nodeSessionProcesses } from ${JSON.stringify(new URL('../open/session-processes.ts', import.meta.url).href)};`,
        `const quit = setTimeout(() => process.exit(3), ${REAL_QUIT_MS});`,
        'const watching = await starterWatch(nodeSessionProcesses(), { pid: process.pid, shell: undefined }, nodeEvery, 200).watch();',
        "watching.stop.addEventListener('abort', () => {",
        `  writeFileSync(${JSON.stringify(ended)}, String(watching.ended()?.pid));`,
        '  clearTimeout(quit);',
        '});',
        `writeFileSync(${JSON.stringify(ready)}, [process.pid, ...watching.starters.map((starter) => starter.pid)].join(','));`,
      ].join('\n'),
    );
    // Detached, since on Windows Node puts its other children in a job that ends them with it, which a shell
    // such as bash.exe does not: the watcher must outlive its starter, as a step outlives its ended shell.
    const launcher = `require('node:child_process').spawn(process.execPath, [${JSON.stringify(watcher)}], { stdio: 'ignore', detached: true, windowsHide: true }); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', launcher], { stdio: 'ignore' });
    const parentPid = parent.pid ?? 0;
    try {
      assert.equal(await until(() => written(ready), REAL_WAIT_MS), true, 'the watcher listed its starters');
      const [, firstStarter] = readFileSync(ready, 'utf8').split(',').map(Number);
      assert.equal(firstStarter, parentPid);
      parent.kill();
      assert.equal(await until(() => written(ended), REAL_WAIT_MS), true, 'the watcher found its starter ended');
      assert.equal(readFileSync(ended, 'utf8'), String(parentPid));
    } finally {
      parent.kill();
      await endWatcher(ready, ended);
    }
  });

  const noShell = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true }).status !== 0 ? 'no sh on this machine' : false;

  it('finds the shell that ran the real launcher ended once that shell is killed', { skip: noShell }, async () => {
    const home = join(dir, 'plugin');
    const bin = join(home, 'bin');
    const cli = join(home, 'dist', 'cli');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cli, { recursive: true });
    const launcher = join(bin, 'teamrig');
    copyFileSync(fileURLToPath(new URL('../../plugins/teamrig/bin/teamrig', import.meta.url)), launcher);
    chmodSync(launcher, 0o755);
    writeFileSync(join(home, 'package.json'), '{ "type": "module" }\n');
    const ready = join(home, 'ready.txt');
    const ended = join(home, 'ended.txt');
    // The CLI the launcher runs: it watches its starters as the real one does, from the launcher's record.
    writeFileSync(
      join(cli, 'main.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `import { launchingShellOf, nodeEvery, starterWatch } from ${JSON.stringify(new URL('./starter-watch.ts', import.meta.url).href)};`,
        `import { nodeSessionProcesses } from ${JSON.stringify(new URL('../open/session-processes.ts', import.meta.url).href)};`,
        `const quit = setTimeout(() => process.exit(3), ${REAL_QUIT_MS});`,
        'const shell = launchingShellOf(process.env, process.ppid);',
        'const watching = await starterWatch(nodeSessionProcesses(), { pid: process.pid, shell }, nodeEvery, 200).watch();',
        "watching.stop.addEventListener('abort', () => {",
        `  writeFileSync(${JSON.stringify(ended)}, String(watching.ended()?.pid));`,
        '  clearTimeout(quit);',
        '});',
        `writeFileSync(${JSON.stringify(ready)}, [process.pid, shell ?? 0, ...watching.starters.map((starter) => starter.pid)].join(','));`,
      ].join('\n'),
    );
    // As the Bash tool runs a command: in a forked copy of the shell, since more follows it. Under Git Bash that copy
    // ends once the launcher starts, so only the launcher's record links the CLI to this shell.
    const shell = spawn('sh', ['-c', '"$0"; exit $?', launcher.replaceAll('\\', '/')], { stdio: 'ignore', windowsHide: true });
    const cliPids = (): readonly number[] => (written(ready) ? readFileSync(ready, 'utf8').split(',').map(Number) : []);
    try {
      assert.equal(await until(() => written(ready), REAL_WAIT_MS), true, 'the CLI listed its starters');
      const [, recorded = 0, ...starters] = cliPids();
      // On Windows `sh` may be Git's bin\sh.exe, which runs the real shell as its child: the shell to end is the one
      // the launcher recorded. Elsewhere nothing is recorded and the CLI's own line reaches the shell.
      assert.ok(process.platform !== 'win32' || recorded > 0, 'the launcher recorded its shell under Git Bash');
      const target = recorded > 0 ? recorded : (shell.pid ?? 0);
      assert.ok(starters.includes(target), `the shell ${target} is among the starters ${starters.join(',')}`);
      process.kill(target);
      assert.equal(await until(() => written(ended), REAL_WAIT_MS), true, 'the CLI found its shell ended');
      assert.equal(readFileSync(ended, 'utf8'), String(target));
    } finally {
      shell.kill();
      await endWatcher(ready, ended);
    }
  });
});
