import { Worker } from 'node:worker_threads';
import { isGuardThreadMessage, type GuardThreadRun } from './guard-thread-messages.ts';
import type { GuardMain } from './guard-runner.ts';
import type { NodeEntry } from './node-main.ts';

/**
 * The guard entry's side of the guard thread (T2433): `load` starts guard-worker.ts in a worker thread and resolves
 * once the CLI loaded there. The run it returns reads the hook's input from the entry, asks that thread for the one
 * `hook <name>` with it, and relays its lines and exit code. The thread gets the input as text, not a stdin stream: a
 * worker whose stdin stream is never read stays alive, so every guard that answers without reading it (an unknown
 * hook's usage exit) held the process to the time limit. Any way the thread ends without an answer (a load failure, a
 * throw, an exit) rejects, which the runner turns into a block; a thread that never answers is the runner's time limit,
 * which fires because the entry's own thread stays free.
 */

interface PendingRun {
  readonly entry: NodeEntry;
  readonly resolve: (code: number) => void;
  readonly reject: (cause: unknown) => void;
}

export function threadGuardLoad(workerScript: URL): () => Promise<GuardMain> {
  return () =>
    new Promise<GuardMain>((loaded, loadFailed) => {
      const worker = new Worker(workerScript);
      let run: PendingRun | undefined;
      let failure: { readonly cause: unknown } | undefined;
      // The first failure decides; it rejects the load, or the run once loaded (a settled promise ignores the other).
      const fail = (cause: unknown): void => {
        failure ??= { cause };
        loadFailed(failure.cause);
        run?.reject(failure.cause);
      };
      const main: GuardMain = async (argv, entry) => {
        const input = await entry.readStdin();
        return new Promise<number>((resolve, reject) => {
          if (failure !== undefined) {
            reject(failure.cause);
            return;
          }
          run = { entry, resolve, reject };
          const ask: GuardThreadRun = { argv: [...argv], script: entry.script, input };
          worker.postMessage(ask);
        });
      };
      worker.on('message', (value: unknown) => {
        if (!isGuardThreadMessage(value)) {
          fail(new Error('its thread sent a message the entry cannot read'));
          return;
        }
        switch (value.kind) {
          case 'loaded':
            loaded(main);
            return;
          case 'load-failed':
          case 'crashed':
            fail(new Error(value.message));
            return;
          case 'stdout':
            run?.entry.out.stdout(value.line);
            return;
          case 'stderr':
            run?.entry.out.stderr(value.line);
            return;
          case 'answered':
            run?.resolve(value.code);
            return;
        }
      });
      worker.on('error', fail);
      worker.on('exit', (code: number) => fail(new Error(`its thread ended with exit ${code} before it answered`)));
    });
}
