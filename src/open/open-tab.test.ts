import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { launchWords, openTab } from './open-tab.ts';
import type { TabRequest } from './terminals.ts';

const TAB: TabRequest = { title: 'shop-api', folder: '/w/shop', argv: ['/usr/bin/node', '/kit/main.js', 'launch', 'api'], window: undefined };

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
