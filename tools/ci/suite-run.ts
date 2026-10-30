import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { nodeTreeKill, type TreeKill } from '../../src/delivery/tree-kill.ts';

/** How the suite run ended: it exited with this status, or printed nothing for `idleMs` and was killed with its tree. */
export type SuiteEnd = { readonly kind: 'exited'; readonly status: number | null } | { readonly kind: 'idle'; readonly idleMs: number };

/** The running suite, as the watch reads it: Node's child process, or a fake in tests. */
export interface SuiteChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/** Where the suite's output is echoed as it comes. */
export interface SuiteEcho {
  readonly out: NodeJS.WritableStream;
  readonly err: NodeJS.WritableStream;
}

export interface SuiteRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Past this long with no output, the suite is killed with every process it started. */
  readonly idleMs: number;
}

/**
 * Echoes the suite's output and kills it with every process it started once it prints nothing for `idleMs`; settles
 * when the suite has closed and any kill is done, so a hung run never holds the host past its silence limit.
 */
export function watchSuite(child: SuiteChild, idleMs: number, kill: TreeKill, echo: SuiteEcho): Promise<SuiteEnd> {
  return new Promise((resolve, reject) => {
    let killed: Promise<void> | undefined;
    const onIdle = (): void => {
      killed = child.pid === undefined ? Promise.resolve() : kill(child.pid);
    };
    let timer = setTimeout(onIdle, idleMs);
    const heard = (): void => {
      if (killed === undefined) {
        clearTimeout(timer);
        timer = setTimeout(onIdle, idleMs);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      echo.out.write(chunk);
      heard();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      echo.err.write(chunk);
      heard();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      void (killed ?? Promise.resolve()).then(() => resolve(killed === undefined ? { kind: 'exited', status: code } : { kind: 'idle', idleMs }));
    });
  });
}

/**
 * Runs the suite with no shell and no window, its output echoed to this process's; on POSIX it runs as its own process
 * group, so the idle kill ends the group.
 */
export function runSuite(
  request: SuiteRequest,
  platform: NodeJS.Platform = process.platform,
  kill: TreeKill = nodeTreeKill(platform),
  echo: SuiteEcho = { out: process.stdout, err: process.stderr },
): Promise<SuiteEnd> {
  const child = spawn(request.program, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  return watchSuite(child, request.idleMs, kill, echo);
}

/** Per release line, the first minor whose test runner has the fix for nodejs/node#62704; lines not listed are older or newer as a whole. */
const RUNNER_HANG_FIXED_IN: Readonly<Record<number, number>> = { 24: 18, 26: 2 };

/**
 * Whether this Node's test runner can loop forever reading a test file's output: a 64 KB read that ends right after a
 * message header whose size byte is 0xFF misaligns its parser (nodejs/node#62704, fixed in 24.18.0 and 26.2.0, in no 22.x).
 */
export function hasRunnerHangBug(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const fixedIn = RUNNER_HANG_FIXED_IN[major];
  return fixedIn === undefined ? major < 26 : minor < fixedIn;
}

/** The gate's finding for a suite stopped as hung, naming Node's runner bug when this Node has it. */
export function hangFinding(idleMs: number, nodeVersion: string): string {
  const stopped = `the test run printed nothing for ${idleMs / 1000} s and was stopped with every process it started`;
  return hasRunnerHangBug(nodeVersion)
    ? `${stopped}; Node ${nodeVersion}'s test runner can loop forever on a test file's output (nodejs/node#62704): run the gate on Node 24.18 or later`
    : `${stopped}; find the test file that never ends, one the run never reported`;
}
