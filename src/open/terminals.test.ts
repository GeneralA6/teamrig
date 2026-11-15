import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoTerminals, tabCommand, teamWindowOf, type TabCommand, type TabRequest } from './terminals.ts';

const ARGV = ['/usr/bin/node', '/opt/teamrig/dist/cli/main.js', 'launch', 'api', '--team', 'shop', '--project', '/w/shop', '--encoded-prompt', 'SGk'];
const TAB: TabRequest = { title: 'shop-api', folder: '/w/shop', argv: ARGV, window: undefined, focus: 'take' };

describe('tabCommand', () => {
  it('opens a tmux window in the folder, the command as separate arguments', () => {
    assert.deepEqual(tabCommand('tmux', TAB), {
      kind: 'command',
      request: { command: 'tmux', args: ['new-window', '-c', '/w/shop', '-n', 'shop-api', ...ARGV], cwd: '/w/shop', mode: 'exit' },
    });
  });

  it('opens a Windows Terminal tab in the current window, the command after --', () => {
    const tab: TabRequest = { title: 'shop-api', folder: 'C:\\w\\shop', argv: ['C:\\node\\node.exe', 'C:\\kit\\main.js', 'launch', 'api'], window: undefined, focus: 'take' };
    assert.deepEqual(tabCommand('windows-terminal', tab), {
      kind: 'command',
      request: {
        command: 'wt.exe',
        args: ['-w', '0', 'new-tab', '--title', 'shop-api', '-d', 'C:\\w\\shop', '--', 'C:\\node\\node.exe', 'C:\\kit\\main.js', 'launch', 'api'],
        cwd: 'C:\\w\\shop',
        mode: 'exit',
      },
    });
  });

  it("opens a Windows Terminal tab in the team's own window when the tab names one, made by that name when none is open (T1427)", () => {
    const planned = tabCommand('windows-terminal', { ...TAB, window: teamWindowOf(true, 'shop') });
    assert.deepEqual(planned.kind === 'command' ? planned.request.args.slice(0, 3) : [], ['-w', 'teamrig-shop', 'new-tab']);
  });

  it('names no window for a team that keeps its tabs with the others', () => {
    assert.equal(teamWindowOf(false, 'shop'), undefined);
  });

  it('opens the tab as before in a terminal that names no windows', () => {
    const named = { ...TAB, window: teamWindowOf(true, 'shop') };
    for (const terminal of ['tmux', 'macos-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator'] as const) {
      assert.deepEqual(tabCommand(terminal, named), tabCommand(terminal, TAB), terminal);
    }
  });

  it('will not hand Windows Terminal an argument it would split or expand', () => {
    for (const folder of ['C:\\a;b', 'C:\\%TEMP%', 'C:\\"x"', 'C:\\a\nb']) {
      const planned = tabCommand('windows-terminal', { ...TAB, folder });
      assert.equal(planned.kind, 'unusable', folder);
      assert.match(planned.kind === 'unusable' ? planned.why : '', /^Windows Terminal would misread /);
    }
  });

  it('gives macOS Terminal the quoted shell command as a run argument, never inside the script', () => {
    const hostile: TabRequest = { title: 't', folder: '/w/a "b"; $(id)', argv: ['/n', "it's `x`"], window: undefined, focus: 'take' };
    const planned = tabCommand('macos-terminal', hostile);
    assert.deepEqual(planned, {
      kind: 'command',
      request: {
        command: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          'do script (item 1 of argv)',
          '-e',
          'end tell',
          '-e',
          'end run',
          `cd '/w/a "b"; $(id)' && '/n' 'it'\\''s \`x\`'`,
        ],
        cwd: '/w/a "b"; $(id)',
        mode: 'exit',
      },
    });
  });

  it('opens a GNOME Terminal tab, a Konsole tab, or a Debian x-terminal-emulator window', () => {
    assert.deepEqual(tabCommand('gnome-terminal', TAB), {
      kind: 'command',
      request: { command: 'gnome-terminal', args: ['--tab', '--working-directory=/w/shop', '--', ...ARGV], cwd: '/w/shop', mode: 'exit' },
    });
    assert.deepEqual(tabCommand('konsole', TAB), {
      kind: 'command',
      request: { command: 'konsole', args: ['--new-tab', '--workdir', '/w/shop', '-e', ...ARGV], cwd: '/w/shop', mode: 'spawn' },
    });
    assert.deepEqual(tabCommand('x-terminal-emulator', TAB), {
      kind: 'command',
      request: { command: 'x-terminal-emulator', args: ['-T', 'shop-api', '-e', ...ARGV], cwd: '/w/shop', mode: 'spawn' },
    });
  });

  it('opens a tmux window behind the current one when the tab keeps the focus (T2510)', () => {
    const planned = tabCommand('tmux', { ...TAB, focus: 'keep' });
    assert.deepEqual(planned.kind === 'command' ? planned.request.args : [], ['new-window', '-d', '-c', '/w/shop', '-n', 'shop-api', ...ARGV]);
  });

  it('leaves macOS Terminal behind the app in front when the tab keeps the focus (T2510)', () => {
    const kept = tabCommand('macos-terminal', { ...TAB, focus: 'keep' });
    const taken = tabCommand('macos-terminal', TAB);
    const scriptOf = (planned: TabCommand): readonly string[] => (planned.kind === 'command' ? planned.request.args.filter((_, i, all) => all[i - 1] === '-e') : []);
    assert.deepEqual(scriptOf(kept), ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'end tell', 'end run']);
    assert.deepEqual(scriptOf(taken), ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run']);
  });

  it('leaves the Windows Terminal launch and the Linux terminals as they are: the focus is kept around them or not at all', () => {
    for (const terminal of ['windows-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator'] as const) {
      assert.deepEqual(tabCommand(terminal, { ...TAB, focus: 'keep' }), tabCommand(terminal, TAB), terminal);
    }
  });
});

describe('autoTerminals', () => {
  it('tries tmux first inside tmux, then the platform terminal', () => {
    assert.deepEqual(autoTerminals({}, 'win32'), ['windows-terminal']);
    assert.deepEqual(autoTerminals({ TMUX: '' }, 'darwin'), ['macos-terminal']);
    assert.deepEqual(autoTerminals({ TMUX: '/tmp/tmux-1/default,1,0' }, 'darwin'), ['tmux', 'macos-terminal']);
    assert.deepEqual(autoTerminals({}, 'linux'), ['gnome-terminal', 'konsole', 'x-terminal-emulator']);
    assert.deepEqual(autoTerminals({ TMUX: 'x' }, 'freebsd'), ['tmux', 'gnome-terminal', 'konsole', 'x-terminal-emulator']);
  });
});
