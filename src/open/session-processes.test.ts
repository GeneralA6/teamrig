import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedProcess, SweepHost } from '../delivery/tree-kill.ts';
import type { ProgramRequest, ProgramResult } from '../github/credentials.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FakeSweepHost } from '../testing/fake-sweep-host.ts';
import {
  EXEC_STUB_MS,
  isClaudeProcess,
  lineageOf,
  nodeSessionProcesses,
  parsePosixChildren,
  parsePosixListing,
  parsePosixProcess,
  parseWindowsListing,
  parseWindowsProcess,
  parseWindowsProcesses,
  runsClaude,
  type ListedProcess,
} from './session-processes.ts';

describe('isClaudeProcess', () => {
  it('knows Claude Code by its binary, or by Node.js running its script', () => {
    const info = (name: string, commandLine: string) => ({ pid: 1, parentPid: 0, name, commandLine });
    assert.equal(isClaudeProcess(info('claude.exe', '')), true);
    assert.equal(isClaudeProcess(info('Claude', '')), true);
    assert.equal(isClaudeProcess(info('node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')), true);
    assert.equal(isClaudeProcess(info('node.exe', 'node C:/tools/build.js')), false);
    assert.equal(isClaudeProcess(info('claude-helper', '')), false);
  });
});

describe('runsClaude', () => {
  it('tells a pid that still runs Claude Code from none, a gone one and one another program has since', async () => {
    const processes = new FakeSessionProcesses().add({ pid: 41, parentPid: 1, name: 'claude.exe', commandLine: '' }).add({ pid: 42, parentPid: 1, name: 'notepad.exe', commandLine: '' });
    assert.deepEqual(await Promise.all([41, 42, 43, undefined].map((pid) => runsClaude(processes, pid))), [true, false, false, false]);
  });
});

const NODE = process.execPath;
const DIR = mkdtempSync(join(tmpdir(), 'teamrig-session-processes-'));
const WINDOWS = process.platform === 'win32';

after(() => rmSync(DIR, { recursive: true, force: true }));

/** A runner that answers every program with `result` and records what it was asked. */
function scripted(result: ProgramResult): { readonly asked: ProgramRequest[]; readonly run: (request: ProgramRequest) => Promise<ProgramResult> } {
  const asked: ProgramRequest[] = [];
  return {
    asked,
    run: async (request) => {
      asked.push(request);
      return result;
    },
  };
}

function exited(code: number, stdout = '', stderr = ''): ProgramResult {
  return { end: { kind: 'exited', code }, stdout, stderr };
}

/** One process of PowerShell's full listing, started at `started` ms (null where Windows does not say). */
function listingEntry(pid: number, parentPid: number, name: string, started: number | null): string {
  return JSON.stringify({ ProcessId: pid, ParentProcessId: parentPid, Name: name, CommandLine: name, Started: started });
}

/** A listed process named `p<pid>`, with its start when given. */
function listed(pid: number, parentPid: number, startedMs?: number): ListedProcess {
  return running(pid, parentPid, `p${pid}`, '', startedMs);
}

/** A listed process with its program and command line, and its start when given. */
function running(pid: number, parentPid: number, name: string, commandLine: string, startedMs?: number): ListedProcess {
  const info = { pid, parentPid, name, commandLine };
  return startedMs === undefined ? { info } : { info, startedMs };
}

/** An error as `process.kill` throws it. */
function killError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe('parseWindowsProcess and parsePosixProcess', () => {
  it("read PowerShell's JSON, with no command line for another user's process", () => {
    const line = '{"ProcessId":41,"ParentProcessId":7,"Name":"claude.exe","CommandLine":"claude --name web"}';
    assert.deepEqual(parseWindowsProcess(`${line}\r\n`), { pid: 41, parentPid: 7, name: 'claude.exe', commandLine: 'claude --name web' });
    assert.equal(parseWindowsProcess('{"ProcessId":41,"ParentProcessId":7,"Name":"x","CommandLine":null}')?.commandLine, '');
    assert.equal(parseWindowsProcess(''), undefined);
    assert.equal(parseWindowsProcess('{"ProcessId":"41","ParentProcessId":7,"Name":"x","CommandLine":""}'), undefined);
  });

  it("read ps's parent and command line, naming the program by its file", () => {
    assert.deepEqual(parsePosixProcess(41, '    7 /usr/bin/node /opt/claude/cli.js --name web\n'), {
      pid: 41,
      parentPid: 7,
      name: 'node',
      commandLine: '/usr/bin/node /opt/claude/cli.js --name web',
    });
    assert.equal(parsePosixProcess(41, ''), undefined);
  });
});

