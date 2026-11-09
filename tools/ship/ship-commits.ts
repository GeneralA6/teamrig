import { DEFAULT_COMMITS } from '../../src/config/defaults.ts';
import { pathMatcher, weighCommit, type CommitWeight, type FileChange } from '../../src/push-guard/commit-size.ts';
import type { BuildStep } from './build-steps.ts';
import type { GateVerdict } from './local-gate.ts';
import { withRaisedVersion, type Chunk, type ShipArgs } from './ship-plan.ts';
import type { SyncResult } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

/** The folder `npm run build` writes, committed apart from the plan's chunks. */
export const DIST = 'plugins/teamrig/dist';

/** The subject of the commit that holds the rebuilt dist; rerun.ts knows the ship's own dist commit by it. */
export const DIST_SUBJECT = 'build: rebuild the plugin dist';

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

/** What a ship does to the repo dir and the outside world; ship.ts wires the real ones, specs pass fakes. */
export interface ShipDeps {
  /** Runs a command in the repo dir with its output shown; throws when it fails. */
  run: (command: string, args: readonly string[]) => void;
  /** Runs this node binary with `args` in the repo dir, like `run`. */
  node: (args: readonly string[]) => void;
  /** Runs git in the repo dir and returns its stdout; throws when git fails. */
  git: (args: readonly string[]) => string;
  log: (line: string) => void;
  /** Takes back the commits an earlier run of this plan made since `base` (rerun.ts), so the plan commits them again. */
  takeBack: (chunks: readonly Chunk[], base: string) => void;
  /** Rebases onto main when it moved past the branch (sync.ts). */
  sync: () => SyncResult;
  /** The steps of the repo's `npm run build`, read when the build runs (a chunk may change them). */
  buildSteps: () => readonly BuildStep[];
  /** The repo's local gate on the checked-out HEAD (local-gate.ts). */
  proveTree: () => GateVerdict;
  /** Pushes the change branch, never main (push.ts); returns its name. */
  push: () => string;
  /** Merges the pushed branch into main (merge.ts); returns the exit code. */
  merge: (branch: string) => Promise<number>;
}

export interface DistWeight extends CommitWeight {
  /** Over the commit size rule: the dist commit carries a Large-commit line. */
  readonly large: boolean;
}

/** `git diff --numstat` rows → file changes; a binary file's `-` counts are null. */
export function parseNumstat(text: string): FileChange[] {
  return text
    .split('\n')
    .filter((row) => row !== '')
    .map((row) => {
      const [added = '', deleted = '', ...path] = row.split('\t');
      return { path: path.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
}

/** The staged dist's weight under the default commit size rule. */
export function weighDist(files: readonly FileChange[]): DistWeight {
  const weight = weighCommit({ sha: '', subject: '', body: '', files }, pathMatcher(DEFAULT_COMMITS.testPatterns));
  return { ...weight, large: weight.lines > DEFAULT_COMMITS.maxLines || weight.files > DEFAULT_COMMITS.maxFiles };
}

function commit(deps: ShipDeps, files: readonly string[], subject: string, body: string, extra: readonly string[] = []): void {
  deps.run('git', ['add', '--', ...files]);
  deps.run('git', ['commit', '-q', '-s', '-m', subject, '-m', body, ...extra.flatMap((line) => ['-m', line]), '-m', TRAILER]);
}

/**
 * Ships a finished teamrig change from a tested working tree, all in one run so in one host-lock hold when
 * run inside `teamrig queue` (T629: other ships merge while one waits for the lock, so whatever it settled
 * before the wait goes stale):
 *   0. rerun.ts: a rerun takes back the commits its earlier run made (a failed build or gate, or a first run
 *      without --merge for an approval), so the plan's chunks and raise are uncommitted again (T1017);
 *   1. sync.ts: when origin/main moved past the branch, rebase onto it and set the plan's version raise again
 *      on main's version; a conflict stops before any check. On every run the plan's subjects and bodies
 *      follow the version the files set, which a rerun after a failed run finds set already (T1472);
 *   2. typecheck and the coverage gate (stops before any commit when either fails);
 *   3. one signed-off commit per chunk of the plan, in order;
 *   4. the steps of the repo's `npm run build` (build-steps.ts) and a `build: rebuild the plugin dist` commit (with a Large-commit line when the
 *      generated files go over the size rule);
 *   5. the local gate (local-gate.ts) on the new HEAD: every local check repos.json lists for the repo that
 *      steps 2 and 4 did not already run on this content (scrub, DCO, the size rule, dist, docs), then a
 *      pass record for the tree, which merge and the pre-push hook reuse;
 *   6. with --merge: push the change branch (push.ts, never main) and merge it (merge.ts).
 * A refusal throws `REFUSED <reason>`; a failed step throws its own error.
 */
export async function shipCommits(args: ShipArgs, written: readonly Chunk[], deps: ShipDeps): Promise<number> {
  deps.takeBack(written, args.base);
  const chunks = withRaisedVersion(written, TEAMRIG_VERSION_FILES.map((file) => file.path), deps.sync().sets);

  deps.node(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  deps.node(['tools/ci/coverage-cli.ts']);
  for (const chunk of chunks) commit(deps, chunk.files, chunk.subject, chunk.body);

  for (const step of deps.buildSteps()) deps.node(step);
  deps.run('git', ['add', '--', DIST]);
  const files = parseNumstat(deps.git(['diff', '--cached', '--numstat']));
  if (files.length > 0) {
    const weight = weighDist(files);
    deps.log(`dist: ${weight.files} file(s), ${weight.lines} line(s)${weight.large ? ', over the size rule' : ''}`);
    commit(deps, [DIST], DIST_SUBJECT, 'Compiled from the commits above by npm run build.', weight.large ? ['Large-commit: generated by npm run build from the reviewed source'] : []);
  }

  deps.log('\nlocal checks:');
  const verdict = deps.proveTree();
  deps.log(deps.git(['log', '--oneline', `${args.base}..HEAD`]));
  if (!verdict.passed) throw new Error(`REFUSED ${verdict.reason}`);
  if (!args.merge) return 0;

  const branch = deps.push();
  deps.log(`\npushed ${branch}; merging:`);
  return deps.merge(branch);
}
