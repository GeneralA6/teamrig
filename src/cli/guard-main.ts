import { writeSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuard, type GuardHost } from './guard-runner.ts';
import { threadGuardLoad } from './guard-thread.ts';

/**
 * The entry script hooks.json runs each guard hook through (T1818): `guard-main.js hook <name>`. It imports only
 * Node.js, the runner and the thread starter, and loads the CLI on a worker thread inside the runner (T2433), so a CLI
 * module that fails to load, a throw, a hang, synchronous work past the time limit or a wrong answer blocks the call
 * (exit 2) instead of letting it through. Writes are synchronous: the runner may end the process right after one.
 */
const host: GuardHost = {
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

/** `.ts` in a checkout, `.js` in the build: the scripts beside this one carry the same. */
const extension = extname(fileURLToPath(import.meta.url));
/** The CLI's own entry beside this one, which `teamrig open` starts. */
const script = fileURLToPath(new URL(`./main${extension}`, import.meta.url));

void runGuard(process.argv.slice(2), script, threadGuardLoad(new URL(`./guard-worker${extension}`, import.meta.url), process.stdin), host);
