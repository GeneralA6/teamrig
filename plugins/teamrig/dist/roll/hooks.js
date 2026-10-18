import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nodeTreeKill } from "../coordinator/steps.js";
import { endOf } from "../test-run/shell.js";
/** The real runner: Node's `spawn` with no shell, stdout read line by line, and a timer that kills the tree. */
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
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                if (child.pid !== undefined) {
                    kill(child.pid);
                }
            }, request.timeoutMs);
            const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
            lines.on('line', request.onLine);
            const read = new Promise((done) => lines.once('close', done));
            child.once('error', (error) => {
                clearTimeout(timer);
                settle({ kind: 'notStarted', error: error.message });
            });
            child.once('close', (code, signal) => {
                clearTimeout(timer);
                void read.then(() => settle(timedOut ? { kind: 'timedOut' } : endOf(code, signal)));
            });
        }),
    };
}
