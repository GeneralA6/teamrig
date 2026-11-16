import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { GIT_COMMIT_LOG } from '../../src/push-guard/git.ts';
import { runMain } from '../lib/run-main.ts';
import { checkCommitSubjects } from './commit-subjects.ts';
import { revisionsFromGithubEnv, type Revisions } from './github-range.ts';

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
  return checkCommitSubjects(ends, { dir: process.cwd(), commitLog: GIT_COMMIT_LOG, out: (line) => console.log(line) });
}

process.exitCode = await runMain('commit-subjects', main, (line) => console.error(line));
