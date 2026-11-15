import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { DIST_DIR, pullChangesDist, staleDistEntries } from './dist-fresh.ts';
import { forkOfPull, githubEventFromEnv } from './github-range.ts';

/**
 * Fails a dist that `npm run build` changed. With `--github`, a pull request from a fork that leaves the dist as its
 * base has it passes: it is merged as it is, and the release pull request after the merge rebuilds the dist
 * (github-range.ts forkOfPull). A fork's own dist change must still match the build, so no hand-made dist lands.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { github: { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
  const git = createGit(process.cwd());
  const stale = await staleDistEntries(git);
  if (stale.length === 0) {
    console.log(`dist-fresh: ${DIST_DIR} matches the source`);
    return EXIT_CLEAN;
  }
  const fork = values.github ? forkOfPull(await githubEventFromEnv(process.env, (path) => readFile(path, 'utf8'))) : null;
  if (fork !== null && !(await pullChangesDist(git))) {
    console.log(`dist-fresh: ${DIST_DIR} is behind the source, but the pull request from ${fork} leaves it as it is: the release pull request after its merge rebuilds it`);
    return EXIT_CLEAN;
  }
  console.log(`dist-fresh: ${DIST_DIR} is stale; run \`npm run build\` and commit the result:`);
  stale.forEach((line) => console.log(`  ${line}`));
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('dist-fresh', main, (line) => console.error(line));