describe('parseWindowsProcesses and parsePosixChildren', () => {
  it("read PowerShell's array, empty or not, and nothing from another shape", () => {
    const bash = '{"ProcessId":51,"ParentProcessId":41,"Name":"bash.exe","CommandLine":"bash -c \\"sleep 9\\""}';
    const mcp = '{"ProcessId":52,"ParentProcessId":41,"Name":"node.exe","CommandLine":null}';
    assert.deepEqual(parseWindowsProcesses(`[${bash},${mcp}]\r\n`), [
      { pid: 51, parentPid: 41, name: 'bash.exe', commandLine: 'bash -c "sleep 9"' },
      { pid: 52, parentPid: 41, name: 'node.exe', commandLine: '' },
    ]);
    assert.deepEqual(parseWindowsProcesses('[]'), []);
    for (const other of ['', 'not json', bash, `[${bash},{"ProcessId":"x"}]`, '[7]']) {
      assert.equal(parseWindowsProcesses(other), undefined, other);
    }
  });

  it("keep the processes ps lists under the pid, a login shell's dash included", () => {
    const stdout = '    1     0 /sbin/init\n   51    41 -bash\n   52    41 /usr/bin/node /opt/mcp.js --port 3\n   53    52 sh -c ls\n\n';
    assert.deepEqual(parsePosixChildren(41, stdout), [
      { pid: 51, parentPid: 41, name: '-bash', commandLine: '-bash' },
      { pid: 52, parentPid: 41, name: 'node', commandLine: '/usr/bin/node /opt/mcp.js --port 3' },
    ]);
    assert.deepEqual(parsePosixChildren(99, stdout), []);
  });
});

