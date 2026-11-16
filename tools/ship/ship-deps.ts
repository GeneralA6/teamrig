import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from '../../src/core/files.ts';
import { gitSyncIn } from '../lib/git.ts';
import { realSleep, systemClock } from '../../src/core/lock.ts';
import { changePatch, clearMergeFrom, shipWritesOf, workCommitsOf } from './approval.ts';
import { buildScriptOf, buildSteps } from './build-steps.ts';
import { proveTree, realGateDeps } from './local-gate.ts';
import { mergeBranch } from './merge.ts';
import { pushOwnBranch } from './push.ts';
import { profileFor, readProfiles, slugOf } from './repos.ts';
import { takeBackEarlierRun } from './rerun.ts';
import { DIST, type ShipDeps } from './ship-commits.ts';
import { mainMovedPast, syncToMain } from './sync.ts';
import { TEAMRIG_RELEASE_STAMPS, TEAMRIG_VERSION_FILES } from './version-bump.ts';

/**
 * The real git, sync, local gate, push and GitHub merge a ship of `repo` runs (ship-commits.ts), its profile read from
 * repos.json by the repo's origin. Each piece is tested in its own module; ship-deps.test.ts runs the ones that stay
 * inside a temp repo.
 */
export function realShipDeps(repo: string, noteFile: string | null): ShipDeps {
  const run = (command: string, args: readonly string[]): void => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    execFileSync(command, args, { cwd: repo, stdio: 'inherit' });
  };
  const git = gitSyncIn(repo);
  const gitLine = (...args: string[]): string => git(args).trim();
  const log = (line: string): void => console.log(line);
  const profile = profileFor(readProfiles(), slugOf(gitLine('remote', 'get-url', 'origin')));
  return {
    run,
    node: (args) => run(process.execPath, ['--disable-warning=ExperimentalWarning', ...args]),
    git,
    log,
    takeBack: (chunks, base) => {
      takeBackEarlierRun({ git: gitLine, log }, chunks, base);
    },
    sync: () =>
      syncToMain(
        { git: gitLine, readText: (path) => readFileSync(join(repo, path), 'utf8'), writeText: (path, text) => writeFileSync(join(repo, path), text), log },
        { main: profile.main, files: TEAMRIG_VERSION_FILES, generated: [DIST] },
      ),
    buildSteps: () => buildSteps(buildScriptOf(readFileSync(join(repo, 'package.json'), 'utf8'))),
    proveTree: (scope) => proveTree(repo, profile.local, realGateDeps(repo, log), scope),
    mergeChecks: profile.mergeChecks,
    push: () => pushOwnBranch(gitLine, profile.main),
    merge: (branch) => mergeBranch([repo, '--head', branch, ...(noteFile === null ? [] : ['--note-file', noteFile])]),
    mainMove: () => mainMovedPast(gitLine, profile.main),
    clearMerge: clearMergeFrom(process.env, { env: process.env, userHome: homedir(), files: nodeFiles(realSleep), clock: systemClock }),
    patchOf: (rev) => changePatch(git, rev, `refs/remotes/origin/${profile.main}`, shipWritesOf(profile.regenerated, TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS)),
    workOf: (rev) => workCommitsOf(git, rev, `refs/remotes/origin/${profile.main}`, shipWritesOf(profile.regenerated, TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS)),
  };
}
