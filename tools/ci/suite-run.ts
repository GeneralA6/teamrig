import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { DEFAULT_QUEUE } from '../../src/config/defaults.ts';
import { realSleep } from '../../src/core/lock.ts';
import { CpuGate, nodeHostCpu, type CpuLook } from '../../src/delivery/cpu.ts';
import { nodeTreeKill, type HeldProcess, type TreeKill } from '../../src/delivery/tree-kill.ts';

/** How the suite run ended: it exited with this status, or printed nothing for `silentMs` and was killed with its tree. */
export type SuiteEnd = { readonly kind: 'exited'; readonly status: number | null } | { readonly kind: 'idle'; readonly silentMs: number };

/** Reads whether the host is busy when the suite falls silent: a look finding no CPU room means busy. */
export interface SuiteHostCpu {
  look(): Promise<CpuLook>;
}

/**
 * A busy host stretches the silence limit up to this many times (T2700): another step's test run on every core can
 * slow this suite until it prints nothing past the limit and still ends, while a run that truly hangs is still
 * stopped, only later.
 */
export const BUSY_STRETCH = 3;

/**
 * The host counts as busy below the idle CPU share the queue needs to start a second heavy step
 * (`delivery.queue.heavyIdleCpuPct`'s default): the gate runs in CI too, where no team config is read.
 */
export function suiteHostCpu(): SuiteHostCpu {
  return new CpuGate(nodeHostCpu(), realSleep, DEFAULT_QUEUE.heavyIdleCpuPct);
}

/** The running suite, as the watch reads and kills it: Node's child process, or a fake in tests. */
export interface SuiteChild extends HeldProcess {
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
 * when the suite has closed and any kill is done, so a hung run never holds the host past its silence limit. When the
 * limit passes on a busy host (`cpu` finds no room), the suite gets another `idleMs`, up to `BUSY_STRETCH` limits in
 * all; output while the host is read starts the limit again.
 */
export function watchSuite(child: SuiteChild, idleMs: number, kill: TreeKill, echo: SuiteEcho, cpu: SuiteHostCpu): Promise<SuiteEnd> {
  return new Promise((resolve, reject) => {
    let killed: Promise<void> | undefined;
    let closed = false;
    let silentMs = 0;
    // Counts each output, so a host reading that output overtook is dropped.
    let heardCount = 0;
    const stop = (): void => {
      killed = kill(child);
    };
    const onIdle = (): void => {
      silentMs += idleMs;
      if (silentMs >= idleMs * BUSY_STRETCH) {
        stop();
        return;
      }
      const silence = heardCount;
      void cpu.look().then(
        (look) => {
          if (closed || silence !== heardCount) {
            return;
          }
          if (look.kind === 'cpu') {
            timer = setTimeout(onIdle, idleMs);
          } else {
            stop();
          }
        },
        // A host that cannot be read leaves the plain limit.
        () => {
          if (!closed && silence === heardCount) {
            stop();
          }
        },
      );
    };
    let timer = setTimeout(onIdle, idleMs);
    const heard = (): void => {
      if (killed === undefined) {
        heardCount += 1;
        silentMs = 0;
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
      closed = true;
      clearTimeout(timer);
      void (killed ?? Promise.resolve()).then(() => resolve(killed === undefined ? { kind: 'exited', status: code } : { kind: 'idle', silentMs }));
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
  cpu: SuiteHostCpu = suiteHostCpu(),
): Promise<SuiteEnd> {
  const child = spawn(request.program, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  return watchSuite(child, request.idleMs, kill, echo, cpu);
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
export function hangFinding(silentMs: number, nodeVersion: string): string {
  const stopped = `the test run printed nothing for ${silentMs / 1000} s and was stopped with every process it started`;
  return hasRunnerHangBug(nodeVersion)
    ? `${stopped}; Node ${nodeVersion}'s test runner can loop forever on a test file's output (nodejs/node#62704): run the gate on Node 24.18 or later`
    : `${stopped}; find the test file that never ends, one the run never reported`;
}
