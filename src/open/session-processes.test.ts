import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgramRequest, ProgramResult } from '../github/credentials.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { isClaudeProcess, nodeSessionProcesses, parsePosixChildren, parsePosixProcess, parseWindowsProcess, parseWindowsProcesses } from './session-processes.ts';

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

describe('nodeSessionProcesses with a scripted system', () => {
  it('asks PowerShell on Windows and ps elsewhere, and reads a failed lookup as nothing', async () => {
    const windows = scripted(exited(0, '{"ProcessId":41,"ParentProcessId":7,"Name":"claude.exe","CommandLine":"claude"}'));
    assert.equal((await nodeSessionProcesses({ platform: 'win32', run: windows.run }).describe(41))?.name, 'claude.exe');
    assert.equal(windows.asked[0]?.program, 'powershell.exe');
    assert.match(windows.asked[0]?.args.join(' ') ?? '', /ProcessId=41'/);
    const posix = scripted(exited(1));
    assert.equal(await nodeSessionProcesses({ platform: 'linux', run: posix.run }).describe(41), undefined);
    assert.deepEqual(posix.asked[0]?.args, ['-o', 'ppid=', '-o', 'args=', '-p', '41']);
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
    assert.deepEqual(posix.asked[0]?.args, ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']);
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

  it("ends a Windows process tree with taskkill, reading its 'not found' as gone", async () => {
    const ended = scripted(exited(0));
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', run: ended.run }).end(41, 'ask'), { kind: 'ended' });
    assert.deepEqual(ended.asked, [{ program: 'taskkill', args: ['/PID', '41', '/T', '/F'] }]);
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', run: scripted(exited(128)).run }).end(41, 'force'), { kind: 'gone' });
    assert.deepEqual(await nodeSessionProcesses({ platform: 'win32', run: scripted(exited(1, '', 'ERROR: Access is denied.')).run }).end(41, 'force'), {
      kind: 'failed',
      error: 'exited with code 1: ERROR: Access is denied.',
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

  it('ends a running program, and then finds it gone', async () => {
    const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exit = new Promise((resolve) => child.once('exit', resolve));
    const pid = child.pid ?? 0;
    assert.equal(processes.alive(pid), true);
    assert.deepEqual(await processes.end(pid, 'ask'), { kind: 'ended' });
    await exit;
    assert.equal(processes.alive(pid), false);
    assert.equal(await processes.describe(pid), undefined);
    assert.deepEqual(await processes.end(pid, 'force'), { kind: 'gone' });
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

  it(
    "ends a Windows tree but not a detached program whose starter has ended: the restart's waiter outlives the session it ends",
    { skip: WINDOWS ? false : 'taskkill /T is Windows only' },
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
});
