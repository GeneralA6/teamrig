import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { gitSyncIn } from '../lib/git.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { holdsStamps, markersIn, stampText, strayStamps } from './stamp.ts';
import { MANIFEST, releaseTarget } from './target.ts';

/**
 * `stamp-cli.ts`: run by the release workflow on the release pull request's branch, sets each release stamp still to
 * set (stamp.ts) to the version its plugin.json holds, and prints how many it set in which files. `--check`: writes
 * nothing, and fails on a stamp in a file the release never stamps. `--root <folder>`: the checkout (specs).
 */
async function main(): Promise<number> {
  const { root, rest } = takeRoot(process.argv.slice(2));
  const check = rest.includes('--check');
  if (rest.some((arg) => arg !== '--check')) {
    console.error('usage: stamp-cli.ts [--check] [--root <folder>]');
    return EXIT_USAGE;
  }
  const tracked = gitSyncIn(root)(['ls-files', '-z']).split('\0').filter((path) => path !== '');
  if (check) {
    const files = new Map(tracked.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
    const stray = strayStamps(files);
    if (stray.length === 0) {
      console.log('stamps: every release stamp sits in a file the release sets it in');
      return EXIT_CLEAN;
    }
    console.log('stamps: no release sets these, as it stamps only the migrations, docs, guide and config schema:');
    stray.forEach(({ path, count }) => console.log(`  ${path}: ${count}`));
    return EXIT_FINDINGS;
  }
  const { version } = releaseTarget(readFileSync(join(root, MANIFEST), 'utf8'), gitSyncIn(root)(['rev-parse', 'HEAD']).trim(), '');
  let total = 0;
  for (const path of tracked.filter(holdsStamps)) {
    const text = readFileSync(join(root, path), 'utf8');
    const count = markersIn(text);
    if (count > 0) {
      writeFileSync(join(root, path), stampText(text, version));
      console.log(`  ${path}: ${count}`);
      total += count;
    }
  }
  console.log(`stamps: set ${total} to ${version}`);
  return EXIT_CLEAN;
}

process.exitCode = await runMain('stamps', main, (line) => console.error(line));
