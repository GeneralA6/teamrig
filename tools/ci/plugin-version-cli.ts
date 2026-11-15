import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { forkOfPull, githubEventFromEnv, revisionsFromGithubEvent, type Revisions } from './github-range.ts';
import { checkPluginVersions } from './plugin-version.ts';

/** The base a local run compares with when `--base` is not given. */
const DEFAULT_BASE = 'origin/main';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      github: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const event = values.github ? await githubEventFromEnv(process.env, (path) => readFile(path, 'utf8')) : null;
  const fork = event === null ? null : forkOfPull(event);
  if (fork !== null) {
    // Merged as it is: the release pull request after its merge raises the version, and its own run of this gate holds it.
    console.log(`plugin-version: a pull request from ${fork}: the release pull request after its merge raises the version, nothing to check`);
    return EXIT_CLEAN;
  }
  const ends: Revisions = event === null ? { base: values.base ?? DEFAULT_BASE, head: 'HEAD' } : revisionsFromGithubEvent(event.name, event.payload, event.headSha);
  if (ends.base === undefined) {
    console.log('plugin-version: no base commit to compare with (a new branch), nothing to check');
    return EXIT_CLEAN;
  }
  return checkPluginVersions({ base: ends.base, head: ends.head }, { git: createGit(process.cwd()), out: (line) => console.log(line) });
}

process.exitCode = await runMain('plugin-version', main, (line) => console.error(line));
