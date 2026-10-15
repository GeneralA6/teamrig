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
            resolve({ kind: 'started' });
        }, waitMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve(outcomeOfError(error));
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? { kind: 'started' } : { kind: 'failed', error: exitText(code, stderr) });
        });
    });
}
/**
 * A program that runs on after this process ends, in its own process group: a `spawn` launcher, which is the new
 * window, or a hidden background program (`extra` hides the console window Windows would open for it).
 */
function startDetached(request, extra = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(request.command, request.args, { cwd: request.cwd, detached: true, stdio: 'ignore', ...extra });
        }
        catch (error) {
            resolve(outcomeOfError(error));
            return;
        }
        child.once('error', (error) => resolve(outcomeOfError(error)));
        child.once('spawn', () => {
            child.unref();
            resolve({ kind: 'started' });
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
        startHidden: (request) => startDetached(request, { env: { ...request.env }, windowsHide: true }),
    };
}
