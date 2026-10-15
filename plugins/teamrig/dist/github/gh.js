import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
/**
 * The `gh` commands teamrig may run: reads only. The import never writes to GitHub (no issue, label,
 * comment or assignee change), so the runner refuses any other command line before it starts.
 */
export const READ_COMMANDS = [['issue', 'list']];
/** True when the arguments start with one of READ_COMMANDS. */
export function isReadCommand(args) {
    return READ_COMMANDS.some(([group, verb]) => args[0] === group && args[1] === verb);
}
/** How long one `gh` run may take before it is stopped: a list of a few hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;
/** A command line the runner will not start, because it is not a read. */
export class GhNotReadError extends Error {
    name = 'GhNotReadError';
    constructor(args) {
        super(`teamrig only reads GitHub: it does not run gh ${args.slice(0, 2).join(' ')}`);
    }
}
/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading = [], timeoutMs = GH_TIMEOUT_MS) {
    return {
        run: (request) => {
            if (!isReadCommand(request.args)) {
                return Promise.reject(new GhNotReadError(request.args));
            }
            return new Promise((resolve, reject) => {
                const child = spawn(program, [...leading, ...request.args], {
                    env: { ...request.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: timeoutMs,
                    windowsHide: true,
                });
                const stdout = [];
                const stderr = [];
                child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
                child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
                child.once('error', reject);
                child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
            });
        },
    };
}
