import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { errorCode, errorMessage, isNonNegativeInteger, isRecord, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { sweepTree, windowsSweepHost } from "../delivery/tree-kill.js";
import { nodeProgramRunner } from "../github/credentials.js";
import { exitText, outcomeOfError } from "./processes.js";
const CLAUDE_PROGRAM = /^claude(\.exe)?$/i;
const NODE_PROGRAM = /^node(\.exe)?$/i;
/** Whether a process is Claude Code: its own binary, or Node.js running its script. */
export function isClaudeProcess(info) {
    return CLAUDE_PROGRAM.test(info.name) || (NODE_PROGRAM.test(info.name) && /claude/i.test(info.commandLine));
}
/** Whether `pid` still runs Claude Code: a pid the system gave another program since does not count. */
export async function runsClaude(processes, pid) {
    if (pid === undefined || !processes.alive(pid)) {
        return false;
    }
    const info = await processes.describe(pid);
    return info !== undefined && isClaudeProcess(info);
}
/** PowerShell's start alone can take seconds on a busy machine. */
export const LOOKUP_TIMEOUT_MS = 20_000;
/** The stand-in for a SessionEnd hook gets as long as Claude Code gives its hooks by default. */
export const FEED_TIMEOUT_MS = 60_000;
/** `ps`'s arguments for every process: its id, its starter's and its command line. */
const POSIX_LISTING = ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='];
/** A real process id; anything else never reaches a command line. */
function isPid(pid) {
    return Number.isSafeInteger(pid) && pid > 0;
}
function windowsLookup(pid) {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        'if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress }';
    return ['-NoProfile', '-NonInteractive', '-Command', script];
}
function windowsChildren(pid) {
    const script = `$c = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,Name,CommandLine); ` +
        'ConvertTo-Json -Compress -InputObject $c';
    return ['-NoProfile', '-NonInteractive', '-Command', script];
}
/** Every process, with when it started in milliseconds since 1970 (0 where Windows does not say, as for its own). */
function windowsListing() {
    const started = "@{n='Started';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }}}";
    const script = `$a = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,${started}); ConvertTo-Json -Compress -InputObject $a`;
    return ['-NoProfile', '-NonInteractive', '-Command', script];
}
/** One process of PowerShell's JSON; undefined for another shape. */
function processOfRecord(record) {
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
export function parseWindowsProcess(stdout) {
    const record = parseObject(stdout.trim());
    return record === undefined ? undefined : processOfRecord(record);
}
/** PowerShell's JSON array of processes; undefined for any other output, or one entry of another shape. */
export function parseWindowsProcesses(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout.trim());
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    const entries = parsed;
    const found = [];
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
function programOf(commandLine) {
    const [program = ''] = commandLine.trim().split(/\s+/);
    return basename(program);
}
/** `ps -o ppid= -o args=`'s line for `pid`; undefined for no line. */
export function parsePosixProcess(pid, stdout) {
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
    const match = line === undefined ? null : /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
        return undefined;
    }
    const [, parent = '', commandLine = ''] = match;
    return { pid, parentPid: Number(parent), name: programOf(commandLine), commandLine: commandLine.trim() };
}
/** Every process, from `ps -A -o pid= -o ppid= -o args=`'s lines. */
export function parsePosixListing(stdout) {
    return stdout.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (match === null) {
            return [];
        }
        const [, pid = '', parent = '', commandLine = ''] = match;
        return [{ pid: Number(pid), parentPid: Number(parent), name: programOf(commandLine), commandLine: commandLine.trim() }];
    });
}
/** The processes `pid` started, from `ps -A -o pid= -o ppid= -o args=`'s lines. */
export function parsePosixChildren(pid, stdout) {
    return parsePosixListing(stdout).filter((info) => info.parentPid === pid);
}
/** PowerShell's JSON array of every process with its start; undefined for other output, and an entry of another shape is left out. */
export function parseWindowsListing(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout.trim());
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    const entries = parsed;
    return entries.flatMap((entry) => {
        const info = isRecord(entry) ? processOfRecord(entry) : undefined;
        const started = isRecord(entry) ? entry['Started'] : undefined;
        return info === undefined || !isNonNegativeInteger(started) ? [] : [{ info, startedMs: started }];
    });
}
/**
 * How long before a shell its exec stub may have started: the measured gap from Git's `env.exe` to the hook shell it
 * runs was 33 ms (T764), so this is room for a busy host, still short of matching an unrelated older process.
 */