describe('parseWindowsListing, parsePosixListing and lineageOf', () => {
  it("read PowerShell's full listing with each start, leaving out an entry of another shape", () => {
    const stdout = `[${listingEntry(4, 0, 'System', 0)},${listingEntry(51, 41, 'bash.exe', 2000)},{"ProcessId":"x"},${listingEntry(52, 51, 'node.exe', 1.5)}]\r\n`;
    assert.deepEqual(parseWindowsListing(stdout), [
      { info: { pid: 4, parentPid: 0, name: 'System', commandLine: 'System' }, startedMs: 0 },
      { info: { pid: 51, parentPid: 41, name: 'bash.exe', commandLine: 'bash.exe' }, startedMs: 2000 },
    ]);
    for (const other of ['', 'not json', listingEntry(51, 41, 'bash.exe', 1)]) {
      assert.equal(parseWindowsListing(other), undefined, other);
    }
  });

  it('read every process ps lists', () => {
    assert.deepEqual(parsePosixListing('    1     0 /sbin/init\n   51    41 -bash\n\n'), [
      { pid: 1, parentPid: 0, name: 'init', commandLine: '/sbin/init' },
      { pid: 51, parentPid: 41, name: '-bash', commandLine: '-bash' },
    ]);
  });

  it('follow each starter from the process up to the oldest still listed', () => {
    assert.deepEqual(lineageOf(53, [listed(41, 7, 100), listed(51, 41, 200), listed(53, 51, 300), listed(60, 1, 50)]).map((info) => info.pid), [53, 51, 41]);
    assert.deepEqual(lineageOf(53, [listed(51, 41), listed(53, 51, 300)]).map((info) => info.pid), [53, 51], 'an unknown start stops nothing');
  });

  it("stop at a starter that started after its child: a later process that took an ended starter's id", () => {
    assert.deepEqual(lineageOf(53, [listed(51, 41, 900), listed(53, 51, 300)]).map((info) => info.pid), [53]);
  });

  it('stop at a loop and at id 0, and list nothing for a process not listed', () => {
    assert.deepEqual(lineageOf(5, [listed(5, 6), listed(6, 5)]).map((info) => info.pid), [5, 6]);
    assert.deepEqual(lineageOf(4, [listed(0, 0, 0), listed(4, 0, 0)]).map((info) => info.pid), [4]);
    assert.deepEqual(lineageOf(99, [listed(5, 6)]), []);
  });

  // As measured under Git for Windows (T764): git runs the hook as `env <hook>` (stub 20), whose runtime execs the hook
  // shell (31) through a second env that ended (30), so the shell's own starter is gone.
  const git = running(10, 7, 'git.exe', '"C:\\Git\\mingw64\\bin\\git.exe" commit -m x', 1_000);
  const stub = running(20, 10, 'env.exe', 'env .git/hooks/pre-commit', 1_050);
  const hook = running(31, 30, 'sh.exe', '"C:\\Git\\usr\\bin\\sh.exe" .git/hooks/pre-commit', 1_083);
  const pids = (pid: number, entries: readonly ListedProcess[]): readonly number[] => lineageOf(pid, entries).map((info) => info.pid);

  it("go on through the one exec stub with the stopped process's arguments under another program (T764)", () => {
    assert.deepEqual(pids(31, [git, stub, hook]), [31, 20, 10]);
    const oldGit = running(10, 7, 'git.exe', 'git commit -m x', 1_000 - EXEC_STUB_MS);
    assert.deepEqual(pids(31, [oldGit, running(20, 10, 'env.exe', 'env .git/hooks/pre-commit', 1_083 - EXEC_STUB_MS), hook]), [31, 20, 10], 'a stub as old as the limit');
  });

  it('stop where two processes could be the stub, as two hooks with one path in two worktrees at once (T764)', () => {
    assert.deepEqual(pids(31, [git, stub, running(21, 11, 'env.exe', 'env .git/hooks/pre-commit', 1_060), hook]), [31]);
  });

  it('take no stub under the same program, as a second identical launcher or hook shell (T764)', () => {
    assert.deepEqual(pids(31, [git, running(20, 10, 'SH.EXE', 'sh .git/hooks/pre-commit', 1_050), hook]), [31]);
  });

  it('take no stub started after the process, or longer than the limit before it, or with no start known (T764)', () => {
    assert.deepEqual(pids(31, [git, running(20, 10, 'env.exe', 'env .git/hooks/pre-commit', 1_084), hook]), [31]);
    assert.deepEqual(pids(31, [git, running(20, 10, 'env.exe', 'env .git/hooks/pre-commit', 1_082 - EXEC_STUB_MS), hook]), [31]);
    assert.deepEqual(pids(31, [git, running(20, 10, 'env.exe', 'env .git/hooks/pre-commit'), hook]), [31]);
    assert.deepEqual(pids(31, [git, stub, running(31, 30, 'sh.exe', 'sh .git/hooks/pre-commit')]), [31], 'nor for a process whose start is unknown');
  });

  it('take no stub for a process with no arguments, nor one with other arguments (T764)', () => {
    assert.deepEqual(pids(31, [running(20, 10, 'env.exe', 'env', 1_050), running(31, 30, '"C:\\Git\\usr\\bin\\sh.exe"', '"C:\\Git\\usr\\bin\\sh.exe"', 1_083)]), [31]);
    assert.deepEqual(pids(31, [git, running(20, 10, 'env.exe', 'env .git/hooks/pre-push', 1_050), hook]), [31]);
  });

  it('count no process already in the line as a stub, so the one stub outside it is taken (T764)', () => {
    // 42 runs under 40 with 40's arguments and the same start; counted as a stub it would make two and stop the line.
    const shell = running(40, 39, 'sh.exe', 'sh run.sh', 1_000);
    const child = running(42, 40, 'node.exe', 'node run.sh', 1_000);
    assert.deepEqual(pids(42, [running(7, 1, 'git.exe', 'git commit', 900), running(41, 7, 'env.exe', 'env run.sh', 990), shell, child]), [42, 40, 41, 7]);
  });
});

