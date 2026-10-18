import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProgramRequest, ProgramResult, ProgramRunner } from '../github/credentials.ts';
import { RESTORE_RUN_VALUE, systemLogonEntry, WINDOWS_READ_SCRIPT, WINDOWS_REMOVE_SCRIPT, WINDOWS_RUN_KEY, type LogonEntry } from './logon.ts';

const COMMAND = '"C:\\Windows\\System32\\conhost.exe" --headless "C:\\Program Files\\nodejs\\node.exe" "D:\\kits\\Zoë\\.teamrig\\bin\\restore-check.mjs"';

/** A runner that records each request and answers with the next of `results`, else an empty exit 0. */
function recordingRunner(results: ProgramResult[] = []): { readonly run: ProgramRunner; readonly ran: ProgramRequest[] } {
  const ran: ProgramRequest[] = [];
  return {
    ran,
    run: async (request) => {
      ran.push(request);
      return results.shift() ?? exited(0);
    },
  };
}

function exited(code: number, stdout = '', stderr = ''): ProgramResult {
  return { end: { kind: 'exited', code }, stdout, stderr };
}

/** The script a PowerShell request carries. */
function scriptOf(request: ProgramRequest | undefined): string {
  assert.ok(request !== undefined);
  assert.equal(request.program, 'powershell.exe');
  return Buffer.from(request.args[request.args.length - 1] ?? '', 'base64').toString('utf16le');
}

function windowsEntry(run: ProgramRunner, systemRoot?: string): LogonEntry {
  const entry = systemLogonEntry('win32', systemRoot, run);
  assert.ok(entry !== undefined);
  return entry;
}

describe('systemLogonEntry', () => {
  it('has no entry off Windows', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      assert.equal(systemLogonEntry(platform, undefined, recordingRunner().run), undefined);
    }
  });

  it("is the Run key value, whose command runs Node with no window through the system's conhost", () => {
    const entry = windowsEntry(recordingRunner().run, 'D:\\Win');
    assert.equal(entry.where, `${WINDOWS_RUN_KEY} ${RESTORE_RUN_VALUE}`);
    assert.equal(entry.commandFor('C:\\node\\node.exe', 'C:\\kit\\bin\\restore-check.mjs'), '"D:\\Win\\System32\\conhost.exe" --headless "C:\\node\\node.exe" "C:\\kit\\bin\\restore-check.mjs"');
    assert.match(windowsEntry(recordingRunner().run).commandFor('n', 's'), /^"C:\\Windows\\System32\\conhost\.exe" --headless/);
  });

  it('reads the command from UTF-8 base64, so every character survives; nothing printed is no entry', async () => {
    const { run, ran } = recordingRunner([exited(0, `${Buffer.from(COMMAND, 'utf8').toString('base64')}\r\n`), exited(0, '\r\n')]);
    const entry = windowsEntry(run);
    assert.equal(await entry.read(), COMMAND);
    assert.equal(await entry.read(), undefined);
    assert.equal(scriptOf(ran[0]), WINDOWS_READ_SCRIPT);
    assert.match(WINDOWS_READ_SCRIPT, /'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'/);
    assert.match(WINDOWS_READ_SCRIPT, new RegExp(`\\$name = '${RESTORE_RUN_VALUE}'`));
  });

  it('writes the command carried as base64 inside the script, quotes and all', async () => {
    const { run, ran } = recordingRunner();
    await windowsEntry(run).write(COMMAND);
    const script = scriptOf(ran[0]);
    const carried = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];
    assert.equal(Buffer.from(carried ?? '', 'base64').toString('utf8'), COMMAND);
    assert.match(script, /New-ItemProperty -LiteralPath \$key -Name \$name -Value \$command -PropertyType String -Force/);
    assert.match(script, /^\$ErrorActionPreference = 'Stop'/);
  });

  it('removes the value only when it is there', async () => {
    const { run, ran } = recordingRunner();
    await windowsEntry(run).remove();
    assert.equal(scriptOf(ran[0]), WINDOWS_REMOVE_SCRIPT);
    assert.match(WINDOWS_REMOVE_SCRIPT, /if \(\$null -ne \(Get-ItemProperty -LiteralPath \$key -Name \$name -ErrorAction SilentlyContinue\)\)/);
  });

  it('throws with the first line PowerShell printed when it fails', async () => {
    const { run } = recordingRunner([
      exited(1, '', '\r\nRequested registry access is not allowed.\r\nAt line:4'),
      { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' },
      exited(1, 'partial'),
    ]);
    const entry = windowsEntry(run);
    await assert.rejects(entry.write(COMMAND), /PowerShell ended with exit 1: Requested registry access is not allowed\.$/);
    await assert.rejects(entry.read(), /PowerShell ended with signal SIGTERM: no error text/);
    await assert.rejects(entry.remove(), /PowerShell ended with exit 1: partial/);
  });

  it('lets a PowerShell that cannot start reject', async () => {
    const entry = windowsEntry(async () => {
      throw new Error('spawn powershell.exe ENOENT');
    });
    await assert.rejects(entry.read(), /ENOENT/);
  });
});
