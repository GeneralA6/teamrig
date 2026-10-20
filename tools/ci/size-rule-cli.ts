import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_COMMITS } from '../../src/config/defaults.ts';
import { GIT_COMMIT_LOG } from '../../src/push-guard/git.ts';
import { runMain } from '../lib/run-main.ts';
import { revisionsFromGithubEnv, type Revisions } from './github-range.ts';
import { checkCommitSizes } from './size-rule.ts';

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
  return checkCommitSizes(ends, { dir: process.cwd(), commitLog: GIT_COMMIT_LOG, rule: DEFAULT_COMMITS, out: (line) => console.log(line) });
}

process.exitCode = await runMain('size-rule', main, (line) => console.error(line));
