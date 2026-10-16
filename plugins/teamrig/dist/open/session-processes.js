import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { errorCode, errorMessage, isNonNegativeInteger, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { nodeProgramRunner } from "../github/credentials.js";
import { exitText, outcomeOfError } from "./processes.js";
/** PowerShell's start alone can take seconds on a busy machine. */
export const LOOKUP_TIMEOUT_MS = 20_000;
/** The stand-in for a SessionEnd hook gets as long as Claude Code gives its hooks by default. */
export const FEED_TIMEOUT_MS = 60_000;
/** taskkill's exit code when no process has the id. */
const TASKKILL_NOT_FOUND = 128;
/** A real process id; anything else never reaches a command line. */
function isPid(pid) {
    return Number.isSafeInteger(pid) && pid > 0;
}
function windowsLookup(pid) {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        'if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress }';
    return ['-NoProfile', '-NonInteractive', '-Command', script];
}
/** PowerShell's one-object JSON; undefined for no output or another shape. */
export function parseWindowsProcess(stdout) {
    const record = parseObject(stdout.trim());
    if (record === undefined) {
        return undefined;
    }
    const pid = record['ProcessId'];
    const parentPid = record['ParentProcessId'];
    const name = stringField(record, 'Name');
    const commandLine = record['CommandLine'];
    if (!isNonNegativeInteger(pid) || !isNonNegativeInteger(parentPid) || name === undefined || (commandLine !== null && typeof commandLine !== 'string')) {
        return undefined;
    }
    return { pid, parentPid, name, commandLine: commandLine ?? '' };
}
/** `ps -o ppid= -o args=`'s line for `pid`; undefined for no line. */
export function parsePosixProcess(pid, stdout) {
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
    const match = line === undefined ? null : /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
        return undefined;
    }
    const [, parent = '', commandLine = ''] = match;
    const [program = ''] = commandLine.trim().split(/\s+/);
    return { pid, parentPid: Number(parent), name: basename(program), commandLine: commandLine.trim() };
}
function feedProgram(request, timeoutMs) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(request.command, request.args, { cwd: request.cwd, stdio: ['pipe', 'ignore', 'pipe'], timeout: timeoutMs, windowsHide: true });
        }
        catch (error) {
            resolve(outcomeOfError(error));
            return;
        }
        const stderr = [];
        child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
        // A program that exits without reading its input closes the pipe: that is its business, not an error.
        child.stdin.on('error', () => undefined);
        child.stdin.end(request.input);
        child.once('error', (error) => resolve(outcomeOfError(error)));
        child.once('close', (code) => resolve(code === 0 ? { kind: 'done' } : { kind: 'failed', error: exitText(code, stderr.join('')) }));
    });
}
/** The real processes of this machine. */
export function nodeSessionProcesses(options = {}) {
    const platform = options.platform ?? process.platform;
    const run = options.run ?? nodeProgramRunner(LOOKUP_TIMEOUT_MS);
    const signal = options.signal ?? ((pid, sent) => {
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
            }
            catch (error) {
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
            }
            catch {
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
                }
                catch (error) {
                    return { kind: 'failed', error: `taskkill could not start: ${errorMessage(error)}` };
                }
            }
            try {
                signal(pid, how === 'ask' ? 'SIGTERM' : 'SIGKILL');
                return { kind: 'ended' };
            }
            catch (error) {
                return errorCode(error) === 'ESRCH' ? { kind: 'gone' } : { kind: 'failed', error: errorMessage(error) };
            }
        },
        feed: (request) => feedProgram(request, feedTimeoutMs),
    };
}
