import { parseArgs } from 'node:util';
import { EXIT_CLEAN, EXIT_USAGE } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { publishRelease } from './publish.ts';

/** Run by the release workflow's publish job, in a checkout of the release's source with the dist built in it. */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      source: { type: 'string' },
      branch: { type: 'string', default: 'release' },
      dist: { type: 'string', default: 'plugins/teamrig/dist' },
      remote: { type: 'string', default: 'origin' },
    },
    strict: true,
    allowPositionals: false,
  });
  const { version, source, branch, dist, remote } = values;
  if (version === undefined || source === undefined) {
    console.log('release: pass --version <MAJOR.MINOR.PATCH> and --source <main commit sha>');
    return EXIT_USAGE;
  }
  await publishRelease(createGit(process.cwd()), { version, source, branch, dist, remote }, (line) => console.log(line));
  return EXIT_CLEAN;
}

process.exitCode = await runMain('release', main, (line) => console.error(line));
