import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NOT_STARTED_EXIT } from "../coordinator/recorded-step.js";
import { exitCodeOf } from "../coordinator/steps.js";
import { nodeTreeKill } from "../coordinator/tree-kill.js";
import { endOf } from "../test-run/shell.js";
/** True when the hook exited 0. */
export function succeeded(end) {
    return end.kind === 'exited' && end.code === 0;
}
/** The exit code a hook's end is recorded as: its own, 124 at its time limit, 129 when its stop killed it, 1 when a signal stopped it or it did not start. */
export function hookExitCode(end) {
    return end.kind === 'notStarted' ? NOT_STARTED_EXIT : exitCodeOf(end);
}
/** How the hook ended, as a refusal or a ledger note says it: `exited 3`, `could not start (ENOENT)`. */
export function hookEndText(end) {
    switch (end.kind) {
        case 'exited':
            return `exited ${end.code}`;
        case 'signal':
            return `was stopped by ${end.signal}`;
        case 'timedOut':
            return 'was killed at its time limit';
        case 'stopped':
            return 'was killed when its launching shell ended';
        case 'notStarted':
            return `could not start (${end.error})`;
    }
}
/**
 * The real runner: Node's `spawn` with no shell, stdout read line by line; its time limit or its `stop` kills the
 * tree. A killed hook is reported once the kill is done.
 */
export function nodeHookRunner(platform, kill = nodeTreeKill(platform)) {
    return {
        run: (request) => new Promise((resolve) => {
            const [program, ...args] = request.argv;
            if (program === undefined) {
                resolve({ kind: 'notStarted', error: 'no program to run' });
                return;
            }
            let settled = false;
            const settle = (end) => {
                if (!settled) {
                    settled = true;
                    resolve(end);
                }
            };
            const child = spawn(program, args, {
                shell: false,
                cwd: request.cwd,
                env: { ...request.env },
                stdio: ['ignore', 'pipe', 'inherit'],
                windowsHide: true,
                detached: platform !== 'win32',
            });
            let killed;
            const killAs = (why) => {
                if (killed !== undefined) {
                    return;
                }
                killed = { why, done: child.pid === undefined ? Promise.resolve() : kill(child.pid) };
            };
            const timer = setTimeout(() => killAs('timedOut'), request.timeoutMs);
            const onStop = () => killAs('stopped');
            const ended = () => {
                clearTimeout(timer);
                request.stop?.removeEventListener('abort', onStop);
            };
            if (request.stop?.aborted === true) {
                onStop();
            }
            else {
                request.stop?.addEventListener('abort', onStop, { once: true });
            }
            const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
            lines.on('line', request.onLine);
            const read = new Promise((done) => lines.once('close', done));
            child.once('error', (error) => {
                ended();
                settle({ kind: 'notStarted', error: error.message });
            });
            child.once('close', (code, signal) => {
                ended();
                const stopping = killed;
                void Promise.all([read, stopping?.done]).then(() => settle(stopping === undefined ? endOf(code, signal) : { kind: stopping.why }));
            });
        }),
    };
}
