import { spawn } from 'node:child_process';
import { endOf } from "./shell-end.js";
/** The real runner: `spawn` with no shell, stdin closed, and the caller's time limit. */
export function nodeProgramRunner(timeoutMs) {
    return (request) => new Promise((resolve, reject) => {
        const env = request.env === undefined ? {} : { env: request.env };
        const child = spawn(request.program, [...request.args], { ...env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
        const stdout = [];
        const stderr = [];
        child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
    });
}
