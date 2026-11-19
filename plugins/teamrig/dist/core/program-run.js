import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
/** The real runner: `spawn` with no shell, stdin closed, and a time limit, which each caller sets for its own tool. */
export function nodeProgramRunner(timeoutMs) {
    return (request) => new Promise((resolve, reject) => {
        const child = spawn(request.program, [...request.args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
        const stdout = [];
        const stderr = [];
        child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
    });
}
