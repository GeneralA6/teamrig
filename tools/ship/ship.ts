import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildScriptOf, buildSteps } from './build-steps.ts';
import { SHIP_RAN_BEFORE, checkCommand, proveTree, realGateDeps } from './local-gate.ts';
import { mergeCommand } from './merge.ts';
import { pushOwnBranch } from './push.ts';
import { profileFor, readProfiles, slugOf } from './repos.ts';
import { parseShipArgs, readPlan, withPlanVersion } from './ship-plan.ts';
import { syncToMain } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

/**
 * Ships a finished teamrig change from a tested working tree, all in one run so in one host-lock hold when
 * run inside `teamrig heavy` (T629: other ships merge while one waits for the lock, so whatever it settled
 * before the wait goes stale):
 *   1. sync.ts: when origin/main moved past the branch, rebase onto it and set the plan's version raise again
 *      on main's version (the plan's subjects and bodies follow); a conflict stops before any check;
 *   2. typecheck and the coverage gate (stops before any commit when either fails);
 *   3. one signed-off commit per chunk of the plan, in order;
 *   4. the steps of the repo's `npm run build` (build-steps.ts) and a `build: rebuild the plugin dist` commit (with a Large-commit line when the
 *      generated files go over the size rule);
 *   5. the local gate (local-gate.ts) on the new HEAD: every local check repos.json lists for the repo that
 *      steps 2 and 4 did not already run on this content (scrub, DCO, the size rule, dist, docs), then a
 *      pass record for the tree, which merge and the pre-push hook reuse;
 *   6. with --merge: push the change branch (push.ts, never main) and merge it (merge.ts).
 * Usage: node ship.ts <teamrig dir> <plan.json> [base, default origin/main] [--merge [--note-file <path>]]
 * plan.json: { "chunks": [ { "files": ["src/a.ts", ...], "subject": "area: what", "body": "why" } ] }
 *
 * Proves a repo dir's checked-out tree with its local checks (a pass record, else a run that writes one):
 *   node ship.ts check <repo dir>
 * And merges a pushed change branch into main (merge.ts: PR, its head proven by the repo's gate, rebase):
 *   node ship.ts merge <repo dir> [--head <branch>, default the checked-out one] [--timeout-min 45] [--interval-s 30]
 */
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

async function shipCommits(argv: readonly string[]): Promise<number> {
  const args = parseShipArgs(argv);
  const { repo } = args;
  const written = readPlan(args.plan);

  const run = (command: string, runArgs: readonly string[]): void => {
    console.log(`\n$ ${command} ${runArgs.join(' ')}`);
    execFileSync(command, runArgs, { cwd: repo, stdio: 'inherit' });
  };
  const node = (nodeArgs: readonly string[]): void => run(process.execPath, ['--disable-warning=ExperimentalWarning', ...nodeArgs]);
  const git = (gitArgs: readonly string[]): string => execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8' });
  const gitLine = (...gitArgs: string[]): string => git(gitArgs).trim();
  const commit = (files: readonly string[], subject: string, body: string, extra: readonly string[] = []): void => {
    run('git', ['add', '--', ...files]);
    run('git', ['commit', '-q', '-s', '-m', subject, '-m', body, ...extra.flatMap((line) => ['-m', line]), '-m', TRAILER]);
  };
  const profile = profileFor(readProfiles(), slugOf(gitLine('remote', 'get-url', 'origin')));

  const sync = syncToMain(
    {
      git: gitLine,
      readText: (path) => readFileSync(join(repo, path), 'utf8'),
      writeText: (path, text) => writeFileSync(join(repo, path), text),
      log: (line) => console.log(line),
    },
    { main: profile.main, files: TEAMRIG_VERSION_FILES, generated: ['plugins/teamrig/dist'] },
  );
  const chunks = sync.kind === 'rebased' && sync.version !== null ? withPlanVersion(written, sync.version) : written;

  node(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  node(['tools/ci/coverage-cli.ts']);
  for (const chunk of chunks) commit(chunk.files, chunk.subject, chunk.body);

  const src = (path: string): string => pathToFileURL(`${repo}/src/${path}`).href;
  const { weighCommit, testMatcher } = await import(src('push-guard/commit-size.ts'));
  const { DEFAULT_COMMITS } = await import(src('config/defaults.ts'));

  for (const step of buildSteps(buildScriptOf(readFileSync(join(repo, 'package.json'), 'utf8')))) node(step);
  run('git', ['add', '--', 'plugins/teamrig/dist']);
  const files = git(['diff', '--cached', '--numstat'])
    .split('\n')
    .filter((row) => row !== '')
    .map((row) => {
      const [added = '', deleted = '', ...path] = row.split('\t');
      return { path: path.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
  if (files.length > 0) {
    const weight = weighCommit({ sha: '', subject: '', body: '', files }, testMatcher(DEFAULT_COMMITS.testPatterns));
    const large = weight.lines > DEFAULT_COMMITS.maxLines || weight.files > DEFAULT_COMMITS.maxFiles;
    console.log(`dist: ${weight.files} file(s), ${weight.lines} line(s)${large ? ', over the size rule' : ''}`);
    commit(['plugins/teamrig/dist'], 'build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.', large ? ['Large-commit: generated by npm run build from the reviewed source'] : []);
  }

  console.log('\nlocal checks:');
  const verdict = proveTree(repo, profile.local, realGateDeps(repo, (line) => console.log(line)), SHIP_RAN_BEFORE);
  console.log(git(['log', '--oneline', `${args.base}..HEAD`]));
  if (!verdict.passed) throw new Error(`REFUSED ${verdict.reason}`);
  if (!args.merge) return 0;

  const branch = pushOwnBranch(gitLine, profile.main);
  console.log(`\npushed ${branch}; merging:`);
  return mergeCommand([repo, '--head', branch, ...(args.noteFile === null ? [] : ['--note-file', args.noteFile])]);
}

/** The exit code of `ship.ts <teamrig dir> <plan.json> ...`: a refusal or failure is one line, never a stack. */
async function shipCommand(argv: readonly string[]): Promise<number> {
  try {
    return await shipCommits(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const argv = process.argv.slice(2);
if (argv[0] === 'merge') process.exitCode = await mergeCommand(argv.slice(1));
else if (argv[0] === 'check') process.exitCode = checkCommand(argv.slice(1));
else process.exitCode = await shipCommand(argv);
