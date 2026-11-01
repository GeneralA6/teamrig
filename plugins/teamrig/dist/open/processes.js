import { spawn } from 'node:child_process';
import { errorCode, errorMessage } from "../core/guards.js";
/** Long enough for any launcher that returns at all; one that is still running is then left alone. */
export const EXIT_WAIT_MS = 10_000;
/** The most of a failed launcher's error output a report repeats. */
const ERROR_TEXT_MAX = 300;
/** A program that could not start: not installed, or another reason in words. */
export function outcomeOfError(error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', error: errorMessage(error) };
}
/** Why a launcher failed: its exit code or signal, and the first line it wrote to stderr. */
export function exitText(code, stderr) {
    const [first = ''] = stderr.trim().split(/\r?\n/);
    const why = code === null ? 'ended by a signal' : `exited with code ${code}`;
    return first === '' ? why : `${why}: ${first.slice(0, ERROR_TEXT_MAX)}`;
}
/** An `exit` launcher: waits for its exit code, or treats it as started once it outlives the wait. */
function startUntilExit(request, waitMs) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(request.command, request.args, { cwd: request.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        }
        catch (error) {
            resolve(outcomeOfError(error));
            return;
        }
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(0, ERROR_TEXT_MAX * 2);
        });
        const timer = setTimeout(() => {
            child.stderr.destroy();
            child.unref();
            resolve({ kind: 'started', end: 'running' });
        }, waitMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve(outcomeOfError(error));
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? { kind: 'started', end: 'exited' } : { kind: 'failed', error: exitText(code, stderr) });
        });
    });
}
/** A `spawn` launcher, which is the new window: it runs on after this process ends, in its own process group. */
function startDetached(request) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(request.command, request.args, { cwd: request.cwd, detached: true, stdio: 'ignore' });
        }
        catch (error) {
            resolve(outcomeOfError(error));
            return;
        }
        child.once('error', (error) => resolve(outcomeOfError(error)));
        child.once('spawn', () => {
            child.unref();
            resolve({ kind: 'started', end: 'spawned' });
        });
    });
}
/** The exit code of HIDDEN_LAUNCHER when the program it was given is not installed. */
const LAUNCH_MISSING = 9;
/**
 * A node script that starts the program after its `--` hidden and detached, then exits: 0 once the program runs,
 * LAUNCH_MISSING when it is not installed, 1 with the reason on stderr when it cannot start for another reason.
 */
const HIDDEN_LAUNCHER = `
const [command, ...args] = process.argv.slice(1);
const fail = (error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? ${LAUNCH_MISSING} : 1);
};
try {
  const child = require('node:child_process').spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', fail);
  child.once('spawn', () => {
    child.unref();
    process.exit(0);
  });
} catch (error) {
  fail(error);
}`;
/**
 * A hidden background program, with no console window, started through HIDDEN_LAUNCHER: the launcher has exited
 * when this resolves, so the program is no longer a descendant of this process and outlives a kill of it with every
 * process it started. That is how Claude Code ends a hook past its timeout (taskkill /T on Windows), which took the
 * automatic restart a Stop hook had just started with it.
 */
function startHiddenProgram(request) {
    return new Promise((resolve) => {
        let launcher;
        try {
            launcher = spawn(process.execPath, ['-e', HIDDEN_LAUNCHER, '--', request.command, ...request.args], {
                cwd: request.cwd,
                env: { ...request.env },
                detached: true,
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
        }
        catch (error) {
            resolve(outcomeOfError(error));
            return;
        }
        let stderr = '';
        launcher.stderr.setEncoding('utf8');
        launcher.stderr.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(0, ERROR_TEXT_MAX * 2);
        });
        launcher.once('error', (error) => resolve(outcomeOfError(error)));
        launcher.once('close', (code) => {
            switch (code) {
                case 0:
                    resolve({ kind: 'started', end: 'spawned' });
                    break;
                case LAUNCH_MISSING:
                    resolve({ kind: 'missing' });
                    break;
                default:
                    resolve({ kind: 'failed', error: exitText(code, stderr) });
            }
        });
    });
}
/**
 * Ctrl+C reaches every process in the terminal. Claude Code handles it itself, and this parent must
 * outlive it: the tab ends when its first process does.
 */
function runAttached(request, interrupts) {
    return new Promise((resolve) => {
        const ignore = () => undefined;
        interrupts.on('SIGINT', ignore);
        const settle = (outcome) => {
            interrupts.off('SIGINT', ignore);
            resolve(outcome);
        };
        let child;
        try {
            child = spawn(request.command, request.args, { cwd: request.cwd, env: { ...request.env }, stdio: 'inherit' });
        }
        catch (error) {
            settle(outcomeOfError(error));
            return;
        }
        child.once('error', (error) => settle(outcomeOfError(error)));
        child.once('exit', (code) => settle({ kind: 'exited', code: code ?? 1 }));
    });
}
/** Real child processes, each started with no shell. */
export function nodeProcesses(options = {}) {
    const waitMs = options.exitWaitMs ?? EXIT_WAIT_MS;
    const interrupts = options.interrupts ?? process;
    return {
        start: (request) => (request.mode === 'exit' ? startUntilExit(request, waitMs) : startDetached(request)),
        run: (request) => runAttached(request, interrupts),
        startHidden: startHiddenProgram,
    };
}
