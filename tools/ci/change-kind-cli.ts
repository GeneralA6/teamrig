import { appendFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { classifyChange, describeChange, testSystems } from './change-kind.ts';
import { revisionsFromGithubEnv, type Revisions } from './github-range.ts';
import { DEFAULT_BASE } from './local-checks.ts';

/**
 * Prints the kind of the change (change-kind.ts): with `--github`, the CI run's from its event, written as `kind=<kind>`
 * and `systems=<JSON list of test runners>` to the step output file GITHUB_OUTPUT names, for ci.yml's later jobs to
 * read; else `--base` (origin/main)...HEAD's.
 */
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
  const output = process.env['GITHUB_OUTPUT'];
  if (values.github && !output) throw new Error('--github needs GITHUB_OUTPUT, the step output file');
  const report = await classifyChange(createGit(process.cwd()), ends);
  console.log(describeChange(report, ends));
  if (values.github && output) await appendFile(output, `kind=${report.kind}\nsystems=${JSON.stringify(testSystems(report.kind))}\n`);
  return EXIT_CLEAN;
}

process.exitCode = await runMain('change-kind', main, (line) => console.error(line));
