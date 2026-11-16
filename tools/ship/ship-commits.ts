import { DEFAULT_COMMITS } from '../../src/config/defaults.ts';
import { pathMatcher, weighCommit, type CommitWeight, type FileChange } from '../../src/push-guard/commit-size.ts';
import { workChanges, type ClearMerge, type WorkCommit } from './approval.ts';
import { freeBranch } from './branch-names.ts';
import type { BuildStep } from './build-steps.ts';
import type { GateVerdict } from './local-gate.ts';
import type { MainMove, MergeExit } from './merge.ts';
import { isRaiseOnly, withRaiseLast, withRaisedVersion, type Chunk, type ShipArgs } from './ship-plan.ts';
import type { SyncResult } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

/** The folder `npm run build` writes, committed apart from the plan's chunks. */
export const DIST = 'plugins/teamrig/dist';

/** The subject of the commit that holds the rebuilt dist; rerun.ts knows the ship's own dist commit by it. */
export const DIST_SUBJECT = 'build: rebuild the plugin dist';

/** The trailer of every commit a ship or a merge's catch-up makes. */
export const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

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
  /** Merges the pushed branch into main (merge.ts): its exit code, or main's move past the branch, not yet reported. */
  merge: (branch: string) => Promise<MergeExit>;
  /** main's tip on origin, fetched now, when the branch does not contain it; null when it does (sync.ts). */
  mainMove: () => MainMove | null;
  /** Whether the caller may merge the branch at its head on the approval it names (approval.ts, T2788). */
  clearMerge: ClearMerge;
  /** The fingerprint of what `rev` changes over origin's main, regenerated paths apart (approval.ts `changePatch`). */
  patchOf: (rev: string) => string;
  /** The work commits `rev` carries over origin's main, with their patch ids (approval.ts `workCommitsOf`). */
  workOf: (rev: string) => readonly WorkCommit[];
}

/** The approved head a --merge run started from, and the fingerprint of its change, which the push must still carry. */
interface ApprovedChange {
  readonly head: string;
  readonly patch: string;
}

