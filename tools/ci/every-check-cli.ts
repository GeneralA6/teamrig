import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runMain } from '../lib/run-main.ts';
import { checkEveryJob, runFromEnv, type RunGh } from './every-check.ts';

const run = promisify(execFile);

/** The GitHub CLI, which reads GH_TOKEN; arguments go by argv, never through a shell. */
const gh: RunGh = async (args) => (await run('gh', [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** Usage: every-check-cli.ts <the name of the job running it>, which is left out of the check. */
process.exitCode = await runMain(
  'every-check',
  async () => {
    const self = process.argv[2];
    if (!self) {
      throw new Error('usage: every-check-cli.ts <the name of the job running it>');
    }
    return checkEveryJob(runFromEnv(process.env), self, gh, (line) => console.log(line));
  },
  (line) => console.error(line),
);
