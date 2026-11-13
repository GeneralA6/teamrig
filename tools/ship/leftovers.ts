import { execFileSync } from 'node:child_process';
import { type Gh, ghWithToken } from './github.ts';
import { arrayOf, isRecord, numberAt, recordAt, stringAt } from './json.ts';
import { type Credential, SHIP_TOKEN_TARGET, readCredential, windowsPowerShell } from './keychain.ts';
import { type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';
import { describeCredential } from './token-check.ts';

/**
 * Remote branches ship cleans up after a change lands, since nothing else does (T1867, T2674):
 * - leftovers, branches whose work is already on main: a branch that fell behind main is rebased and pushed again
 *   under a new name, since a force-push is refused, and the old name stays forever. After a merge, ship deletes
 *   the leftovers of the merged branch's own task and names the rest.
 * - the merged head itself: GitHub's auto-delete is a repo setting a teamrig user may not have on, so after a
 *   merge ship deletes the head while origin still has it at the sha that merged.
 * - the heads of closed pull requests that never merged: GitHub's auto-delete acts only on a merge, and closing a
 *   pull request (`teamrig issue close`) runs on a key with no Contents access. Each such head is deleted while it
 *   is still at the closed pull request's head sha and no pull request on it is open; GitHub keeps a Restore
 *   branch button on the closed pull request, so the delete can be undone.
 * `ship.ts leftovers <repo dir>` deletes the closed heads and lists every other remote branch, leftovers first.
 *
 * A branch's work is on main when each commit main lacks, after dropping the ones a commit on main repeats
 * (`git log --cherry-pick`), is no merge and touches only paths the repo's profile calls regenerated: the
 * built dist and the version files, which every reship writes again on top of the newer main.
 */

/** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
export type Git = (...args: string[]) => string;

export interface LoggedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly files: readonly string[];
}

/** A remote branch, the sha origin has it at, and how many of its commits carry work main lacks (0: a leftover). */
export interface BranchState {
  readonly branch: string;
  readonly sha: string;
  readonly ahead: number;
}

const SHA = /^[0-9a-f]{7,64}$/;

/** The records of `git log --format=%x00%H %P --name-only`: each opens with a NUL, then the sha and parents, then the files. */
export function parseLog(text: string): LoggedCommit[] {
  return text
    .split('\0')
    .filter(record => record.trim() !== '')
    .map(record => {
      const [header = '', ...files] = record.split('\n').map(line => line.trim());
      const [sha = '', ...parents] = header.split(' ').filter(word => word !== '');
      if (!SHA.test(sha) || !parents.every(parent => SHA.test(parent))) throw new Error(`git log: unexpected commit line "${header}"`);
      return { sha, parents, files: files.filter(file => file !== '') };
    });
}

/** A path the profile lists, or one inside a listed folder (a name ending in `/`). */
export function isRegenerated(path: string, regenerated: readonly string[]): boolean {
  return regenerated.some(listed => (listed.endsWith('/') ? path.startsWith(listed) : path === listed));
}

/** The commits that carry work: a merge, or one that touches a path the profile does not call regenerated. */
export function workCommits(commits: readonly LoggedCommit[], regenerated: readonly string[]): LoggedCommit[] {
  return commits.filter(commit => commit.parents.length > 1 || commit.files.some(file => !isRegenerated(file, regenerated)));
}

/** The task a branch is named for (`t1867-reship` → `t1867`), lower case; null for a branch named for none. */
export function taskOf(branch: string): string | null {
  return /^(t\d+)-/i.exec(branch)?.[1]?.toLowerCase() ?? null;
}

/** Every branch on origin but main, with its sha and its work commits counted against main; fetches and prunes first. */
export function readStates(git: Git, main: string, regenerated: readonly string[]): BranchState[] {
  git('fetch', '--quiet', '--prune', 'origin');
  const refs = git('for-each-ref', '--format=%(refname:lstrip=3) %(objectname)', 'refs/remotes/origin/')
    .split('\n')
    .map(line => line.trim().split(' '))
    .map(([branch = '', sha = '']) => ({ branch, sha }))
    .filter(({ branch }) => branch !== '' && branch !== 'HEAD' && branch !== main);
  return refs.map(({ branch, sha }) => {
    const log = git('log', '--right-only', '--cherry-pick', '--format=%x00%H %P', '--name-only', `refs/remotes/origin/${main}...refs/remotes/origin/${branch}`);
    return { branch, sha, ahead: workCommits(parseLog(log), regenerated).length };
  });
}

export interface SweepPlan {
  /** Leftovers of the merged branch's task: ship deletes them. */
  readonly remove: readonly string[];
  /** Leftovers of other tasks, or of no task: left to their owners. */
  readonly leave: readonly string[];
}

/** Which leftovers a merge of `head` deletes: the ones named for its task. `head` itself is never one: settleMergedHead decides it by its sha. */
export function planSweep(head: string, states: readonly BranchState[]): SweepPlan {
  const task = taskOf(head);
  const leftovers = states.filter(state => state.ahead === 0 && state.branch !== head).map(state => state.branch);
  return {
    remove: leftovers.filter(branch => task !== null && taskOf(branch) === task),
    leave: leftovers.filter(branch => task === null || taskOf(branch) !== task),
  };
}

/** A pull request whose head is a branch of the repo owner's account, as GitHub lists it. */
export interface HeadPull {
  readonly number: number;
  readonly open: boolean;
  readonly merged: boolean;
  /** The repo the head branch lives in (`owner/name`); null when that repo was deleted. */
  readonly headRepo: string | null;
  readonly headSha: string;
}

export function parseHeadPull(item: Record<string, unknown>): HeadPull {
  const head = recordAt(item, 'head', 'pull request');
  const repo = head['repo'];
  return {
    number: numberAt(item, 'number', 'pull request'),
    open: stringAt(item, 'state', 'pull request') === 'open',
    merged: typeof item['merged_at'] === 'string',
    headRepo: isRecord(repo) ? stringAt(repo, 'full_name', 'pull request head repo') : null,
    headSha: stringAt(head, 'sha', 'pull request head'),
  };
}

/** The pull requests, open or closed, whose head is `branch` in the repo owner's account; throws when GitHub cannot say. */
export type PullsOf = (branch: string) => HeadPull[];

/** PullsOf through the GitHub API: one call per branch (Pull requests: read). */
export function pullsOfHead(gh: Gh, repo: string): PullsOf {
  const owner = repo.split('/')[0] ?? '';
  return branch => arrayOf(gh(['api', `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`]), 'pull requests').map(parseHeadPull);
}

export type ClosedHead = { readonly kind: 'delete'; readonly pull: number } | { readonly kind: 'moved'; readonly pull: number } | { readonly kind: 'none' };

/**
 * What a branch at `sha` is to the closed-head sweep. `delete`: it is the head, at that very sha, of a closed
 * pull request of `repo` that never merged, and no pull request on it is open. `moved`: it was such a head but
 * was pushed again after the close, so its owner decides. `none`: anything else, an open pull request or a
 * head in another repo (a fork of the same owner) included.
 */
export function closedHeadOf(pulls: readonly HeadPull[], repo: string, sha: string): ClosedHead {
  const closed = pulls.filter(pull => !pull.open && !pull.merged && pull.headRepo === repo);
  const [newest] = closed;
  if (newest === undefined || pulls.some(pull => pull.open)) return { kind: 'none' };
  const exact = closed.find(pull => pull.headSha === sha);
  return exact === undefined ? { kind: 'moved', pull: newest.number } : { kind: 'delete', pull: exact.number };
}

/**
 * Deletes `branch` on origin only while origin still has it at `sha`: the lease makes the check and the
 * delete one step, so a push that lands after the branch was read is never lost.
 */
function deleteAt(git: Git, branch: string, sha: string): void {
  git('push', '--quiet', `--force-with-lease=refs/heads/${branch}:${sha}`, 'origin', `:refs/heads/${branch}`);
}

/** The sha origin has `branch` at, or null when origin has no such branch. */
function remoteSha(git: Git, branch: string): string | null {
  const line = git('ls-remote', 'origin', `refs/heads/${branch}`);
  return line === '' ? null : (line.split(/\s/)[0] ?? null);
}

export interface SweepDeps {
  readonly git: Git;
  readonly pullsOf: PullsOf;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/**
 * Deletes each branch of `states` that is a closed, unmerged pull request's head at its head sha (closedHeadOf)
 * and names each one pushed again since. Returns the branches deleted. A failed delete is a LEFTOVER line; a
 * failed read of GitHub stops the sweep with one line, since it would fail the same way for every branch.
 */
export function sweepClosedHeads(states: readonly BranchState[], repo: string, deps: SweepDeps): Set<string> {
  const deleted = new Set<string>();
  for (const state of states) {
    let closed: ClosedHead;
    try {
      closed = closedHeadOf(deps.pullsOf(state.branch), repo, state.sha);
    } catch (error) {
      deps.err(`LEFTOVER closed-head sweep stopped at ${state.branch}: ${messageOf(error)}`);
      return deleted;
    }
    if (closed.kind === 'moved') deps.out(`LEFTOVER ${state.branch}: the head of #${closed.pull}, closed unmerged, pushed again since; left to its owner`);
    if (closed.kind !== 'delete') continue;
    try {
      deleteAt(deps.git, state.branch, state.sha);
      deleted.add(state.branch);
      deps.out(`deleted ${state.branch}: the head of #${closed.pull}, closed unmerged; Restore branch on the pull request brings it back`);
    } catch (error) {
      deps.err(`LEFTOVER ${state.branch}: the head of #${closed.pull}, closed unmerged, but the delete failed: ${messageOf(error)}`);
    }
  }
  return deleted;
}

/** A head that just merged into `repo`'s main, at the sha the pull request merged. */
export interface MergedHead {
  readonly repo: string;
  readonly head: string;
  readonly sha: string;
}

/**
 * Deletes the merged head while origin still has it at the merged sha, whether or not the repo has GitHub's
 * auto-delete on. Gone already: nothing to say. At another sha (a push after the merge): a LEFTOVER line. A
 * delete that fails because GitHub's own delete won the race is silent too.
 */
export function settleMergedHead({ head, sha }: MergedHead, deps: Pick<SweepDeps, 'git' | 'out' | 'err'>): void {
  try {
    const at = remoteSha(deps.git, head);
    if (at === null) return;
    if (at !== sha) {
      deps.out(`LEFTOVER ${head}: merged at ${sha.slice(0, 7)}, but origin has it at ${at.slice(0, 7)} since; left to its owner`);
      return;
    }
    try {
      deleteAt(deps.git, head, sha);
      deps.out(`deleted ${head}: merged, and origin still had it`);
    } catch (error) {
      if (remoteSha(deps.git, head) !== null) deps.err(`LEFTOVER ${head}: merged, but the delete failed: ${messageOf(error)}`);
    }
  } catch (error) {
    deps.err(`LEFTOVER ${head}: merged, but its check on origin failed: ${messageOf(error)}`);
  }
}

/**
 * After a head merged: deletes the head itself (settleMergedHead), its task's leftovers and every closed
 * head (sweepClosedHeads) on origin, and names every other leftover. A failure here never fails the merge that
 * already landed: each is a `LEFTOVER` line for a hand delete.
 */
export function sweepAfterMerge(merged: MergedHead, profile: RepoProfile, deps: SweepDeps): void {
  settleMergedHead(merged, deps);
  const { head } = merged;
  try {
    const states = readStates(deps.git, profile.main, profile.regenerated);
    const plan = planSweep(head, states);
    for (const branch of plan.remove) {
      try {
        deps.git('push', '--quiet', 'origin', '--delete', branch);
        deps.out(`deleted ${branch}: an earlier push of ${head}'s task, its work is on ${profile.main}`);
      } catch (error) {
        deps.err(`LEFTOVER ${branch}: its work is on ${profile.main}, but the delete failed: ${messageOf(error)}`);
      }
    }
    const closed = sweepClosedHeads(
      states.filter(state => state.branch !== head && !plan.remove.includes(state.branch)),
      merged.repo,
      deps,
    );
    for (const branch of plan.leave.filter(branch => !closed.has(branch))) deps.out(`LEFTOVER ${branch}: its work is on ${profile.main}; not ${head}'s task, so left to its owner`);
  } catch (error) {
    deps.err(`LEFTOVER sweep skipped: ${messageOf(error)}`);
  }
}

/** One line per remote branch, leftovers first; the last line counts them. */
export function leftoverLines(states: readonly BranchState[], main: string): string[] {
  const leftovers = states.filter(state => state.ahead === 0);
  const ahead = states.filter(state => state.ahead > 0);
  return [
    ...leftovers.map(state => `LEFTOVER ${state.branch}: its work is on ${main}`),
    ...ahead.map(state => `${state.branch}: ${state.ahead} commit(s) ${main} lacks`),
    `${states.length} remote branch(es) besides ${main}, ${leftovers.length} leftover(s)`,
  ];
}

export interface LeftoversDeps {
  readonly git: Git;
  readonly profiles: ReadonlyMap<string, RepoProfile>;
  readonly credential: () => Credential;
  readonly ghFor: (token: string) => Gh;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const LEFTOVERS_USAGE = 'usage: ship.ts leftovers <repo dir>';

export function realLeftoversDeps(dir: string): LeftoversDeps {
  return {
    git: (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(),
    profiles: readProfiles(),
    credential: () => readCredential(SHIP_TOKEN_TARGET, windowsPowerShell),
    ghFor: token => ghWithToken(token),
    out: line => console.log(line),
    err: line => console.error(line),
  };
}

/**
 * `ship.ts leftovers <repo dir>`: deletes origin's closed heads (sweepClosedHeads), then lists every other branch
 * against main; a usage, token, git or profile error is one line and exit 1.
 */
export function leftoversCommand(argv: readonly string[], depsFor: (dir: string) => LeftoversDeps = realLeftoversDeps): number {
  const [dir, ...extra] = argv;
  if (dir === undefined || dir.startsWith('--') || extra.length > 0) {
    console.error(LEFTOVERS_USAGE);
    return 1;
  }
  const deps = depsFor(dir);
  try {
    const repo = slugOf(deps.git('remote', 'get-url', 'origin'));
    const profile = profileFor(deps.profiles, repo);
    const credential = deps.credential();
    if (credential.kind !== 'found') {
      deps.err(describeCredential(credential));
      return 1;
    }
    const states = readStates(deps.git, profile.main, profile.regenerated);
    const closed = sweepClosedHeads(states, repo, { git: deps.git, pullsOf: pullsOfHead(deps.ghFor(credential.secret), repo), out: deps.out, err: deps.err });
    for (const line of leftoverLines(states.filter(state => !closed.has(state.branch)), profile.main)) deps.out(line);
    return 0;
  } catch (error) {
    deps.err(messageOf(error));
    return 1;
  }
}
