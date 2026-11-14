import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { isGuardThreadMessage, type GuardThreadRun } from './guard-thread-messages.ts';
import type { GuardMain } from './guard-runner.ts';
import type { NodeEntry } from './node-main.ts';

/**
 * The guard entry's side of the guard thread (T2433): `load` starts guard-worker.ts in a worker thread with `input`
 * (the hook's stdin) piped to it, and resolves once the CLI loaded there. The run it returns asks that thread for the
 * one `hook <name>` and relays its lines and exit code. Any way the thread ends without an answer (a load failure, a
 * throw, an exit) rejects, which the runner turns into a block; a thread that never answers is the runner's time limit,
 * which fires because the entry's own thread stays free.
 */

interface PendingRun {
  readonly entry: NodeEntry;
  readonly resolve: (code: number) => void;
  readonly reject: (cause: unknown) => void;
}

export function threadGuardLoad(workerScript: URL, input: Readable): () => Promise<GuardMain> {
  return () =>
    new Promise<GuardMain>((loaded, loadFailed) => {
      const worker = new Worker(workerScript, { stdin: true });
      let run: PendingRun | undefined;
      let failure: { readonly cause: unknown } | undefined;
      // The first failure decides; it rejects the load, or the run once loaded (a settled promise ignores the other).
      const fail = (cause: unknown): void => {
        failure ??= { cause };
        loadFailed(failure.cause);
        run?.reject(failure.cause);
      };
      const main: GuardMain = (argv, entry) =>
        new Promise<number>((resolve, reject) => {
          if (failure !== undefined) {
            reject(failure.cause);
            return;
          }
          run = { entry, resolve, reject };
          const ask: GuardThreadRun = { argv: [...argv], script: entry.script };
          worker.postMessage(ask);
        });
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
      if (worker.stdin === null) {
        fail(new Error('its thread has no stdin to read the hook input from'));
        return;
      }
      input.pipe(worker.stdin);
    });
}
