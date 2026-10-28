import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { createGit, type Git } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { DENYLIST_CONFIG_KEY } from '../scrub/run.ts';
import { checkHooks, configureHooks, HOOKS_PATH } from './hooks.ts';

/** `npm run setup` and npm's `prepare`: points git at the repo hooks. Never fails where it cannot (see configureHooks). */
async function configure(git: Git): Promise<number> {
  const report = await configureHooks(git);
  if (report.kind === 'skipped') {
    console.log(`git hooks: ${report.reason}, skipped`);
    return EXIT_CLEAN;
  }
  console.log(`git hooks: core.hooksPath = ${report.hooksPath}`);
  console.log(
    report.denylist === undefined
      ? `private denylist: not configured (optional): git config --local ${DENYLIST_CONFIG_KEY} <path>`
      : `private denylist: ${report.denylist}`,
  );
  return EXIT_CLEAN;
}

/** `--check`, first in `npm run check`: fails a clone whose git does not run the repo hooks. */
async function check(git: Git): Promise<number> {
  const report = await checkHooks(git);
  if (report.kind === 'skipped') {
    console.log(`git hooks: ${report.reason}, skipped`);
    return EXIT_CLEAN;
  }
  if (report.kind === 'set') {
    console.log(`git hooks: core.hooksPath = ${HOOKS_PATH}`);
    return EXIT_CLEAN;
  }
  const now = report.hooksPath === undefined ? 'is not set' : `is ${report.hooksPath}`;
  console.log(
    `git hooks: core.hooksPath ${now}, not ${HOOKS_PATH}, so commits and pushes skip the scrub, sign-off and local gate; ` +
      'run `npm run setup`',
  );
  return EXIT_FINDINGS;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const git = createGit(process.cwd());
  if (args.length === 0) {
    return configure(git);
  }
  if (args.length === 1 && args[0] === '--check') {
    return check(git);
  }
  throw new Error(`unknown arguments: ${args.join(' ')} (usage: cli.ts [--check])`);
}

process.exitCode = await runMain('setup', main, (line) => console.error(line));