/** One process as the Windows sweep lists it. */
const swept = (pid: number, parent: number, startedMs: number): StartedProcess => ({ pid, parent, startedMs });

describe('nodeSessionProcesses with a scripted system', () => {
  it("lists a process's starters from one full listing: PowerShell with each start on Windows, ps elsewhere", async () => {
    const windows = scripted(exited(0, `[${listingEntry(41, 7, 'claude.exe', 100)},${listingEntry(51, 41, 'bash.exe', 200)},${listingEntry(53, 51, 'node.exe', 300)}]`));
    assert.deepEqual((await nodeSessionProcesses({ platform: 'win32', run: windows.run }).lineage(53))?.map((info) => info.name), ['node.exe', 'bash.exe', 'claude.exe']);
    assert.equal(windows.asked[0]?.program, 'powershell.exe');
    assert.match(windows.asked[0]?.args.join(' ') ?? '', /CreationDate/);
    const posix = scripted(exited(0, '   41     7 claude\n   51    41 bash\n   53    51 node cli.js\n'));
    assert.deepEqual((await nodeSessionProcesses({ platform: 'linux', run: posix.run }).lineage(53))?.map((info) => info.pid), [53, 51, 41]);
    assert.deepEqual(posix.asked[0]?.args, ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']);
    assert.equal(await nodeSessionProcesses({ platform: 'linux', run: posix.run }).lineage(0), undefined);
    assert.equal(posix.asked.length, 1, 'a bad id never reaches ps');
  });

  it('lists no starters when the listing fails, cannot be read or cannot be run', async () => {
    const failed = [
      nodeSessionProcesses({ platform: 'win32', run: scripted(exited(1)).run }),
      nodeSessionProcesses({ platform: 'win32', run: scripted(exited(0, 'not json')).run }),
      nodeSessionProcesses({ platform: 'linux', run: scripted(exited(1)).run }),
      nodeSessionProcesses({ platform: 'linux', run: async () => Promise.reject(new Error('no ps')) }),
    ];
    for (const processes of failed) {
      assert.equal(await processes.lineage(53), undefined);
    }
  });

  it('asks PowerShell on Windows and ps elsewhere, and reads a failed lookup as nothing', async () => {
    const windows = scripted(exited(0, '{"ProcessId":41,"ParentProcessId":7,"Name":"claude.exe","CommandLine":"claude"}'));
    assert.equal((await nodeSessionProcesses({ platform: 'win32', run: windows.run }).describe(41))?.name, 'claude.exe');
    assert.equal(windows.asked[0]?.program, 'powershell.exe');
    assert.match(windows.asked[0]?.args.join(' ') ?? '', /ProcessId=41'/);
    const posix = scripted(exited(1));
    assert.equal(await nodeSessionProcesses({ platform: 'linux', run: posix.run }).describe(41), undefined);
    assert.deepEqual(posix.asked[0]?.args, ['-ww', '-o', 'ppid=', '-o', 'args=', '-p', '41']);
    const broken = nodeSessionProcesses({ platform: 'linux', run: async () => Promise.reject(new Error('no ps')) });
    assert.equal(await broken.describe(41), undefined);
  });

  it('lists the processes one started through PowerShell on Windows and ps elsewhere, and nothing from a failed lookup', async () => {
    const windows = scripted(exited(0, '[{"ProcessId":51,"ParentProcessId":41,"Name":"bash.exe","CommandLine":"bash"}]'));
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', run: windows.run }).children(41), [
      { pid: 51, parentPid: 41, name: 'bash.exe', commandLine: 'bash' },
    ]);
    assert.equal(windows.asked[0]?.program, 'powershell.exe');
    assert.match(windows.asked[0]?.args.join(' ') ?? '', /ParentProcessId=41'/);
    const posix = scripted(exited(0, '   51    41 bash\n   60     1 bash\n'));
    assert.deepEqual((await nodeSessionProcesses({ platform: 'darwin', run: posix.run }).children(41))?.map((info) => info.pid), [51]);
    assert.deepEqual(posix.asked[0]?.args, ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']);
    assert.equal(await nodeSessionProcesses({ platform: 'win32', run: scripted(exited(1)).run }).children(41), undefined);
    assert.equal(await nodeSessionProcesses({ platform: 'linux', run: scripted(exited(1)).run }).children(41), undefined);
    const broken = nodeSessionProcesses({ platform: 'linux', run: async () => Promise.reject(new Error('no ps')) });
    assert.equal(await broken.children(41), undefined);
  });

  it('never puts a bad id on a command line', async () => {
    const system = scripted(exited(0));
    const processes = nodeSessionProcesses({ platform: 'win32', run: system.run, signal: () => undefined });
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.equal(await processes.describe(pid), undefined);
      assert.equal(await processes.children(pid), undefined);
      assert.deepEqual(await processes.end(pid, 'force'), { kind: 'gone' });
      assert.equal(processes.alive(pid), false);
    }
    assert.equal(system.asked.length, 0);
  });

  it('ends a Windows process tree through the start-checked sweep, never taskkill, and reads a root not listed as gone (T2336)', async () => {
    const system = scripted(exited(0));
    // 60 names 41 as its starter but started before it: an ended process once held id 41, so 60 is a stranger.
    const host = new FakeSweepHost([[swept(7, 1, 10), swept(41, 7, 100), swept(51, 41, 200), swept(60, 41, 50)], []]);
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', run: system.run, sweepHost: host }).end(41, 'ask'), { kind: 'ended' });
    assert.deepEqual(host.kills, [[41, 51]]);
    assert.deepEqual(system.asked, [], 'no program runs but the sweep');
    const gone = new FakeSweepHost([[swept(7, 1, 10)]]);
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', sweepHost: gone }).end(41, 'force'), { kind: 'gone' });
    assert.deepEqual(gone.kills, []);
  });

  it('ends nothing on Windows when the host cannot be listed, and says why (T2336)', async () => {
    const unlisted = new FakeSweepHost([undefined, undefined]);
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', sweepHost: unlisted }).end(41, 'force'), {
      kind: 'failed',
      error: "the host's processes could not be listed, so nothing was ended",
    });
    assert.deepEqual(unlisted.kills, []);
    const broken: SweepHost = { list: () => Promise.reject(new Error('no PowerShell')), kill: () => Promise.resolve(), now: () => 0 };
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', sweepHost: broken }).end(41, 'force'), {
      kind: 'failed',
      error: 'the sweep failed: no PowerShell',
    });
  });

  it('signals one process elsewhere: SIGTERM to ask, SIGKILL to force', async () => {
    const sent: (NodeJS.Signals | 0)[] = [];
    const processes = nodeSessionProcesses({ platform: 'linux', signal: (_pid, signal) => void sent.push(signal) });
    assert.deepEqual(await processes.end(41, 'ask'), { kind: 'ended' });
    assert.deepEqual(await processes.end(41, 'force'), { kind: 'ended' });
    assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
    const gone = nodeSessionProcesses({ platform: 'linux', signal: () => { throw killError('ESRCH'); } });
    assert.deepEqual(await gone.end(41, 'ask'), { kind: 'gone' });
    assert.equal(gone.alive(41), false);
  });

  it("counts a process it may not signal as alive", () => {
    const processes = nodeSessionProcesses({ signal: () => { throw killError('EPERM'); } });
    assert.equal(processes.alive(41), true);
  });
});

