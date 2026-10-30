import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
import { lowerStep, NODE_PRIORITIES } from "./priority.js";
import { nodeTreeKill } from "./tree-kill.js";
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
 * The real runner: Node's `spawn` in the platform's shell, with inherited stdio, lowered to below-normal priority as
 * it starts, before its shell starts anything; its time limit or its `stop` kills the tree. A killed step is reported
 * once the kill is done, so the next holder never shares the host with it.
 */
export function nodeStepRunner(platform, kill = nodeTreeKill(platform), priorities = NODE_PRIORITIES) {
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
            if (child.pid !== undefined) {
                lowerStep(priorities, child.pid);
            }
            let killed;
            const killAs = (why) => {
                if (killed !== undefined) {
                    return;
                }
                killed = { why, done: child.pid === undefined ? Promise.resolve() : kill(child.pid) };
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
                if (killed === undefined) {
                    resolve(endOf(code, signal));
                }
                else {
                    const { why, done } = killed;
                    void done.then(() => resolve({ kind: why }));
                }
            });
        }),
    };
}
