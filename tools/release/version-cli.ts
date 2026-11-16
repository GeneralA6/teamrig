import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { MANIFEST, outputLines, releaseTarget } from './target.ts';

/** Run by the release workflow's build job in the checkout it builds: prints the release's version and commit. */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { expect: { type: 'string', default: '' } },
    strict: true,
    allowPositionals: false,
  });
  const sha = (await createGit(process.cwd()).text(['rev-parse', 'HEAD'])).trim();
  process.stdout.write(outputLines(releaseTarget(readFileSync(join(process.cwd(), MANIFEST), 'utf8'), sha, values.expect)));
  return EXIT_CLEAN;
}

process.exitCode = await runMain('release', main, (line) => console.error(line));
