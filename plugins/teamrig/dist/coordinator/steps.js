import { execFile, spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
/** The exit code recorded for a step killed at its time limit, as `timeout(1)` reports one. */
export const TIMED_OUT_EXIT = 124;
/** The exit code recorded for a step killed by its `stop`, as a shell reports a command a closed terminal hung up (128 + SIGHUP). */
export const STOPPED_EXIT = 129;
/** The exit code a step's ledger record carries: its own, 124 when killed at its limit, 129 when killed by its `stop`, 1 when a signal stopped it. */
export function exitCodeOf(end) {
    switch (end.kind) {
        case 'exited':
            return end.code;
        case 'timedOut':
            return TIMED_OUT_EXIT;
        case 'stopped':
            return STOPPED_EXIT;
        case 'signal':
            return 1;
    }
}
/**
 * On Windows `taskkill /T` ends the tree: killing only the shell would leave the command it started running. On
 * POSIX the step runs as its own process group, and the group is killed.
 */
export function nodeTreeKill(platform) {
    if (platform === 'win32') {
        return (pid) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
        };
    }
    return (pid) => {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            // The group ended on its own between the timer and the kill.
        }
    };
}
/** The real runner: Node's `spawn` in the platform's shell, with inherited stdio; its time limit or its `stop` kills the tree. */
export function nodeStepRunner(platform, kill = nodeTreeKill(platform)) {
    return {
        run: (request) => new Promise((resolve, reject) => {
            const child = spawn(request.command, {
                shell: true,
                cwd: request.cwd,
                env: { ...request.env },
                stdio: 'inherit',
                windowsHide: true,
                detached: platform !== 'win32',
            });
            let killed;
            const killAs = (why) => {
                if (killed !== undefined) {
                    return;
                }
                killed = why;
                if (child.pid !== undefined) {
                    kill(child.pid);
                }
            };
            const timer = setTimeout(() => killAs('timedOut'), request.timeoutMs);
            const onStop = () => killAs('stopped');
            const settled = () => {
                clearTimeout(timer);
                request.stop?.removeEventListener('abort', onStop);
            };
            if (request.stop?.aborted === true) {
                onStop();
            }
            else {
                request.stop?.addEventListener('abort', onStop, { once: true });
            }
            child.once('error', (error) => {
                settled();
                reject(error);
            });
            child.once('close', (code, signal) => {
                settled();
                resolve(killed === undefined ? endOf(code, signal) : { kind: killed });
            });
        }),
    };
}
