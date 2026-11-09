import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnvironment } from '../core/git-run.ts';
import type { ProcessInfo } from '../open/session-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { endingOf, livenessOf } from '../testing/process-liveness.ts';
import { endedText, LAUNCHER_PID_ENV, launchingShellsOf, nodeEvery, SHELLS_PID_ENV, STARTER_CHECK_MS, starterWatch, startersOf, type Every } from './starter-watch.ts';

const TERMINAL: ProcessInfo = { pid: 10, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt' };
const CLAUDE: ProcessInfo = { pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' };
const SHELL: ProcessInfo = { pid: 12, parentPid: 11, name: 'bash.exe', commandLine: 'bash -c teamrig queue' };
const SELF: ProcessInfo = { pid: 13, parentPid: 12, name: 'node.exe', commandLine: 'teamrig queue' };
/** Under Git Bash: the launcher's `sh` stub, started by a forked copy of SHELL (pid 15) that has ended, and the CLI it runs. */
const STUB: ProcessInfo = { pid: 14, parentPid: 15, name: 'sh.exe', commandLine: 'sh teamrig queue' };
const LAUNCHED: ProcessInfo = { pid: 16, parentPid: 14, name: 'node.exe', commandLine: 'node main.js queue' };
/**
 * A hooked commit from SHELL under Git Bash, as husky runs a hook: git starts the hook runner's shell, which runs the
 * hook in a second shell (`sh -e`) from a forked copy that has ended (pid 23); that one runs the launcher the same way
 * (pid 25), so neither the CLI's own line nor the second shell's reaches the hook runner, git or SHELL. Git for Windows
 * links the hook runner to git only through its `env.exe` exec stub, which the real lineage goes through
 * (session-processes.ts, lineageOf); the fake lists the runner as git's child.
 */
const GIT: ProcessInfo = { pid: 20, parentPid: SHELL.pid, name: 'git.exe', commandLine: 'git commit' };
const HOOK_RUNNER: ProcessInfo = { pid: 21, parentPid: GIT.pid, name: 'sh.exe', commandLine: 'sh .husky/_/pre-commit' };
const HOOK: ProcessInfo = { pid: 22, parentPid: 23, name: 'sh.exe', commandLine: 'sh -e .husky/pre-commit' };
const HOOK_STUB: ProcessInfo = { pid: 24, parentPid: 25, name: 'sh.exe', commandLine: 'sh teamrig queue' };
const HOOK_CLI: ProcessInfo = { pid: 26, parentPid: HOOK_STUB.pid, name: 'node.exe', commandLine: 'node main.js queue' };

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
    assert.deepEqual(startersOf([LAUNCHED, STUB], [[SHELL, CLAUDE, TERMINAL]]), [STUB, SHELL, CLAUDE]);
    assert.deepEqual(startersOf([SELF, SHELL, CLAUDE, TERMINAL], [[SHELL, CLAUDE, TERMINAL]]), [SHELL, CLAUDE]);
    assert.deepEqual(startersOf([], [[SHELL, CLAUDE]]), [SHELL, CLAUDE]);
  });

  it("goes on with each launching shell's line in turn, nearest first, where the one before stops short", () => {
    assert.deepEqual(startersOf([HOOK_CLI, HOOK_STUB], [[HOOK], [HOOK_RUNNER, GIT, SHELL, CLAUDE, TERMINAL]]), [HOOK_STUB, HOOK, HOOK_RUNNER, GIT, SHELL, CLAUDE]);
    assert.deepEqual(startersOf([HOOK_CLI, HOOK_STUB], [[HOOK], [HOOK_RUNNER, GIT, SHELL], [SHELL, CLAUDE]]), [HOOK_STUB, HOOK, HOOK_RUNNER, GIT, SHELL, CLAUDE]);
  });
});

