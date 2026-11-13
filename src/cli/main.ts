import { fileURLToPath } from 'node:url';
import { PROCESS_OUTPUT, ignoreClosedPipe, runWithNode } from './node-main.ts';

ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);

/** The CLI's entry script: the `teamrig` launchers and every hook but the guards (`guard-main.ts`) run it. */
process.exitCode = await runWithNode(process.argv.slice(2), { out: PROCESS_OUTPUT, script: fileURLToPath(import.meta.url) });
