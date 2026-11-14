import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { KEEP_FOCUS_ARGS_VAR, KEEP_FOCUS_EXIT, KEEP_FOCUS_PROGRAM_VAR, keepFocusRequest, startKeepingFocus, WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT } from './keep-focus.ts';
import type { StartRequest } from './processes.ts';

const ENV = { PATH: 'C:\\bin' };
const TITLE = '[shop] api';
const LAUNCHER: StartRequest = {
  command: 'wt.exe',
  args: ['-w', '0', 'new-tab', '--title', TITLE, '-d', 'C:\\w\\shop dir\\', '--', 'C:\\node.exe', 'launch', 'say "hi"'],
  cwd: 'C:\\w\\shop dir\\',
  mode: 'exit',
};

function scriptOf(args: readonly string[]): string {
  return Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
}

describe('keepFocusRequest', () => {
  it('runs the script with the launcher and its command line as variables, never inside it', () => {
    const request = keepFocusRequest(LAUNCHER, ENV);
    assert.equal(request.command, 'powershell.exe');
    assert.deepEqual(request.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(scriptOf(request.args), WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT);
    assert.equal(WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT.includes(TITLE), false);
    assert.deepEqual(request.env, {
      ...ENV,
      [KEEP_FOCUS_PROGRAM_VAR]: 'wt.exe',
      [KEEP_FOCUS_ARGS_VAR]: '-w 0 new-tab --title "[shop] api" -d "C:\\w\\shop dir\\\\" -- C:\\node.exe launch "say \\"hi\\""',
    });
    assert.equal(request.cwd, LAUNCHER.cwd);
  });

  it('keeps the progress record of its first module load off the caller', () => {
    assert.match(WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT, /^\$ProgressPreference = 'SilentlyContinue'$/m);
  });

  // Parsed only, never run: a run would open a real tab.
  it('is a script Windows PowerShell parses without an error', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const check = [
      '$errors = $null',
      "[void][System.Management.Automation.Language.Parser]::ParseInput($env:TEAMRIG_TEST_SCRIPT, [ref]$null, [ref]$errors)",
      'if ($errors.Count -gt 0) { [Console]::Error.WriteLine(($errors | ForEach-Object { $_.Message }) -join "; "); exit 1 }',
    ].join('\n');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], {
      env: { ...process.env, TEAMRIG_TEST_SCRIPT: WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('startKeepingFocus', () => {
  it('reads each exit of the script as the launch it was, starting nothing else', async () => {
    const cases = [
      [0, { kind: 'started', end: 'exited' }],
      [KEEP_FOCUS_EXIT.focusLost, { kind: 'started', end: 'exited' }],
      [KEEP_FOCUS_EXIT.running, { kind: 'started', end: 'running' }],
      [KEEP_FOCUS_EXIT.missing, { kind: 'missing' }],
      [KEEP_FOCUS_EXIT.launcherFailed, { kind: 'failed', error: 'wt.exe exited with an error' }],
      [1, { kind: 'failed', error: 'the script that keeps the focus failed (exit 1)' }],
    ] as const;
    for (const [code, expected] of cases) {
      const processes = new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code });
      assert.deepEqual(await startKeepingFocus(processes, ENV, LAUNCHER), expected, `exit ${code}`);
      assert.equal(processes.ran.length, 1);
      assert.deepEqual(processes.started, [], `exit ${code} starts no plain launcher`);
    }
  });

  it('starts the launcher plainly when Windows PowerShell cannot run', async () => {
    for (const unavailable of [{ kind: 'missing' }, { kind: 'failed', error: 'EACCES' }] as const) {
      const processes = new FakeProcesses().onRun('powershell.exe', unavailable).onStart('wt.exe', { kind: 'started', end: 'exited' });
      assert.deepEqual(await startKeepingFocus(processes, ENV, LAUNCHER), { kind: 'started', end: 'exited' });
      assert.deepEqual(processes.started, [LAUNCHER]);
    }
  });
});