describe('launchingShellsOf', () => {
  it("reads the shells the launcher recorded, nearest first, when that launcher is this process's starter", () => {
    assert.deepEqual(launchingShellsOf({ [SHELLS_PID_ENV]: '12', [LAUNCHER_PID_ENV]: '14' }, 14), [12]);
    assert.deepEqual(launchingShellsOf({ [SHELLS_PID_ENV]: '22,21', [LAUNCHER_PID_ENV]: '24' }, 24), [22, 21]);
  });

  it('ignores a record inherited from an outer launcher, a missing one and an entry that names no process', () => {
    assert.deepEqual(launchingShellsOf({ [SHELLS_PID_ENV]: '12', [LAUNCHER_PID_ENV]: '14' }, 16), []);
    assert.deepEqual(launchingShellsOf({}, 14), []);
    assert.deepEqual(launchingShellsOf({ [LAUNCHER_PID_ENV]: '14' }, 14), []);
    assert.deepEqual(launchingShellsOf({ [SHELLS_PID_ENV]: '', [LAUNCHER_PID_ENV]: '14' }, 14), []);
    assert.deepEqual(launchingShellsOf({ [SHELLS_PID_ENV]: '0,-3,1.5,bash,,22', [LAUNCHER_PID_ENV]: '14' }, 14), [22]);
  });
});

