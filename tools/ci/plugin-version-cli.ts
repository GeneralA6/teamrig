import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { revisionsFromGithubEnv, type Revisions } from './github-range.ts';
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
  const ends: Revisions = values.github
    ? await revisionsFromGithubEnv(process.env, (path) => readFile(path, 'utf8'))
    : { base: values.base ?? DEFAULT_BASE, head: 'HEAD' };
  if (ends.base === undefined) {
    console.log('plugin-version: no base commit to compare with (a new branch), nothing to check');
    return EXIT_CLEAN;
  }
  return checkPluginVersions({ base: ends.base, head: ends.head }, { git: createGit(process.cwd()), out: (line) => console.log(line) });
}

process.exitCode = await runMain('plugin-version', main, (line) => console.error(line));