export const EXEC_STUB_MS = 5_000;
/**
 * `pid` and its starters, from a listing of every process: it stops at a starter that is not listed (it ended), at
 * one that started after the process it would have started (an ended starter's reused id), and at a loop or id 0
 * (Windows lists its idle process as its own starter). Where it would stop, it goes on through the process's exec
 * stub when exactly one is listed (`execStubOf`): the `env.exe` Git for Windows runs a `#!/usr/bin/env sh` hook in.
 */
export function lineageOf(pid, listed) {
    const byPid = new Map(listed.map((entry) => [entry.info.pid, entry]));
    const chain = [];
    const seen = new Set();
    let current = byPid.get(pid);
    while (current !== undefined && !seen.has(current.info.pid)) {
        seen.add(current.info.pid);
        chain.push(current.info);
        const starter = isPid(current.info.parentPid) ? byPid.get(current.info.parentPid) : undefined;
        current = starter !== undefined && startedFirst(starter, current) ? starter : execStubOf(current, listed, seen);
    }
    return chain;
}
/** Whether `starter` started no later than `child`; true where either start is unknown, as in a `ps` listing. */
function startedFirst(starter, child) {
    return starter.startedMs === undefined || child.startedMs === undefined || starter.startedMs <= child.startedMs;
}
/** A command line's arguments: all after its program, a "quoted path" or the first word; empty for none. */
function argumentsOf(commandLine) {
    const line = commandLine.trim();
    const program = /^("[^"]*"|\S+)\s*/.exec(line);
    return program === null ? '' : line.slice(program[0].length);
}
/**
 * The process that ran `stopped` by an exec, where the line from `stopped` up has ended: Git for Windows runs a
 * `#!/usr/bin/env sh` hook as `env <hook>`, a Windows child of git that stays for the whole hook, and its runtime execs
 * the shell through a second `env` that ends at once, so the hook shell's own starter is gone and no listing links it
 * to git. The stub has the same arguments under another program (the exec swapped `env` for `sh`), started no later
 * than `stopped` and at most `EXEC_STUB_MS` before, and is not in the line yet. Only one such process counts: two
 * (two hooks with one path, in two worktrees of a repo at once) or none leave the line where it stopped, as does an
 * unknown start (a `ps` listing, where starters stay linked) or no arguments.
 */
function execStubOf(stopped, listed, seen) {
    const args = argumentsOf(stopped.info.commandLine);
    const started = stopped.startedMs;
    if (args === '' || started === undefined) {
        return undefined;
    }
    const name = stopped.info.name.toLowerCase();
    const stubs = listed.filter((entry) => !seen.has(entry.info.pid) &&
        entry.startedMs !== undefined &&
        entry.startedMs <= started &&
        started - entry.startedMs <= EXEC_STUB_MS &&
        entry.info.name.toLowerCase() !== name &&
        argumentsOf(entry.info.commandLine) === args);
    return stubs.length === 1 ? stubs[0] : undefined;
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
    const sweepHost = options.sweepHost ?? windowsSweepHost;
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
        async children(pid) {
            if (!isPid(pid)) {
                return undefined;
            }
            try {
                if (platform === 'win32') {
                    const result = await run({ program: 'powershell.exe', args: windowsChildren(pid) });
                    return result.end.kind === 'exited' && result.end.code === 0 ? parseWindowsProcesses(result.stdout) : undefined;
                }
                const result = await run({ program: 'ps', args: POSIX_LISTING });
                return result.end.kind === 'exited' && result.end.code === 0 ? parsePosixChildren(pid, result.stdout) : undefined;
            }
            catch {
                return undefined;
            }
        },
        async lineage(pid) {
            if (!isPid(pid)) {
                return undefined;
            }
            try {
                if (platform === 'win32') {
                    const result = await run({ program: 'powershell.exe', args: windowsListing() });
                    const listed = result.end.kind === 'exited' && result.end.code === 0 ? parseWindowsListing(result.stdout) : undefined;
                    return listed === undefined ? undefined : lineageOf(pid, listed);
                }
                // A process whose starter ends is adopted (its parent id changes), so no id in this listing is an ended starter's.
                const result = await run({ program: 'ps', args: POSIX_LISTING });
                return result.end.kind === 'exited' && result.end.code === 0 ? lineageOf(pid, parsePosixListing(result.stdout).map((info) => ({ info }))) : undefined;
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
                    const swept = await sweepTree(pid, sweepHost);
                    if (swept === 'unlisted') {
                        return { kind: 'failed', error: "the host's processes could not be listed, so nothing was ended" };
                    }
                    return swept === 'gone' ? { kind: 'gone' } : { kind: 'ended' };
                }
                catch (error) {
                    return { kind: 'failed', error: `the sweep failed: ${errorMessage(error)}` };
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