/** How many runs a ship makes in all when main keeps moving past it before it merges (T2696). */
export const SHIP_ATTEMPTS = 3;

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
 *   -. with --merge, before anything changes: approval.ts clears the merge of the branch at its head (its task the
 *      caller's own, and the approval of the caller's leader naming that head, which --approved names too; a root
 *      team's lead clears itself), and fingerprints the change that head carries (T2788); a head that is a rebase of
 *      the approved one, its work commits the same patch for patch, clears on the approved one's approval (T2913);
 *   0. rerun.ts: a rerun takes back the commits its earlier run made (a failed build or gate, or a first run
 *      without --merge for an approval), so the plan's chunks and raise are uncommitted again (T1017);
 *   1. sync.ts: when origin/main moved past the branch, rebase onto it and set the plan's version raise again
 *      on main's version; a conflict stops before any check. On every run the plan's subjects and bodies
 *      follow the version the files set, which a rerun after a failed run finds set already (T1472). A chunk
 *      whose files hold no uncommitted change (a version chunk with no raise) is refused here (T2823);
 *   2. typecheck and the coverage gate (stops before any commit when either fails);
 *   3. one signed-off commit per chunk of the plan, in order, the chunks that commit only version files last;
 *   4. the steps of the repo's `npm run build` (build-steps.ts) and a `build: rebuild the plugin dist` commit (with a Large-commit line when the
 *      generated files go over the size rule);
 *   5. the local gate (local-gate.ts) on the new HEAD: every local check repos.json lists for the repo that
 *      steps 2 and 4 did not already run on this content (scrub, DCO, the size rule, dist, docs), then a
 *      pass record for the tree, which merge and the pre-push hook reuse;
 *   6. without --merge: take back the version raise and the dist commit (leaveForReview), so the head its approver
 *      reviews holds the work alone; the --merge run raises the version and commits the dist once, on the base it lands on.
 *      With --merge: refuse a change that is no longer the approved one, the regenerated version files and dist
 *      apart, then push the change branch (push.ts, never main) and merge it (merge.ts).
 * Another ship can merge while this one runs its checks (heavy steps share the host), and main then moves past
 * the branch. When that move changed no file this change changes, the version files and the dist aside (every
 * run sets those again), the ship renames the branch `<branch>-N` (a pushed branch is never rewritten, the
 * lead's ruling of 11-06) and goes again from step 0, at most SHIP_ATTEMPTS runs in all; the older pushed name
 * is deleted by the merge's sweep (leftovers.ts). A move that changed the same files is refused, naming them.
 * With --merge, local checks that fail on a branch main moved past go again the same way (T2725).
 * A refusal throws `REFUSED <reason>`; a failed step throws its own error.
 */
export async function shipCommits(args: ShipArgs, written: readonly Chunk[], deps: ShipDeps): Promise<number> {
  let stem: string | null = args.merge ? deps.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() : null;
  const approved = stem === null ? null : await clearedChange(args, stem, deps);
  for (let attempt = 1; ; attempt++) {
    const exit = await shipOnce(args, written, deps, approved);
    if (exit.kind === 'done') return exit.code;
    const tip = exit.tip.slice(0, 7);
    if (attempt === SHIP_ATTEMPTS) throw new Error(`REFUSED main moved past the branch ${SHIP_ATTEMPTS} times during this ship, last to ${tip}: ship again`);
    const shared = sharedWithMain(deps, exit.tip);
    if (shared.length > 0) {
      throw new Error(`REFUSED main moved to ${tip} and changed ${shared.join(', ')}, which this change changes too: rebase onto origin/main by hand, then ship again under a new branch name`);
    }
    stem ??= deps.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const next = freeBranch((...gitArgs) => deps.git(gitArgs).trim(), stem);
    deps.run('git', ['branch', '-m', next]);
    deps.log(`\nmain moved to ${tip}, touching no file this change touches: shipping again as ${next}`);
  }
}

/**
 * The approved change a --merge run of `branch` starts from, read before any step changes the branch; null for a
 * root team's lead, whom nobody approves. A refused clearance throws `REFUSED <why>`.
 */
async function clearedChange(args: ShipArgs, branch: string, deps: ShipDeps): Promise<ApprovedChange | null> {
  const head = deps.git(['rev-parse', 'HEAD']).trim();
  const approvedHead = args.approved === null || head.startsWith(args.approved) ? head : rebasedFrom(args.approved, head, deps);
  const clearance = await deps.clearMerge(branch, approvedHead, args.approved);
  if (clearance.kind === 'refused') throw new Error(`REFUSED ${clearance.reason}`);
  if (clearance.kind === 'self') {
    deps.log(`merge of ${branch} ${head.slice(0, 9)}: the caller's own, a root team's lead`);
    return null;
  }
  deps.log(`merge of ${branch} ${approvedHead.slice(0, 9)}: approved by ${clearance.by}`);
  return { head: approvedHead, patch: deps.patchOf(approvedHead) };
}

/**
 * The full sha of `approved` when `head` is a rebase of it: the same work commits, patch for patch, in the same order
 * (T2913). Main moving under an approved branch then needs no new approval, as the ship sets the version files and the
 * dist again; a changed, dropped, added or reordered work commit throws `REFUSED`, naming each.
 */
function rebasedFrom(approved: string, head: string, deps: ShipDeps): string {
  let full: string;
  try {
    full = deps.git(['rev-parse', '--verify', '--quiet', `${approved}^{commit}`]).trim();
  } catch {
    throw new Error(`REFUSED --approved ${approved} is not the branch head ${head.slice(0, 9)}, nor a commit here to compare its work with`);
  }
  const work = deps.workOf(full);
  const changes = workChanges(work, deps.workOf(head));
  if (changes.length > 0) {
    throw new Error(`REFUSED the head ${head.slice(0, 9)} is not the approved ${full.slice(0, 9)} rebased: ${changes.join('; ')}. Ship it without --merge and ask for approval of the new head`);
  }
  deps.log(`head ${head.slice(0, 9)} carries the approved ${full.slice(0, 9)}'s ${work.length} work commit(s), patch for patch`);
  return full;
}

const pathsOf = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

/** The files both the branch and main's move to `tip` changed, but the version files and the dist. */
function sharedWithMain(deps: ShipDeps, tip: string): string[] {
  const from = deps.git(['merge-base', 'HEAD', tip]).trim();
  const changed = (to: string): string[] => pathsOf(deps.git(['diff', '--name-only', '--no-renames', from, to]));
  const ours = new Set(changed('HEAD'));
  const setAgain = new Set(TEAMRIG_VERSION_FILES.map((file) => file.path));
  return changed(tip).filter((path) => ours.has(path) && !setAgain.has(path) && !path.startsWith(`${DIST}/`));
}

/**
 * Refuses a chunk none of whose files holds an uncommitted change, before any check: its commit would fail only after
 * the typecheck and the coverage run, at `nothing to commit`. The usual one is a version chunk with no raise in the
 * tree, as the sync then keeps main's version (T2823).
 */
function refuseEmptyChunks(deps: ShipDeps, chunks: readonly Chunk[], versionPaths: readonly string[]): void {
  for (const chunk of chunks) {
    if (deps.git(['status', '--porcelain', '--', ...chunk.files]).trim() !== '') continue;
    const fix = chunk.files.some((path) => versionPaths.includes(path))
      ? `raise the version in ${versionPaths.join(' and ')}, left uncommitted, then ship again`
      : 'leave its change uncommitted, or take the chunk out of the plan, then ship again';
    throw new Error(`REFUSED the plan's chunk "${chunk.subject}" commits nothing: ${chunk.files.join(', ')} hold no uncommitted change; ${fix}`);
  }
}

/**
 * Takes back the commits of a run without --merge that its approver does not review: the chunks that commit only
 * version files and the dist commit, the newest commits (withRaiseLast), never pushed since this run made them. The
 * raise stays in the working tree, uncommitted, so the --merge run finds its chunk to commit; the dist goes back to
 * the head's, since that run builds it again on the base it lands on.
 */
export function leaveForReview(deps: ShipDeps, raises: readonly Chunk[], distCommitted: boolean): void {
  const count = raises.length + (distCommitted ? 1 : 0);
  if (count === 0) return;
  deps.git(['reset', '-q', '--soft', `HEAD~${count}`]);
  const raised = [...new Set(raises.flatMap((chunk) => chunk.files))];
  if (raised.length > 0) deps.git(['restore', '--staged', '--', ...raised]);
  if (distCommitted) deps.git(['restore', '--source=HEAD', '--staged', '--worktree', '--', DIST]);
  deps.log(`
left for review: the work commits; the version raise is uncommitted and the dist is the head's, as the --merge run commits both`);
}

/** One run of steps 0 to 6. */
async function shipOnce(args: ShipArgs, written: readonly Chunk[], deps: ShipDeps, approved: ApprovedChange | null): Promise<MergeExit> {
  const versionPaths = TEAMRIG_VERSION_FILES.map((file) => file.path);
  deps.takeBack(withRaiseLast(written, versionPaths), args.base);
  const chunks = withRaiseLast(withRaisedVersion(written, versionPaths, deps.sync().sets), versionPaths);
  refuseEmptyChunks(deps, chunks, versionPaths);

  deps.node(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  deps.node(['tools/ci/coverage-cli.ts']);
  for (const chunk of chunks) commit(deps, chunk.files, chunk.subject, chunk.body);

  for (const step of deps.buildSteps()) deps.node(step);
  deps.run('git', ['add', '--', DIST]);
  const files = parseNumstat(deps.git(['diff', '--cached', '--numstat']));
  const distCommitted = files.length > 0;
  if (distCommitted) {
    const weight = weighDist(files);
    deps.log(`dist: ${weight.files} file(s), ${weight.lines} line(s)${weight.large ? ', over the size rule' : ''}`);
    commit(deps, [DIST], DIST_SUBJECT, 'Compiled from the commits above by npm run build.', weight.large ? ['Large-commit: generated by npm run build from the reviewed source'] : []);
  }

  deps.log('\nlocal checks:');
  const verdict = deps.proveTree();
  if (verdict.passed && !args.merge) {
    leaveForReview(deps, chunks.filter((chunk) => isRaiseOnly(chunk, versionPaths)), distCommitted);
    deps.log(deps.git(['log', '--oneline', `${args.base}..HEAD`]));
    return { kind: 'done', code: 0 };
  }
  deps.log(deps.git(['log', '--oneline', `${args.base}..HEAD`]));
  if (!verdict.passed) {
    // The plugin version gate fails once another ship merged the same raise meanwhile (T2725); a run on the moved
    // main sets the raise again, and a failure of the change's own fails that run too.
    const move = args.merge ? deps.mainMove() : null;
    if (move === null) throw new Error(`REFUSED ${verdict.reason}`);
    deps.log(`\nlocal checks: ${verdict.reason}, and ${move.reason}`);
    return { kind: 'moved', ...move };
  }
  if (approved !== null && deps.patchOf('HEAD') !== approved.patch) {
    throw new Error(`REFUSED the change differs from the approved head ${approved.head.slice(0, 9)} outside the version files and dist: ship it without --merge and ask for approval of the new head`);
  }

  const branch = deps.push();
  deps.log(`\npushed ${branch}; merging:`);
  return deps.merge(branch);
}
