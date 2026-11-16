import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { createGit, type Git } from '../lib/git.ts';
import { lowerStep, NODE_PRIORITIES } from '../../src/delivery/priority.ts';
import { runMain } from '../lib/run-main.ts';
import { readProfiles } from '../ship/repos.ts';
import { type CheckScope, pushScope } from './check-scope.ts';
import { DEFAULT_BASE, changedSpecs, localChecks, shortChecks } from './local-checks.ts';
import { type LocalCheck, type Verdict, machineDeps, parsePushUpdates, proveHead, provePush } from './local-gate.ts';

/**
 * The local gate (see local-gate.ts): proves the checked-out tree with every check CI runs, once per tree.
 * `--pre-push` is the pre-push hook: it reads the pushed commits from stdin and proves each one, with the short
 * checks (check-scope.ts) only for a branch of a repo whose repos.json entry says `"mergeChecks": "changed"`.
 * `--short` proves the checkout with the short checks; `ship.ts --merge` runs it so on such a repo (T3414).
 * Nothing skips it: a push with `--no-verify` is not allowed.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      base: { type: 'string', default: DEFAULT_BASE },
      'pre-push': { type: 'boolean', default: false },
      short: { type: 'boolean', default: false },
    },
    strict: true,
    // git passes the pre-push hook the remote's name and URL; the URL names the repo whose switch sets the scope.
    allowPositionals: true,
  });
  // Below normal, as a queued step runs: the pre-push hook and a hand run start the whole suite outside the host
  // queue, and at normal priority they took the CPU from the owner's terminal and from the queued steps (T4064).
  lowerStep(NODE_PRIORITIES, process.pid);
  const git = createGit(process.cwd());
  const root = (await git.text(['rev-parse', '--show-toplevel'])).trim();
  const deps = machineDeps(root, process.env, (line) => console.log(line));
  if (!values['pre-push']) {
    const scope: CheckScope = values.short ? 'short' : 'full';
    return exitOf(await proveHead(await checksOf(scope, values.base, root, git), deps, scope));
  }
  const updates = parsePushUpdates(readFileSync(0, 'utf8'));
  const scope = pushScope(readProfiles(), positionals[1], updates.map((update) => update.remoteRef));
  return exitOf(await provePush(updates, await checksOf(scope, values.base, root, git), deps, scope));
}

/** The checks a proof of the scope runs; a short one names the changed specs it runs. */
async function checksOf(scope: CheckScope, base: string, root: string, git: Git): Promise<readonly LocalCheck[]> {
  if (scope === 'full') return localChecks(base);
  const changed = (await git.text(['diff', '--name-only', '--no-renames', `${base}...HEAD`])).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const specs = changedSpecs(changed, (path) => existsSync(join(root, path)));
  console.log(`short checks: scrub, DCO, typecheck and ${specs.length} changed spec(s) since ${base}; required CI runs the whole suite on the pull request${specs.length === 0 ? '' : `\n  ${specs.join('\n  ')}`}`);
  return shortChecks(base, specs);
}

function exitOf(verdict: Verdict): number {
  if (verdict.passed) return EXIT_CLEAN;
  console.log(`local checks: REFUSED ${verdict.reason}`);
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('local', main, (line) => console.error(line));
