import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWindowsPowerShell } from './fake-windows-powershell.ts';

const SIGNED = { pid: 51, parentPid: 41, name: 'bash.exe', commandLine: 'grep -n § notes.md', startedMs: 200 };

describe('FakeWindowsPowerShell', () => {
  it('writes § as the OEM byte 0x15 unless the script sets its output to UTF-8', async () => {
    const shell = new FakeWindowsPowerShell([SIGNED]);
    const oem = await shell.run({ program: 'powershell.exe', args: ['-Command', 'Get-CimInstance Win32_Process'] });
    assert.match(oem.stdout, /grep -n \u0015 notes/);
    assert.throws(() => JSON.parse(oem.stdout));
    const utf8 = await shell.run({ program: 'powershell.exe', args: ['-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process'] });
    assert.deepEqual(JSON.parse(utf8.stdout), [{ ProcessId: 51, ParentProcessId: 41, Name: 'bash.exe', CommandLine: 'grep -n § notes.md', Started: 200 }]);
  });

  it('answers one process by its id, the ones a process started, and refuses what is not a PowerShell script', async () => {
    const shell = new FakeWindowsPowerShell([{ pid: 41, parentPid: 7, name: 'claude.exe', commandLine: null, startedMs: 100 }, SIGNED]);
    const one = await shell.run({ program: 'powershell.exe', args: ['-Command', "Get-CimInstance Win32_Process -Filter 'ProcessId=41'"] });
    assert.deepEqual(JSON.parse(one.stdout), { ProcessId: 41, ParentProcessId: 7, Name: 'claude.exe', CommandLine: null });
    const none = await shell.run({ program: 'powershell.exe', args: ['-Command', "Get-CimInstance Win32_Process -Filter 'ProcessId=99'"] });
    assert.equal(none.stdout, '');
    const children = await shell.run({ program: 'powershell.exe', args: ['-Command', "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter 'ParentProcessId=41'"] });
    assert.deepEqual(JSON.parse(children.stdout), [{ ProcessId: 51, ParentProcessId: 41, Name: 'bash.exe', CommandLine: 'grep -n § notes.md' }]);
    assert.deepEqual((await shell.run({ program: 'ps', args: [] })).end, { kind: 'exited', code: 1 });
    assert.equal(shell.asked.length, 4);
  });
});
