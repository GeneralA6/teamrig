import { Worker } from 'node:worker_threads';
import { isGuardThreadMessage } from "./guard-thread-messages.js";
export function threadGuardLoad(workerScript) {
    return () => new Promise((loaded, loadFailed) => {
        const worker = new Worker(workerScript);
        let run;
        let failure;
        // The first failure decides; it rejects the load, or the run once loaded (a settled promise ignores the other).
        const fail = (cause) => {
            failure ??= { cause };
            loadFailed(failure.cause);
            run?.reject(failure.cause);
        };
        const main = async (argv, entry) => {
            const input = await entry.readStdin();
            return new Promise((resolve, reject) => {
                if (failure !== undefined) {
                    reject(failure.cause);
                    return;
                }
                run = { entry, resolve, reject };
                const ask = { argv: [...argv], script: entry.script, input };
                worker.postMessage(ask);
            });
        };
        worker.on('message', (value) => {
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
        worker.on('exit', (code) => fail(new Error(`its thread ended with exit ${code} before it answered`)));
    });
}
