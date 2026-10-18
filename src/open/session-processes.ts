import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { errorCode, errorMessage, isNonNegativeInteger, isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { nodeProgramRunner, type ProgramRunner } from '../github/credentials.ts';
import { exitText, outcomeOfError } from './processes.ts';

/** One running process as the system describes it. */
export interface ProcessInfo {
  readonly pid: number;
  /** The process that started it; that one may have ended since. */
  readonly parentPid: number;
  /** Its program's file name, such as `claude.exe` or `node`. */
  readonly name: string;
  /** Its whole command line; empty when the system does not show it (a process of another user). */
  readonly commandLine: string;
}

const CLAUDE_PROGRAM = /^claude(\.exe)?$/i;
const NODE_PROGRAM = /^node(\.exe)?$/i;

/** Whether a process is Claude Code: its own binary, or Node.js running its script. */
export function isClaudeProcess(info: ProcessInfo): boolean {
  return CLAUDE_PROGRAM.test(info.name) || (NODE_PROGRAM.test(info.name) && /claude/i.test(info.commandLine));
}

export type EndOutcome = { readonly kind: 'ended' } | { readonly kind: 'gone' } | { readonly kind: 'failed'; readonly error: string };

/** A program run with `input` on its stdin; its output is dropped. */
export interface FeedRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input: string;
}

export type FeedOutcome = { readonly kind: 'done' } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly error: string };

/** How a process is ended: `ask` lets it shut down, `force` does not. */
export type EndHow = 'ask' | 'force';

/**
 * The processes around a running Claude Code session, for the automatic restart (`refresh.autoRestart`):
 * the hook's parent (the session's Claude Code), whether a process still runs and what it is, ending it,
 * and running the program that stands in for the SessionEnd hooks such an end skips.
 */
export interface SessionProcesses {
  /** The process that started this one: for a hook, the session's Claude Code. */
  readonly parentPid: number;
  alive(pid: number): boolean;
  /** What runs as `pid`; undefined when nothing does, or the system would not tell. */
  describe(pid: number): Promise<ProcessInfo | undefined>;
  /**
   * The running processes `pid` started, such as the shells a Claude Code runs commands in; undefined when the
   * system would not tell. A process keeps its starter's id after the starter ends, so where ids are reused a
   * process an earlier holder of `pid` started is listed too.
   */
  children(pid: number): Promise<readonly ProcessInfo[] | undefined>;
  /**
   * Ends `pid`. On Windows, where a console program cannot be asked to close, it and every process it
   * started end at once (`taskkill /T /F`), and a process whose starter has ended is no longer in that
   * tree; elsewhere `ask` sends SIGTERM and `force` SIGKILL, to `pid` alone.
   */
  end(pid: number, how: EndHow): Promise<EndOutcome>;
  /** Runs a program with `input` on stdin until it exits, for at most a time limit. */
  feed(request: FeedRequest): Promise<FeedOutcome>;
}

export interface SessionProcessesOptions {
  readonly platform?: NodeJS.Platform;
  readonly parentPid?: number;
  /** Runs `ps`, PowerShell and taskkill. */
  readonly run?: ProgramRunner;
  /** `process.kill`: sends `signal`, or with 0 only checks that the process is there. */
  readonly signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly feedTimeoutMs?: number;
}

/** PowerShell's start alone can take seconds on a busy machine. */
export const LOOKUP_TIMEOUT_MS = 20_000;
/** The stand-in for a SessionEnd hook gets as long as Claude Code gives its hooks by default. */
export const FEED_TIMEOUT_MS = 60_000;
/** taskkill's exit code when no process has the id. */
const TASKKILL_NOT_FOUND = 128;

