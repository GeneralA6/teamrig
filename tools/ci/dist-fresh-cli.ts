import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { DIST_DIR, staleDistEntries } from './dist-fresh.ts';

async function main(): Promise<number> {
  const stale = await staleDistEntries(createGit(process.cwd()));
  if (stale.length === 0) {
    console.log(`dist-fresh: ${DIST_DIR} matches the source`);
    return EXIT_CLEAN;
  }
  console.log(`dist-fresh: ${DIST_DIR} is stale; run \`npm run build\` and commit the result:`);
  stale.forEach((line) => console.log(`  ${line}`));
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('dist-fresh', main, (line) => console.error(line));
