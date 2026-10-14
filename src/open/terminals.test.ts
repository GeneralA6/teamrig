import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoTerminals, tabCommand, type TabRequest } from './terminals.ts';

const ARGV = ['/usr/bin/node', '/opt/teamrig/dist/cli/main.js', 'launch', 'api', '--team', 'shop', '--project', '/w/shop', '--encoded-prompt', 'SGk'];
const TAB: TabRequest = { title: 'shop-api', folder: '/w/shop', argv: ARGV };

describe('tabCommand', () => {
  it('opens a tmux window in the folder, the command as separate arguments', () => {
    assert.deepEqual(tabCommand('tmux', TAB), {
      kind: 'command',
      request: { command: 'tmux', args: ['new-window', '-c', '/w/shop', '-n', 'shop-api', ...ARGV], cwd: '/w/shop', mode: 'exit' },
    });
  });

  it('opens a Windows Terminal tab in the current window, the command after --', () => {
    const tab: TabRequest = { title: 'shop-api', folder: 'C:\\w\\shop', argv: ['C:\\node\\node.exe', 'C:\\kit\\main.js', 'launch', 'api'] };
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

  it('will not hand Windows Terminal an argument it would split or expand', () => {
    for (const folder of ['C:\\a;b', 'C:\\%TEMP%', 'C:\\"x"', 'C:\\a\nb']) {
      const planned = tabCommand('windows-terminal', { ...TAB, folder });
      assert.equal(planned.kind, 'unusable', folder);
      assert.match(planned.kind === 'unusable' ? planned.why : '', /^Windows Terminal would misread /);
    }
  });

  it('gives macOS Terminal the quoted shell command as a run argument, never inside the script', () => {
    const hostile: TabRequest = { title: 't', folder: '/w/a "b"; $(id)', argv: ['/n', "it's `x`"] };
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
