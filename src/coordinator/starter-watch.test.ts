import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSessionProcesses, type ProcessInfo } from '../open/session-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { endedText, nodeEvery, STARTER_CHECK_MS, starterWatch, startersOf, type Every } from './starter-watch.ts';

const TERMINAL: ProcessInfo = { pid: 10, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt' };
const CLAUDE: ProcessInfo = { pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' };
const SHELL: ProcessInfo = { pid: 12, parentPid: 11, name: 'bash.exe', commandLine: 'bash -c teamrig heavy' };
const SELF: ProcessInfo = { pid: 13, parentPid: 12, name: 'node.exe', commandLine: 'teamrig heavy' };

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

async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe('startersOf', () => {
  it('keeps the starters up to and with the nearest Claude Code, else every one', () => {
    assert.deepEqual(startersOf([SELF, SHELL, CLAUDE, TERMINAL]), [SHELL, CLAUDE]);
    assert.deepEqual(startersOf([SELF, SHELL, TERMINAL]), [SHELL, TERMINAL]);
    assert.deepEqual(startersOf([SELF]), []);
    assert.deepEqual(startersOf([]), []);
  });
});

describe('starterWatch', () => {
  it('checks each starter every 5 seconds, and once one ended, stops the checks and aborts', async () => {
    const processes = tab();
    const manual = new ManualEvery();
    const watching = await starterWatch(processes, SELF.pid, manual.every).watch();
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
    const watching = await starterWatch(processes, SELF.pid, manual.every, 200).watch();
    processes.exit(CLAUDE.pid);
    manual.tick();
    assert.deepEqual([manual.periods, watching.ended(), watching.stop.aborted], [[200], CLAUDE, true]);
  });

  it('checks nothing and never aborts when the system will not list the starters, or lists none', async () => {
    for (const [processes, pid] of [[tab().hideLineage(), SELF.pid], [tab(), 99]] as const) {
      const manual = new ManualEvery();
      const watching = await starterWatch(processes, pid, manual.every).watch();
      watching.close();
      assert.deepEqual([watching.starters, manual.periods, watching.stop.aborted, watching.ended()], [[], [], false, undefined]);
    }
  });

  it('stops checking once closed', async () => {
    const manual = new ManualEvery();
    const watching = await starterWatch(tab(), SELF.pid, manual.every).watch();
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
        'const quit = setTimeout(() => process.exit(3), 30_000);',
        'const watching = await starterWatch(nodeSessionProcesses(), process.pid, nodeEvery, 200).watch();',
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
      assert.equal(await until(() => existsSync(ready)), true, 'the watcher listed its starters');
      const [, firstStarter] = readFileSync(ready, 'utf8').split(',').map(Number);
      assert.equal(firstStarter, parentPid);
      parent.kill();
      assert.equal(await until(() => existsSync(ended)), true, 'the watcher found its starter ended');
      assert.equal(readFileSync(ended, 'utf8'), String(parentPid));
    } finally {
      parent.kill();
      const [watcherPid] = existsSync(ready) ? readFileSync(ready, 'utf8').split(',').map(Number) : [];
      if (watcherPid !== undefined && nodeSessionProcesses().alive(watcherPid)) {
        process.kill(watcherPid);
      }
    }
  });
});
