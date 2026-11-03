import { writeSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuard } from "./guard-runner.js";
/**
 * The entry script hooks.json runs each guard hook through (T1818): `guard-main.js hook <name>`. It imports only
 * Node.js and the runner, and loads the CLI inside the runner, so a CLI module that fails to load, a throw, a hang or a
 * wrong answer blocks the call (exit 2) instead of letting it through. Writes are synchronous: the runner may end the
 * process right after one.
 */
const host = {
    onFatal: (listener) => {
        process.on('uncaughtException', listener);
        process.on('unhandledRejection', listener);
    },
    startLimit: (ms, fire) => {
        const timer = setTimeout(fire, ms);
        return { release: () => timer.unref() };
    },
    write: (text) => writeSync(1, text),
    writeError: (text) => writeSync(2, text),
    exit: (code) => process.exit(code),
    setExitCode: (code) => {
        process.exitCode = code;
    },
};
/** The CLI's own entry beside this one (`main.ts` in a checkout, `main.js` in the build), which `teamrig open` starts. */
const script = fileURLToPath(new URL(`./main${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
void runGuard(process.argv.slice(2), script, async () => (await import("./node-main.js")).runWithNode, host);
