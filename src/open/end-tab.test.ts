import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { END_WAIT_MS, endAndWait, SHELL_RECHECK_MS, tabProcessOf, workCutOffBy, type TabEnder } from './end-tab.ts';

const CLAUDE = { pid: 8100, parentPid: 8000, name: 'claude.exe', commandLine: 'claude --resume 1' };
const TAB = { pid: 8000, parentPid: 7900, name: 'powershell.exe', commandLine: 'powershell -NoExit -Command claude --resume 1' };

function enderOf(processes: FakeSessionProcesses, platform: NodeJS.Platform = 'win32'): TabEnder & { readonly clock: FakeClock } {
  const clock = new FakeClock('2030-01-08T10:00:00.000Z');
  return { processes, clock, sleep: clock.sleep, platform };
}

describe('ending a tab', () => {
  it('ends the tab shell on Windows and Claude Code itself elsewhere', async () => {
    const processes = new FakeSessionProcesses().add(TAB).add(CLAUDE);
    assert.equal(await tabProcessOf(enderOf(processes), CLAUDE), TAB.pid);
    assert.equal(await tabProcessOf(enderOf(processes, 'linux'), CLAUDE), CLAUDE.pid);
    const plainParent = new FakeSessionProcesses().add({ ...TAB, commandLine: 'powershell' }).add(CLAUDE);
    assert.equal(await tabProcessOf(enderOf(plainParent), CLAUDE), CLAUDE.pid, 'a shell that did not start Claude Code is not its tab');
  });

  it('asks first, forces a process that outlives the wait, and says when even that fails', async () => {
    const processes = new FakeSessionProcesses().add(CLAUDE).linger(CLAUDE.pid);
    const ender = enderOf(processes);
    assert.equal(await endAndWait(ender, CLAUDE.pid, CLAUDE.pid), undefined);
    assert.deepEqual(processes.ends, [
      { pid: CLAUDE.pid, how: 'ask' },
      { pid: CLAUDE.pid, how: 'force' },
    ]);
    assert.ok(ender.clock.now() - Date.parse('2030-01-08T10:00:00.000Z') >= END_WAIT_MS, 'it waited before forcing');
    const failing = new FakeSessionProcesses().add(CLAUDE).failEnd(CLAUDE.pid, 'access denied');
    assert.equal(await endAndWait(enderOf(failing), CLAUDE.pid, CLAUDE.pid), `could not end process ${CLAUDE.pid}: access denied`);
  });

  it('counts a command shell still there on a second look as work an end would cut off', async () => {
    const shell = { pid: 8200, parentPid: CLAUDE.pid, name: 'bash.exe', commandLine: 'bash -c npm test' };
    const busy = enderOf(new FakeSessionProcesses().add(CLAUDE).add(shell));
    assert.equal(await workCutOffBy(busy, CLAUDE), `ending its Claude Code would also end the background shells it runs (pid ${shell.pid})`);
    assert.deepEqual(busy.clock.sleeps, [SHELL_RECHECK_MS]);
    const mcp = { pid: 8300, parentPid: CLAUDE.pid, name: 'cmd.exe', commandLine: 'cmd /c npx server' };
    assert.equal(await workCutOffBy(enderOf(new FakeSessionProcesses().add(CLAUDE).add(mcp)), CLAUDE), undefined, 'an MCP server under cmd ends with the session anyway');
    const hidden = enderOf(new FakeSessionProcesses().add(CLAUDE).hideChildren());
    assert.equal(await workCutOffBy(hidden, CLAUDE), `teamrig could not list what its Claude Code (${CLAUDE.pid}) runs`);
  });
});
