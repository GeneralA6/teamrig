import type { ProgramRequest, ProgramResult } from '../core/program-runner.ts';

/** One process as Win32_Process describes it; a null command line is one Windows does not show. */
export interface Win32Process {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string | null;
  readonly startedMs: number;
}

/** The line a script sets its output to UTF-8 with. */
const UTF8_OUTPUT = /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/;

/**
 * What a UTF-8 reader gets from Windows PowerShell's console when the script leaves its output encoding alone: the
 * OEM code page (437), which writes `§` as the byte 0x15, a control character, and every other character past ASCII
 * as one byte that is no UTF-8 on its own.
 */
function oemAsUtf8(text: string): string {
  return [...text].map((char) => (char === '§' ? '\u0015' : (char.codePointAt(0) ?? 0) < 0x80 ? char : '\uFFFD')).join('');
}

/**
 * `powershell.exe -Command` answering the Win32_Process queries the process listings ask, over `processes`: one
 * process by `ProcessId=<n>`, the ones a process started by `ParentProcessId=<n>`, and every one with its start
 * otherwise, as ConvertTo-Json writes them, in the console's encoding. It records each request.
 */
export class FakeWindowsPowerShell {
  readonly asked: ProgramRequest[] = [];
  private readonly processes: readonly Win32Process[];

  constructor(processes: readonly Win32Process[]) {
    this.processes = processes;
  }

  readonly run = (request: ProgramRequest): Promise<ProgramResult> => {
    this.asked.push(request);
    const script = request.args[request.args.indexOf('-Command') + 1];
    if (request.program !== 'powershell.exe' || !request.args.includes('-Command') || script === undefined) {
      return Promise.resolve({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'not a PowerShell script' });
    }
    const printed = this.printed(script);
    return Promise.resolve({ end: { kind: 'exited', code: 0 }, stdout: UTF8_OUTPUT.test(script) ? printed : oemAsUtf8(printed), stderr: '' });
  };

  private printed(script: string): string {
    const record = (process: Win32Process) => ({ ProcessId: process.pid, ParentProcessId: process.parentPid, Name: process.name, CommandLine: process.commandLine });
    const one = /-Filter 'ProcessId=(\d+)'/.exec(script);
    if (one !== null) {
      const found = this.processes.find((process) => process.pid === Number(one[1]));
      return found === undefined ? '' : `${JSON.stringify(record(found))}\r\n`;
    }
    const children = /-Filter 'ParentProcessId=(\d+)'/.exec(script);
    if (children !== null) {
      return `${JSON.stringify(this.processes.filter((process) => process.parentPid === Number(children[1])).map(record))}\r\n`;
    }
    return `${JSON.stringify(this.processes.map((process) => ({ ...record(process), Started: process.startedMs })))}\r\n`;
  }
}
