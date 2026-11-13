import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
import { constants } from 'node:os';
import { lowerStep, NODE_PRIORITIES, STEP_PRIORITY } from "./priority.js";
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
 * How a step starts. On POSIX, `/bin/sh` (the shell Node's `shell: true` runs there) starts under `nice`, so the step
 * runs at `STEP_PRIORITY` from its first instruction: lowered once it has started, it raced its shell, and on Linux,
 * where a nice value is each thread's, the threads its program started before the lowering stayed at normal. `nice`
 * adds to this process's own value, so it adds only what brings the step to `STEP_PRIORITY`, and nothing to a process
 * already running lower. On Windows, the shell is `cmd.exe`, lowered once it has started (its priority class is the
 * whole process's, and the programs it starts after that inherit it).
 */
export function stepLaunchOf(platform, command, ownPriority) {
    if (platform === 'win32') {
        return { file: command, args: [], shell: true, lowerAfter: true };
    }
    const increment = Math.max(0, STEP_PRIORITY - ownPriority);
    return { file: 'nice', args: ['-n', String(increment), '/bin/sh', '-c', command], shell: false, lowerAfter: false };
}
/** This process's own priority; normal when the system will not say. */
function ownPriorityOf(priorities) {
    try {
        return priorities.of(process.pid);
    }
    catch {
        return constants.priority.PRIORITY_NORMAL;
    }
}
/**
 * The real runner: Node's `spawn` in the platform's shell, with inherited stdio, at below-normal priority
 * (`stepLaunchOf`); its time limit or its `stop` kills the tree. A killed step is reported once the kill is done, so
 * the next holder never shares the host with it.
 */
export function nodeStepRunner(platform, kill = nodeTreeKill(platform), priorities = NODE_PRIORITIES) {
    return {
        run: (request) => new Promise((resolve, reject) => {
            const launch = stepLaunchOf(platform, request.command, ownPriorityOf(priorities));
            const child = spawn(launch.file, launch.args, {
                shell: launch.shell,
                cwd: request.cwd,
                env: { ...request.env },
                stdio: 'inherit',
                windowsHide: true,
                detached: platform !== 'win32',
            });
            if (launch.lowerAfter && child.pid !== undefined) {
                lowerStep(priorities, child.pid);
            }
            let killed;
            const killAs = (why) => {
                if (killed !== undefined) {
                    return;
                }
                killed = { why, done: kill(child) };
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
