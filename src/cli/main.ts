import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { ignoreClosedPipe, processOutput, runWithNode } from './node-main.ts';

const stdoutClosed = ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);

/** The CLI's entry script: the `teamrig` launchers and every hook but the guards (`guard-main.ts`) run it. */
process.exitCode = await runWithNode(process.argv.slice(2), {
  out: processOutput(stdoutClosed),
  script: fileURLToPath(import.meta.url),
  readStdin: () => text(process.stdin),
});