/** Real processes, each a short node script. */
describe('nodeSessionProcesses on this machine', () => {
  const processes = nodeSessionProcesses();

  it('knows its parent, and describes this process', async () => {
    assert.equal(processes.parentPid, process.ppid);
    assert.equal(processes.alive(process.pid), true);
    const self = await processes.describe(process.pid);
    assert.equal(self?.parentPid, process.ppid);
    assert.match(self?.name ?? '', /node/i);
  });

  it('lists this process first in its lineage, then the one that started it', async () => {
    const lineage = await processes.lineage(process.pid);
    assert.deepEqual(lineage?.slice(0, 2).map((info) => info.pid), [process.pid, process.ppid]);
  });

  // Once the child exits, the system may hand its pid to another process at once (Windows does on a busy host), so
  // the spec only checks the pid no longer describes its own child, and never ends that pid again (T626).
  it('ends a running program, and then finds it gone', async () => {
    const marker = `teamrig-spec-${process.pid}-${Date.now()}`;
    const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' });
    const exit = new Promise((resolve) => child.once('exit', resolve));
    const pid = child.pid ?? 0;
    assert.equal(processes.alive(pid), true);
    assert.match((await processes.describe(pid))?.commandLine ?? '', new RegExp(marker));
    assert.deepEqual(await processes.end(pid, 'ask'), { kind: 'ended' });
    await exit;
    const later = await processes.describe(pid);
    assert.equal(later?.commandLine.includes(marker) ?? false, false, `pid ${pid} still runs the child: ${later?.commandLine ?? ''}`);
  });

  it('lists a program it started', async () => {
    const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exit = new Promise((resolve) => child.once('exit', resolve));
    try {
      const listed = await processes.children(process.pid);
      assert.ok(listed?.some((info) => info.pid === child.pid && /node/i.test(info.name)), JSON.stringify(listed));
    } finally {
      child.kill();
      await exit;
    }
  });

  it('feeds a program its input, and reports one that fails or is missing', async () => {
    const out = join(DIR, 'fed.txt');
    const reader = `let t='';process.stdin.on('data',d=>t+=d).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},t))`;
    assert.deepEqual(await processes.feed({ command: NODE, args: ['-e', reader], cwd: DIR, input: '{"reason":"clear"}' }), { kind: 'done' });
    assert.equal(readFileSync(out, 'utf8'), '{"reason":"clear"}');
    const failing = await processes.feed({ command: NODE, args: ['-e', 'console.error("bad input"); process.exit(2)'], cwd: DIR, input: 'x' });
    assert.deepEqual(failing, { kind: 'failed', error: 'exited with code 2: bad input' });
    assert.deepEqual(await processes.feed({ command: 'teamrig-no-such-program', args: [], cwd: DIR, input: '' }), { kind: 'missing' });
  });

  it('stops a fed program at its time limit', async () => {
    const quick = nodeSessionProcesses({ feedTimeoutMs: 200 });
    const outcome = await quick.feed({ command: NODE, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: DIR, input: '' });
    assert.equal(outcome.kind, 'failed');
  });

  // The sweep is Windows only, and the repo gate fails a skipped test, so other hosts do not register it.
  if (WINDOWS) it(
    "ends a Windows tree but not a detached program whose starter has ended: the restart's waiter outlives the session it ends",
    async () => {
      // top: the session (claude); child: its MCP server; middle: a hook that starts the waiter and exits.
      writeFileSync(join(DIR, 'waiter.cjs'), 'setTimeout(() => {}, 30000);\n');
      writeFileSync(
        join(DIR, 'middle.cjs'),
        "const w = require('child_process').spawn(process.execPath, [__dirname + '/waiter.cjs'], { detached: true, stdio: 'ignore' });\n" +
          'w.unref();\nprocess.stdout.write(String(w.pid));\n',
      );
      writeFileSync(
        join(DIR, 'top.cjs'),
        "const { spawn } = require('child_process');\n" +
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });\n" +
          "const middle = spawn(process.execPath, [__dirname + '/middle.cjs'], { stdio: ['ignore', 'pipe', 'ignore'] });\n" +
          "let waiter = '';\nmiddle.stdout.on('data', (d) => (waiter += d));\n" +
          "middle.on('exit', () => console.log(JSON.stringify({ child: child.pid, waiter: Number(waiter) })));\n" +
          'setTimeout(() => {}, 30000);\n',
      );
      const top = spawn(NODE, [join(DIR, 'top.cjs')], { stdio: ['ignore', 'pipe', 'ignore'] });
      const line = await new Promise<string>((resolve) => top.stdout.setEncoding('utf8').once('data', resolve));
      const pids: unknown = JSON.parse(line);
      assert.ok(typeof pids === 'object' && pids !== null && 'child' in pids && 'waiter' in pids);
      const child = Number(pids.child);
      const waiter = Number(pids.waiter);
      try {
        assert.deepEqual(await processes.end(top.pid ?? 0, 'ask'), { kind: 'ended' });
        assert.equal(await until(() => !processes.alive(child)), true, 'the session and its children end');
        assert.equal(processes.alive(waiter), true, 'the detached waiter runs on');
      } finally {
        await processes.end(waiter, 'force');
      }
    },
  );
});