describe('starterWatch', () => {
  it('checks each starter every 5 seconds, and once one ended, stops the checks and aborts', async () => {
    const processes = tab();
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: SELF.pid, shells: [] }, manual.every).watch();
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
    const watching = await starterWatch(processes, { pid: SELF.pid, shells: [] }, manual.every, 200).watch();
    processes.exit(CLAUDE.pid);
    manual.tick();
    assert.deepEqual([manual.periods, watching.ended(), watching.stop.aborted], [[200], CLAUDE, true]);
  });

  it("under Git Bash, finds the shell ended through the launcher's record, where its own line ends at the launcher stub", async () => {
    const processes = tab().add(STUB).add(LAUNCHED);
    const unnamed = await starterWatch(processes, { pid: LAUNCHED.pid, shells: [] }, new ManualEvery().every).watch();
    assert.deepEqual(unnamed.starters, [STUB], 'without the record the stub alone is watched, and it runs on');
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: LAUNCHED.pid, shells: [SHELL.pid] }, manual.every).watch();
    assert.deepEqual(watching.starters, [STUB, SHELL, CLAUDE]);
    processes.exit(SHELL.pid);
    manual.tick();
    assert.deepEqual([watching.ended(), watching.stop.aborted], [SHELL, true]);
  });

  it("finds the Bash tool's shell ended under a hook that a second Git Bash shell runs, through every shell the launcher named (T764)", async () => {
    const processes = tab().add(GIT).add(HOOK_RUNNER).add(HOOK).add(HOOK_STUB).add(HOOK_CLI);
    const nearest = await starterWatch(processes, { pid: HOOK_CLI.pid, shells: [HOOK.pid] }, new ManualEvery().every).watch();
    assert.deepEqual(nearest.starters, [HOOK_STUB, HOOK], 'with the nearest shell alone, nothing watched ends with the Bash tool');
    processes.lineages.length = 0;
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, { pid: HOOK_CLI.pid, shells: [HOOK.pid, HOOK_RUNNER.pid] }, manual.every).watch();
    assert.deepEqual([watching.starters, processes.lineages], [[HOOK_STUB, HOOK, HOOK_RUNNER, GIT, SHELL, CLAUDE], [HOOK_CLI.pid, HOOK.pid, HOOK_RUNNER.pid]]);
    processes.exit(SHELL.pid);
    manual.tick();
    assert.deepEqual([watching.ended(), watching.stop.aborted], [SHELL, true]);
  });

  it('checks nothing and never aborts when the system will not list the starters, or lists none', async () => {
    for (const [processes, pid, shells] of [[tab().hideLineage(), SELF.pid, [SHELL.pid]], [tab(), 99, []]] as const) {
      const manual = new ManualEvery();
      const watching = await starterWatch(processes, { pid, shells }, manual.every).watch();
      watching.close();
      assert.deepEqual([watching.starters, manual.periods, watching.stop.aborted, watching.ended()], [[], [], false, undefined]);
    }
  });

  it('stops checking once closed', async () => {
    const manual = new ManualEvery();
    const watching = await starterWatch(tab(), { pid: SELF.pid, shells: [] }, manual.every).watch();
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
        'const watching = await starterWatch(nodeSessionProcesses(), { pid: process.pid, shells: [] }, nodeEvery, 200).watch();',
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

  /** A plugin folder holding the real launcher, whose CLI watches its starters as the real one does. */
  interface PluginHome {
    /** The folder, for a spec's own files. */
    readonly home: string;
    /** The launcher, with forward slashes, as a shell takes its path. */
    readonly launcher: string;
    /** Written by the CLI once it lists its starters: its own id, then theirs. */
    readonly ready: string;
    /** Written by the CLI once it finds a starter ended: that starter's id. */
    readonly ended: string;
    /** The shells the launcher named, nearest first, once the CLI listed its starters; none where it named none. */
    shells(): readonly number[];
    /** The CLI's starters, once it listed them. */
    starters(): readonly number[];
  }

  /**
   * Sets up `name` under the spec folder as the plugin: the real launcher, and as the CLI it runs a watcher that reads
   * the launcher's record as the real CLI does, writes the shells it names, then `ready`, and `ended` once a starter ends.
   */
  function pluginHome(name: string): PluginHome {
    const home = join(dir, name);
    const bin = join(home, 'bin');
    const cli = join(home, 'dist', 'cli');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cli, { recursive: true });
    const launcher = join(bin, 'teamrig');
    copyFileSync(fileURLToPath(new URL('../../plugins/teamrig/bin/teamrig', import.meta.url)), launcher);
    chmodSync(launcher, 0o755);
    writeFileSync(join(home, 'package.json'), '{ "type": "module" }\n');
    const shells = join(home, 'shells.txt');
    const ready = join(home, 'ready.txt');
    const ended = join(home, 'ended.txt');
    writeFileSync(
      join(cli, 'main.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `import { launchingShellsOf, nodeEvery, starterWatch } from ${JSON.stringify(new URL('./starter-watch.ts', import.meta.url).href)};`,
        `import { nodeSessionProcesses } from ${JSON.stringify(new URL('../open/session-processes.ts', import.meta.url).href)};`,
        `const quit = setTimeout(() => process.exit(3), ${REAL_QUIT_MS});`,
        'const shells = launchingShellsOf(process.env, process.ppid);',
        'const watching = await starterWatch(nodeSessionProcesses(), { pid: process.pid, shells }, nodeEvery, 200).watch();',
        "watching.stop.addEventListener('abort', () => {",
        `  writeFileSync(${JSON.stringify(ended)}, String(watching.ended()?.pid));`,
        '  clearTimeout(quit);',
        '});',
        `writeFileSync(${JSON.stringify(shells)}, shells.join(','));`,
        `writeFileSync(${JSON.stringify(ready)}, [process.pid, ...watching.starters.map((starter) => starter.pid)].join(','));`,
      ].join('\n'),
    );
    const ids = (path: string): readonly number[] => (written(path) ? readFileSync(path, 'utf8').split(',').map(Number) : []);
    return { home, launcher: launcher.replaceAll('\\', '/'), ready, ended, shells: () => ids(shells), starters: () => ids(ready).slice(1) };
  }

  it('finds the shell that ran the real launcher ended once that shell is killed', { skip: noShell }, async () => {
    const plugin = pluginHome('plugin');
    // As the Bash tool runs a command: in a forked copy of the shell, since more follows it. Under Git Bash that copy
    // ends once the launcher starts, so only the launcher's record links the CLI to this shell.
    const shell = spawn('sh', ['-c', '"$0"; exit $?', plugin.launcher], { stdio: 'ignore', windowsHide: true });
    try {
      assert.equal(await until(() => written(plugin.ready), REAL_WAIT_MS), true, 'the CLI listed its starters');
      const [recorded = 0] = plugin.shells();
      // On Windows `sh` may be Git's bin\sh.exe, which runs the real shell as its child: the shell to end is the one
      // the launcher recorded. Elsewhere nothing is recorded and the CLI's own line reaches the shell.
      assert.ok(process.platform !== 'win32' || recorded > 0, 'the launcher recorded its shell under Git Bash');
      const target = recorded > 0 ? recorded : (shell.pid ?? 0);
      assert.ok(plugin.starters().includes(target), `the shell ${target} is among the starters ${plugin.starters().join(',')}`);
      process.kill(target);
      assert.equal(await until(() => written(plugin.ended), REAL_WAIT_MS), true, 'the CLI found its shell ended');
      assert.equal(readFileSync(plugin.ended, 'utf8'), String(target));
    } finally {
      shell.kill();
      await endWatcher(plugin.ready, plugin.ended);
    }
  });

  it('finds the outer shell ended where a second shell runs the real launcher, as husky runs a hook (T764)', { skip: noShell }, async () => {
    const plugin = pluginHome('plugin-hook');
    const outer = join(plugin.home, 'outer.txt');
    // The outer shell writes its own id (its Windows one under Git Bash), then runs a second shell that runs the
    // launcher, each from a forked copy as more follows it: husky's hook runner runs `sh -e <hook>`, and the hook
    // runs teamrig. Under Git Bash neither the CLI's own line nor the second shell's reaches the outer shell.
    const script = ['if [ -r "/proc/$$/winpid" ]; then cat "/proc/$$/winpid"; else echo "$$"; fi > "$1"', `sh -c '"$0"; exit $?' "$0"`, 'exit $?'].join('\n');
    const shell = spawn('sh', ['-c', script, plugin.launcher, outer.replaceAll('\\', '/')], { stdio: 'ignore', windowsHide: true });
    try {
      assert.equal(await until(() => written(plugin.ready), REAL_WAIT_MS), true, 'the CLI listed its starters');
      const target = Number(readFileSync(outer, 'utf8'));
      assert.ok(plugin.starters().includes(target), `the outer shell ${target} is among the starters ${plugin.starters().join(',')}`);
      process.kill(target);
      assert.equal(await until(() => written(plugin.ended), REAL_WAIT_MS), true, 'the CLI found the outer shell ended');
      assert.equal(readFileSync(plugin.ended, 'utf8'), String(target));
    } finally {
      shell.kill();
      await endWatcher(plugin.ready, plugin.ended);
    }
  });

  const noGit = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0 ? 'no git on this machine' : false;

  it('finds git ended where a real commit runs the launcher from a `#!/usr/bin/env sh` hook, as husky does (T764)', { skip: noShell || noGit }, async () => {
    const plugin = pluginHome('plugin-git-hook');
    const repo = join(plugin.home, 'repo');
    // Git alone, away from this machine's own git config: no hooks folder, signing or identity of its own.
    const global = join(plugin.home, 'gitconfig');
    writeFileSync(global, '');
    const identity = { GIT_AUTHOR_NAME: 'spec', GIT_AUTHOR_EMAIL: 'spec', GIT_COMMITTER_NAME: 'spec', GIT_COMMITTER_EMAIL: 'spec' };
    const env = { ...gitEnvironment(process.env), GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', ...identity };
    assert.equal(spawnSync('git', ['init', '-q', repo], { env, stdio: 'ignore', windowsHide: true }).status, 0, 'git init');
    // As husky's hook runner: a `#!/usr/bin/env sh` hook that runs the hook in `sh -e`, which runs teamrig. Git for
    // Windows runs it as `env <hook>`, and the hook shell's own starter is a second env that has ended at once.
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    const body = join(repo, '.git', 'pre-commit');
    writeFileSync(hook, ['#!/usr/bin/env sh', `sh -e "${body.replaceAll('\\', '/')}"`, 'exit $?', ''].join('\n'));
    writeFileSync(body, [`"${plugin.launcher}"`, 'exit $?', ''].join('\n'));
    chmodSync(hook, 0o755);
    const git = spawn('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'spec'], { env, stdio: 'ignore', windowsHide: true });
    try {
      assert.equal(await until(() => written(plugin.ready), REAL_WAIT_MS), true, 'the CLI listed its starters');
      const target = git.pid ?? 0;
      assert.ok(plugin.starters().includes(target), `git ${target} is among the starters ${plugin.starters().join(',')}`);
      process.kill(target);
      assert.equal(await until(() => written(plugin.ended), REAL_WAIT_MS), true, 'the CLI found git ended');
      assert.equal(readFileSync(plugin.ended, 'utf8'), String(target));
    } finally {
      git.kill();
      await endWatcher(plugin.ready, plugin.ended);
    }
  });
});
