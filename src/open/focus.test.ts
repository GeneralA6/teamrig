import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { FOCUS_EXIT, FOCUS_TITLE_VAR, focusRequest, focusTab, WINDOWS_TERMINAL_FOCUS_SCRIPT } from './focus.ts';

const TITLE = '[app] alpha';
const ENV = { PATH: '/bin' };

function scriptOf(args: readonly string[]): string {
  return Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
}

describe('focusRequest', () => {
  it('runs the Windows Terminal script with the title as a variable, never inside it', () => {
    const request = focusRequest('windows-terminal', TITLE, ENV, '/work');
    assert.equal(request?.command, 'powershell.exe');
    assert.deepEqual(request?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(scriptOf(request?.args ?? []), WINDOWS_TERMINAL_FOCUS_SCRIPT);
    assert.equal(WINDOWS_TERMINAL_FOCUS_SCRIPT.includes(TITLE), false);
    assert.deepEqual(request?.env, { ...ENV, [FOCUS_TITLE_VAR]: TITLE });
    assert.equal(request?.cwd, '/work');
  });

  it('selects the tmux window named exactly the title', () => {
    assert.deepEqual(focusRequest('tmux', TITLE, ENV, '/work'), { command: 'tmux', args: ['select-window', '-t', `=${TITLE}`], cwd: '/work', env: ENV });
  });

  it('has nothing for a terminal that selects no tab by its title', () => {
    for (const terminal of ['macos-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator'] as const) {
      assert.equal(focusRequest(terminal, TITLE, ENV, '/work'), undefined, terminal);
    }
  });

  it('keeps the progress record of its first module load off the caller', () => {
    assert.match(WINDOWS_TERMINAL_FOCUS_SCRIPT, /^\$ProgressPreference = 'SilentlyContinue'$/m);
  });
});

describe('focusTab', () => {
  it('brings the tab to the front in Windows Terminal, or says Windows kept another window in front', async () => {
    const processes = new FakeProcesses();
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'auto', TITLE, '/work'), { kind: 'focused', terminal: 'windows-terminal' });
    processes.onRun('powershell.exe', { kind: 'exited', code: FOCUS_EXIT.behind });
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'auto', TITLE, '/work'), { kind: 'behind', terminal: 'windows-terminal' });
    assert.equal(processes.ran.length, 2);
  });

  it('says why when no terminal has the tab', async () => {
    const processes = new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code: FOCUS_EXIT.noTab });
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'windows-terminal', TITLE, '/work'), { kind: 'none', reasons: [`no Windows Terminal tab is titled ${TITLE}`] });
    processes.onRun('powershell.exe', { kind: 'exited', code: 1 });
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'windows-terminal', TITLE, '/work'), { kind: 'none', reasons: ['Windows Terminal could not be searched (exit 1)'] });
    processes.onRun('powershell.exe', { kind: 'missing' });
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'windows-terminal', TITLE, '/work'), { kind: 'none', reasons: ['windows-terminal is not installed'] });
    processes.onRun('powershell.exe', { kind: 'failed', error: 'denied' });
    assert.deepEqual(await focusTab({ processes, env: ENV, platform: 'win32' }, 'windows-terminal', TITLE, '/work'), { kind: 'none', reasons: ['windows-terminal failed: denied'] });
  });

  it('inside tmux tries its window first, then the platform terminal', async () => {
    const processes = new FakeProcesses().onRun('tmux', { kind: 'exited', code: 1 });
    const deps = { processes, env: { ...ENV, TMUX: '/tmp/tmux-1/default,7,0' }, platform: 'win32' as const };
    assert.deepEqual(await focusTab(deps, 'auto', TITLE, '/work'), { kind: 'focused', terminal: 'windows-terminal' });
    assert.deepEqual(processes.ran.map((request) => request.command), ['tmux', 'powershell.exe']);
    processes.onRun('tmux', { kind: 'exited', code: 0 });
    assert.deepEqual(await focusTab({ ...deps, platform: 'linux' }, 'auto', TITLE, '/work'), { kind: 'focused', terminal: 'tmux' });
  });

  it('names the terminals that select no tab by its title, and tries none for print', async () => {
    const processes = new FakeProcesses().onRun('tmux', { kind: 'exited', code: 1 });
    assert.deepEqual(await focusTab({ processes, env: { TMUX: '/tmp/t,1,0' }, platform: 'linux' }, 'auto', TITLE, '/work'), {
      kind: 'none',
      reasons: [`tmux has no window named ${TITLE} (exit 1)`, 'gnome-terminal, konsole, x-terminal-emulator cannot select a tab by its title'],
    });
    assert.deepEqual(await focusTab({ processes, env: {}, platform: 'darwin' }, 'auto', TITLE, '/work'), { kind: 'none', reasons: ['macos-terminal cannot select a tab by its title'] });
    assert.deepEqual(await focusTab({ processes, env: {}, platform: 'win32' }, 'print', TITLE, '/work'), { kind: 'none', reasons: ['the terminal setting is print'] });
    assert.equal(processes.ran.length, 1);
  });
});
