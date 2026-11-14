import { parentPort } from 'node:worker_threads';
import { isGuardThreadRun, messageOf } from "./guard-thread-messages.js";
/**
 * The guard thread guard-main.ts starts for each guard hook (T2433): it loads the CLI, runs the one `hook <name>` the
 * entry sends, and posts the run's lines and exit code back. The guard runs here, off the entry's thread, so the
 * runner's time limit fires even while a guard is stuck in synchronous work, such as a regex whose time grows faster
 * than its input; on the entry's own thread that work never yielded, and Claude Code's hook timeout let the call
 * through.
 */
async function answer(main, run, post) {
    const entry = {
        out: { stdout: (line) => post({ kind: 'stdout', line }), stderr: (line) => post({ kind: 'stderr', line }) },
        script: run.script,
        readStdin: () => Promise.resolve(run.input),
    };
    try {
        post({ kind: 'answered', code: await main(run.argv, entry) });
    }
    catch (cause) {
        post({ kind: 'crashed', message: messageOf(cause) });
    }
}
/**
 * Serves one run on `port`: loads the CLI's main with `load`, says loaded or load-failed, then answers the one run the
 * entry sends. Exported so a spec drives it on a MessageChannel, where the coverage run sees it.
 */
export async function serveGuard(port, load) {
    const post = (message) => port.postMessage(message);
    let main;
    try {
        main = await load();
    }
    catch (cause) {
        post({ kind: 'load-failed', message: messageOf(cause) });
        return;
    }
    // `once`: the listener holds the thread open until the run arrives, and lets it end once its work drains.
    port.once('message', (value) => {
        if (isGuardThreadRun(value)) {
            void answer(main, value, post);
        }
        else {
            post({ kind: 'crashed', message: 'the guard thread got a run it cannot read' });
        }
    });
    post({ kind: 'loaded' });
}
// Outside a worker there is no entry to answer; guard-thread.ts blocks a thread that ends without loading.
if (parentPort !== null) {
    void serveGuard(parentPort, async () => (await import("./node-main.js")).runWithNode);
}
