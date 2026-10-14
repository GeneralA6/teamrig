import { createGit } from '../lib/git.ts';
import { DENYLIST_CONFIG_KEY } from '../scrub/run.ts';
import { configureHooks } from './hooks.ts';

const report = await configureHooks(createGit(process.cwd()));
console.log(`git hooks: core.hooksPath = ${report.hooksPath}`);
console.log(
  report.denylist === undefined
    ? `private denylist: not configured (optional): git config --local ${DENYLIST_CONFIG_KEY} <path>`
    : `private denylist: ${report.denylist}`,
);
