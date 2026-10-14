import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { rangeFromGithubEnv } from '../ci/github-range.ts';
import { EXIT_USAGE } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { checkMessageFile, checkRange, type DcoDeps } from './run.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      message: { type: 'string' },
      range: { type: 'string' },
      github: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const readText = (path: string): Promise<string> => readFile(path, 'utf8');
  const deps: DcoDeps = { git: createGit(process.cwd()), readText, out: (line) => console.log(line) };
  if (values.message !== undefined) {
    return checkMessageFile(values.message, deps);
  }
  const range = values.github ? await rangeFromGithubEnv(process.env, readText) : values.range;
  if (range === undefined) {
    console.log('dco: pass --message <file>, --range <revisions> or --github');
    return EXIT_USAGE;
  }
  return checkRange(range, deps);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`dco: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_USAGE;
  },
);