describe('FakeSessionProcesses', () => {
  it('ends a process with all it started, records each end, and fails or lingers where told', async () => {
    const ended: number[] = [];
    const fake = new FakeSessionProcesses(10)
      .add({ pid: 10, parentPid: 1, name: 'pwsh.exe', commandLine: 'pwsh -c claude' })
      .add({ pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' })
      .add({ pid: 12, parentPid: 11, name: 'node.exe', commandLine: 'mcp' })
      .add({ pid: 20, parentPid: 1, name: 'claude.exe', commandLine: 'claude' })
      .add({ pid: 30, parentPid: 1, name: 'claude.exe', commandLine: 'claude' })
      .failEnd(20, 'Access is denied.')
      .linger(30)
      .whenEnded((pid) => ended.push(pid));
    assert.deepEqual(await fake.end(10, 'force'), { kind: 'ended' });
    assert.deepEqual(ended, [10, 11, 12]);
    assert.deepEqual(await fake.end(20, 'force'), { kind: 'failed', error: 'Access is denied.' });
    assert.deepEqual(await fake.end(30, 'ask'), { kind: 'ended' });
    assert.equal(fake.alive(30), true);
    assert.deepEqual(await fake.end(30, 'force'), { kind: 'ended' });
    assert.deepEqual(await fake.end(30, 'force'), { kind: 'gone' });
    assert.equal(fake.ends.length, 5);
    assert.deepEqual(await fake.onFeed('node', { kind: 'missing' }).feed({ command: 'node', args: [], cwd: '/', input: '' }), { kind: 'missing' });
    assert.equal(fake.fed.length, 1);
  });

  it('lists the processes one started until the system will not; one that exits by itself is no end', async () => {
    const fake = new FakeSessionProcesses()
      .add({ pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' })
      .add({ pid: 12, parentPid: 11, name: 'bash.exe', commandLine: 'bash' })
      .add({ pid: 13, parentPid: 12, name: 'node.exe', commandLine: 'job' });
    assert.deepEqual((await fake.children(11))?.map((info) => info.pid), [12]);
    fake.exit(12);
    assert.deepEqual(await fake.children(11), []);
    assert.equal(fake.alive(13), true);
    assert.deepEqual(fake.ends, []);
    assert.equal(await fake.hideChildren().children(11), undefined);
  });

  it('lists a process with its starters, through a loop once, until the system will not', async () => {
    const fake = new FakeSessionProcesses()
      .add({ pid: 11, parentPid: 10, name: 'claude.exe', commandLine: 'claude' })
      .add({ pid: 12, parentPid: 11, name: 'bash.exe', commandLine: 'bash' })
      .add({ pid: 13, parentPid: 12, name: 'node.exe', commandLine: 'job' })
      .add({ pid: 21, parentPid: 22, name: 'a', commandLine: 'a' })
      .add({ pid: 22, parentPid: 21, name: 'b', commandLine: 'b' });
    assert.deepEqual((await fake.lineage(13))?.map((info) => info.pid), [13, 12, 11]);
    assert.deepEqual((await fake.lineage(21))?.map((info) => info.pid), [21, 22]);
    assert.deepEqual(await fake.lineage(99), []);
    assert.equal(await fake.hideLineage().lineage(13), undefined);
  });
});
