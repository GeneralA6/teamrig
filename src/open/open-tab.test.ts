import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { KEEP_FOCUS_PROGRAM_VAR } from './keep-focus.ts';
import { launchWords, openTab } from './open-tab.ts';
import type { TabRequest } from './terminals.ts';

const TAB: TabRequest = { title: 'shop-api', folder: '/w/shop', argv: ['/usr/bin/node', '/kit/main.js', 'launch', 'api'], window: undefined, focus: 'take' };

describe('openTab', () => {
  it('opens in the first terminal auto finds, after one that is missing', async () => {
    const processes = new FakeProcesses().onStart('konsole', { kind: 'started', end: 'running' });
    const outcome = await openTab({ processes, env: {}, platform: 'linux' }, 'auto', TAB);
    assert.deepEqual(outcome, { kind: 'opened', terminal: 'konsole', end: 'running' }, 'it tells how the launch ended');
    assert.deepEqual(
      processes.started.map((request) => request.command),
      ['gnome-terminal', 'konsole'],
    );
  });

  it('gives every reason when no terminal opens the tab', async () => {
    const processes = new FakeProcesses().onStart('tmux', { kind: 'failed', error: 'exited with code 1: no server running' });
    const outcome = await openTab({ processes, env: { TMUX: 'x' }, platform: 'win32' }, 'auto', { ...TAB, folder: 'C:\\a;b' });
    assert.deepEqual(outcome, {
      kind: 'none',
      reasons: ['tmux failed: exited with code 1: no server running', 'Windows Terminal would misread "C:\\\\a;b" (it holds ; " % or a control character)'],
    });
  });

  it('tries only the terminal asked for', async () => {
    const processes = new FakeProcesses();
    const outcome = await openTab({ processes, env: { TMUX: 'x' }, platform: 'linux' }, 'x-terminal-emulator', TAB);
    assert.deepEqual(outcome, { kind: 'none', reasons: ['x-terminal-emulator is not installed'] });
    assert.equal(processes.started.length, 1);
  });

  it('opens a Windows Terminal tab that keeps the focus through the script, and one that takes it plainly', async () => {
    const keep = new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code: 0 });
    assert.deepEqual(await openTab({ processes: keep, env: {}, platform: 'win32' }, 'windows-terminal', { ...TAB, focus: 'keep' }), {
      kind: 'opened',
      terminal: 'windows-terminal',
      end: 'exited',
    });
    assert.deepEqual(keep.ran.map((request) => request.env[KEEP_FOCUS_PROGRAM_VAR]), ['wt.exe']);
    assert.deepEqual(keep.started, []);

    const take = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    await openTab({ processes: take, env: {}, platform: 'win32' }, 'windows-terminal', TAB);
    assert.deepEqual(take.ran, []);
    assert.deepEqual(take.started.map((request) => request.command), ['wt.exe']);
  });

  it('keeps the focus in tmux by its own flag, with no script', async () => {
    const processes = new FakeProcesses().onStart('tmux', { kind: 'started', end: 'exited' });
    await openTab({ processes, env: { TMUX: 'x' }, platform: 'linux' }, 'tmux', { ...TAB, focus: 'keep' });
    assert.deepEqual(processes.ran, []);
    assert.deepEqual(processes.started[0]?.args.slice(0, 2), ['new-window', '-d']);
  });

  it('starts nothing for print', async () => {
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    assert.deepEqual(await openTab({ processes, env: {}, platform: 'win32' }, 'print', TAB), { kind: 'none', reasons: ['the terminal setting is print'] });
    assert.deepEqual(processes.started, []);
  });
});

describe('launchWords', () => {
  it('says how each launch ended, for the restore log (T1705)', () => {
    assert.deepEqual(
      [launchWords('windows-terminal', 'exited'), launchWords('windows-terminal', 'running'), launchWords('tmux', 'spawned')],
      ['windows-terminal exited 0', 'windows-terminal still running after 10 s', 'tmux started'],
    );
  });
});
