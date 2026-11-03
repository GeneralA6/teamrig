import { fileURLToPath } from 'node:url';
import { PROCESS_OUTPUT, runWithNode } from "./node-main.js";
/** The CLI's entry script: the `teamrig` launchers and every hook but the guards (`guard-main.ts`) run it. */
process.exitCode = await runWithNode(process.argv.slice(2), { out: PROCESS_OUTPUT, script: fileURLToPath(import.meta.url) });
