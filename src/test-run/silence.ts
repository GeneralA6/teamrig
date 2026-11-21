import type { Readable } from 'node:stream';
import { DEFAULT_QUEUE } from '../config/defaults.ts';
import { realSleep } from '../core/lock.ts';
import { CpuGate, nodeHostCpu, type CpuLook } from '../delivery/cpu.ts';
import type { HeldProcess, TreeKill } from '../delivery/tree-kill.ts';

/**
 * How a watched run ended: it closed with this code or signal, or printed nothing for `silentMs` and was killed with
 * its tree.
 */
export type SilenceEnd =
  | { readonly kind: 'closed'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'idle'; readonly silentMs: number };

/** Reads whether the host is busy when the run falls silent: a look finding no CPU room means busy. */
export interface SilenceHostCpu {
  look(): Promise<CpuLook>;
}

/**
 * A busy host stretches the silence limit up to this many times (T2700): another step's test run on every core can
 * slow a suite until it prints nothing past the limit and still ends, while a run that truly hangs is still stopped,
 * only later.
 */
export const BUSY_STRETCH = 3;

/**
 * The host counts as busy below the idle CPU share the queue needs to start a second heavy step
 * (`delivery.queue.heavyIdleCpuPct`'s default): the coverage gate runs in CI too, where no team config is read.
 */
export function silenceHostCpu(): SilenceHostCpu {
  return new CpuGate(nodeHostCpu(), realSleep, DEFAULT_QUEUE.heavyIdleCpuPct);
}

/** The running process, as the watch reads and kills it: Node's child process, or a fake in tests. */
export interface WatchedChild extends HeldProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/** Where each chunk the run prints goes as it comes, by the stream it came on. */
export type OnOutput = (stream: 'out' | 'err', chunk: Buffer) => void;

/**
 * Hands on the run's output and kills it with every process it started once it prints nothing for `idleMs` (0: never); settles
 * when the run has closed and any kill is done, so a hung run never holds the host past its silence limit. When the
 * limit passes on a busy host (`cpu` finds no room), the run gets another `idleMs`, up to `BUSY_STRETCH` limits in
 * all; output while the host is read starts the limit again. With `started`, the limit runs only from the first output
 * after which it says yes: a run that waits its turn in the host queue first is timed from when its step starts.
 */
export function watchSilence(
  child: WatchedChild,
  idleMs: number,
  kill: TreeKill,
  onOutput: OnOutput,
  cpu: SilenceHostCpu,
  started: () => boolean = () => true,
): Promise<SilenceEnd> {
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
    // An `idleMs` of 0 never stops the run, and nor does a run not yet started: no timer is set, so only output that
    // starts it, or its own close, moves the watch on.
    let running = started();
    const arm = (): NodeJS.Timeout | undefined => (idleMs > 0 && running ? setTimeout(onIdle, idleMs) : undefined);
    let timer = arm();
    const heard = (): void => {
      running ||= started();
      if (killed === undefined) {
        heardCount += 1;
        silentMs = 0;
        clearTimeout(timer);
        timer = arm();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      onOutput('out', chunk);
      heard();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      onOutput('err', chunk);
      heard();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      void (killed ?? Promise.resolve()).then(() => resolve(killed === undefined ? { kind: 'closed', code, signal } : { kind: 'idle', silentMs }));
    });
  });
}