/** A real process id; anything else never reaches a command line. */
function isPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function windowsLookup(pid: number): readonly string[] {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    'if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress }';
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

function windowsChildren(pid: number): readonly string[] {
  const script =
    `$c = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,Name,CommandLine); ` +
    'ConvertTo-Json -Compress -InputObject $c';
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

/** One process of PowerShell's JSON; undefined for another shape. */
function processOfRecord(record: JsonRecord): ProcessInfo | undefined {
  const pid = record['ProcessId'];
  const parentPid = record['ParentProcessId'];
  const name = stringField(record, 'Name');
  const commandLine = record['CommandLine'];
  if (!isNonNegativeInteger(pid) || !isNonNegativeInteger(parentPid) || name === undefined || (commandLine !== null && typeof commandLine !== 'string')) {
    return undefined;
  }
  return { pid, parentPid, name, commandLine: commandLine ?? '' };
}

/** PowerShell's one-object JSON; undefined for no output or another shape. */
export function parseWindowsProcess(stdout: string): ProcessInfo | undefined {
  const record = parseObject(stdout.trim());
  return record === undefined ? undefined : processOfRecord(record);
}

/** PowerShell's JSON array of processes; undefined for any other output, or one entry of another shape. */
export function parseWindowsProcesses(stdout: string): readonly ProcessInfo[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const entries: readonly unknown[] = parsed;
  const found: ProcessInfo[] = [];
  for (const entry of entries) {
    const info = isRecord(entry) ? processOfRecord(entry) : undefined;
    if (info === undefined) {
      return undefined;
    }
    found.push(info);
  }
  return found;
}

/** The file name of a command line's program; a login shell's starts with a dash, as `-bash`. */
function programOf(commandLine: string): string {
  const [program = ''] = commandLine.trim().split(/\s+/);
  return basename(program);
}

/** `ps -o ppid= -o args=`'s line for `pid`; undefined for no line. */
export function parsePosixProcess(pid: number, stdout: string): ProcessInfo | undefined {
  const line = stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
  const match = line === undefined ? null : /^\s*(\d+)\s+(.*)$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const [, parent = '', commandLine = ''] = match;
  return { pid, parentPid: Number(parent), name: programOf(commandLine), commandLine: commandLine.trim() };
}

/** The processes `pid` started, from `ps -A -o pid= -o ppid= -o args=`'s lines. */
export function parsePosixChildren(pid: number, stdout: string): readonly ProcessInfo[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
      return [];
    }
    const [, child = '', parent = '', commandLine = ''] = match;
    return Number(parent) === pid ? [{ pid: Number(child), parentPid: pid, name: programOf(commandLine), commandLine: commandLine.trim() }] : [];
  });
}

function feedProgram(request: FeedRequest, timeoutMs: number): Promise<FeedOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, stdio: ['pipe', 'ignore', 'pipe'], timeout: timeoutMs, windowsHide: true });
    } catch (error) {
      resolve(outcomeOfError(error));
      return;
    }
    const stderr: string[] = [];
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
    // A program that exits without reading its input closes the pipe: that is its business, not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
    child.once('error', (error) => resolve(outcomeOfError(error)));
    child.once('close', (code) => resolve(code === 0 ? { kind: 'done' } : { kind: 'failed', error: exitText(code, stderr.join('')) }));
  });
}

/** The real processes of this machine. */
export function nodeSessionProcesses(options: SessionProcessesOptions = {}): SessionProcesses {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? nodeProgramRunner(LOOKUP_TIMEOUT_MS);
  const signal = options.signal ?? ((pid: number, sent: NodeJS.Signals | 0): void => {
    process.kill(pid, sent);
  });
  const feedTimeoutMs = options.feedTimeoutMs ?? FEED_TIMEOUT_MS;
  return {
    parentPid: options.parentPid ?? process.ppid,
    alive(pid) {
      if (!isPid(pid)) {
        return false;
      }
      try {
        signal(pid, 0);
        return true;
      } catch (error) {
        // The process is there, and belongs to someone this one may not signal.
        return errorCode(error) === 'EPERM';
      }
    },
    async describe(pid) {
      if (!isPid(pid)) {
        return undefined;
      }
      try {
        if (platform === 'win32') {
          const result = await run({ program: 'powershell.exe', args: windowsLookup(pid) });
          return result.end.kind === 'exited' && result.end.code === 0 ? parseWindowsProcess(result.stdout) : undefined;
        }
        const result = await run({ program: 'ps', args: ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)] });
        return result.end.kind === 'exited' && result.end.code === 0 ? parsePosixProcess(pid, result.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    async children(pid) {
      if (!isPid(pid)) {
        return undefined;
      }
      try {
        if (platform === 'win32') {
          const result = await run({ program: 'powershell.exe', args: windowsChildren(pid) });
          return result.end.kind === 'exited' && result.end.code === 0 ? parseWindowsProcesses(result.stdout) : undefined;
        }
        const result = await run({ program: 'ps', args: ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='] });
        return result.end.kind === 'exited' && result.end.code === 0 ? parsePosixChildren(pid, result.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    async end(pid, how) {
      if (!isPid(pid)) {
        return { kind: 'gone' };
      }
      if (platform === 'win32') {
        try {
          const result = await run({ program: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] });
          if (result.end.kind === 'exited' && result.end.code === 0) {
            return { kind: 'ended' };
          }
          if (result.end.kind === 'exited' && result.end.code === TASKKILL_NOT_FOUND) {
            return { kind: 'gone' };
          }
          return { kind: 'failed', error: exitText(result.end.kind === 'exited' ? result.end.code : null, result.stderr) };
        } catch (error) {
          return { kind: 'failed', error: `taskkill could not start: ${errorMessage(error)}` };
        }
      }
      try {
        signal(pid, how === 'ask' ? 'SIGTERM' : 'SIGKILL');
        return { kind: 'ended' };
      } catch (error) {
        return errorCode(error) === 'ESRCH' ? { kind: 'gone' } : { kind: 'failed', error: errorMessage(error) };
      }
    },
    feed: (request) => feedProgram(request, feedTimeoutMs),
  };
}
