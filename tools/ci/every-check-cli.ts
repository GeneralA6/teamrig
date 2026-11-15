import { runMain } from '../lib/run-main.ts';
import { checkEveryJob, ghCli, runFromEnv } from './every-check.ts';

/** Usage: every-check-cli.ts <the name of the job running it>, which is left out of the check. */
process.exitCode = await runMain(
  'every-check',
  async () => {
    const self = process.argv[2];
    if (!self) {
      throw new Error('usage: every-check-cli.ts <the name of the job running it>');
    }
    return checkEveryJob(runFromEnv(process.env), self, ghCli(), console.log);
  },
  console.error,
);
