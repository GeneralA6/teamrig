import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildScriptOf, buildSteps } from './build-steps.ts';
import { leftoversCommand } from './leftovers.ts';
import { checkCommand, proveTree, realGateDeps } from './local-gate.ts';
import { mergeCommand } from './merge.ts';
import { pushOwnBranch } from './push.ts';
import { profileFor, readProfiles, slugOf } from './repos.ts';
import { shipCommand } from './ship-command.ts';
import { DIST, type ShipDeps } from './ship-commits.ts';
import { syncToMain } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

/**
 * The ship tool's command line; what each command does lives in its module.
 * Ships a finished teamrig change from a tested working tree (ship-commits.ts):
 *   node ship.ts <teamrig dir> <plan.json> [base, default origin/main] [--merge [--note-file <path>]]
 * plan.json: { "chunks": [ { "files": ["src/a.ts", ...], "subject": "area: what", "body": "why" } ] }
 *
 * Proves a repo dir's checked-out tree with its local checks (a pass record, else a run that writes one):
 *   node ship.ts check <repo dir>
 * And merges a pushed change branch into main (merge.ts: PR, its head proven by the repo's gate, rebase):
 *   node ship.ts merge <repo dir> [--head <branch>, default the checked-out one] [--timeout-min 45] [--interval-s 30]
 * And lists origin's branches whose work is already on main, deleting none (leftovers.ts):
 *   node ship.ts leftovers <repo dir>
 * This file only wires the real git, sync, local gate, push and GitHub merge into those commands; ship.test.ts
 * runs it as its own process.
 */

function realShipDeps(repo: string, noteFile: string | null): ShipDeps {
  const run = (command: string, args: readonly string[]): void => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    execFileSync(command, args, { cwd: repo, stdio: 'inherit' });
  };
  const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const gitLine = (...args: string[]): string => git(args).trim();
  const log = (line: string): void => console.log(line);
  const profile = profileFor(readProfiles(), slugOf(gitLine('remote', 'get-url', 'origin')));
  return {
    run,
    node: (args) => run(process.execPath, ['--disable-warning=ExperimentalWarning', ...args]),
    git,
    log,
    sync: () =>
      syncToMain(
        { git: gitLine, readText: (path) => readFileSync(join(repo, path), 'utf8'), writeText: (path, text) => writeFileSync(join(repo, path), text), log },
        { main: profile.main, files: TEAMRIG_VERSION_FILES, generated: [DIST] },
      ),
    buildSteps: () => buildSteps(buildScriptOf(readFileSync(join(repo, 'package.json'), 'utf8'))),
    proveTree: () => proveTree(repo, profile.local, realGateDeps(repo, log)),
    push: () => pushOwnBranch(gitLine, profile.main),
    merge: (branch) => mergeCommand([repo, '--head', branch, ...(noteFile === null ? [] : ['--note-file', noteFile])]),
  };
}

const argv = process.argv.slice(2);
if (argv[0] === 'merge') process.exitCode = await mergeCommand(argv.slice(1));
else if (argv[0] === 'check') process.exitCode = checkCommand(argv.slice(1));
else if (argv[0] === 'leftovers') process.exitCode = leftoversCommand(argv.slice(1));
else process.exitCode = await shipCommand(argv, realShipDeps, (line) => console.error(line));
