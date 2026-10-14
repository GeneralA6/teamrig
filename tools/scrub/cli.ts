import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { rangeFromGithubEnv } from '../ci/github-range.ts';
import { EXIT_USAGE } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runScrub } from './run.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      staged: { type: 'boolean', default: false },
      tree: { type: 'boolean', default: false },
      message: { type: 'string' },
      range: { type: 'string' },
      github: { type: 'boolean', default: false },
      denylist: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const range = values.github
    ? await rangeFromGithubEnv(process.env, (path) => readFile(path, 'utf8'))
    : values.range;
  return runScrub(
    {
      staged: values.staged,
      tree: values.tree,
      messageFile: values.message,
      range,
      denylistPath: values.denylist,
    },
    { git: createGit(process.cwd()), readFile: (path) => readFile(path), out: (line) => console.log(line) },
  );
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`scrub: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_USAGE;
  },
);
