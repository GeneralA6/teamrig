import { execFileSync } from 'node:child_process';
import { type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';

/**
 * Remote branches whose work is already on main: leftovers. A branch that fell behind main is rebased and
 * pushed again under a new name, since a force-push is refused; GitHub deletes the merged copy, and the old
 * name stays forever (T1867). After a merge, ship deletes the leftovers of the merged branch's own task;
 * `ship.ts leftovers <repo dir>` lists every remote branch, leftovers first named as such, and deletes none.
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

/** A remote branch and how many of its commits carry work main lacks (0: a leftover). */
export interface BranchState {
  readonly branch: string;
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

/** Every branch on origin but main, with its work commits counted against main; fetches and prunes first. */
export function readStates(git: Git, main: string, regenerated: readonly string[]): BranchState[] {
  git('fetch', '--quiet', '--prune', 'origin');
  const branches = git('for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin/')
    .split('\n')
    .map(line => line.trim())
    .filter(branch => branch !== '' && branch !== 'HEAD' && branch !== main);
  return branches.map(branch => {
    const log = git('log', '--right-only', '--cherry-pick', '--format=%x00%H %P', '--name-only', `refs/remotes/origin/${main}...refs/remotes/origin/${branch}`);
    return { branch, ahead: workCommits(parseLog(log), regenerated).length };
  });
}

export interface SweepPlan {
  /** Leftovers of the merged branch's task: ship deletes them. */
  readonly remove: readonly string[];
  /** Leftovers of other tasks, or of no task: left to their owners. */
  readonly leave: readonly string[];
}

/**
 * Which leftovers a merge of `head` deletes: the ones named for its task. `head` itself is never one: GitHub
 * deletes a merged head on its own, and a delete racing that one would fail.
 */
export function planSweep(head: string, states: readonly BranchState[]): SweepPlan {
  const task = taskOf(head);
  const leftovers = states.filter(state => state.ahead === 0 && state.branch !== head).map(state => state.branch);
  return {
    remove: leftovers.filter(branch => task !== null && taskOf(branch) === task),
    leave: leftovers.filter(branch => task === null || taskOf(branch) !== task),
  };
}

export interface SweepDeps {
  readonly git: Git;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/**
 * After `head` merged: deletes its task's leftovers on origin and names every other one. A failure here
 * never fails the merge that already landed: each is a `LEFTOVER` line for a hand delete.
 */
export function sweepAfterMerge(head: string, profile: RepoProfile, deps: SweepDeps): void {
  try {
    const plan = planSweep(head, readStates(deps.git, profile.main, profile.regenerated));
    for (const branch of plan.remove) {
      try {
        deps.git('push', '--quiet', 'origin', '--delete', branch);
        deps.out(`deleted ${branch}: an earlier push of ${head}'s task, its work is on ${profile.main}`);
      } catch (error) {
        deps.err(`LEFTOVER ${branch}: its work is on ${profile.main}, but the delete failed: ${messageOf(error)}`);
      }
    }
    for (const branch of plan.leave) deps.out(`LEFTOVER ${branch}: its work is on ${profile.main}; not ${head}'s task, so left to its owner`);
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
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const LEFTOVERS_USAGE = 'usage: ship.ts leftovers <repo dir>';

export function realLeftoversDeps(dir: string): LeftoversDeps {
  return {
    git: (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(),
    profiles: readProfiles(),
    out: line => console.log(line),
    err: line => console.error(line),
  };
}

/** `ship.ts leftovers <repo dir>`: lists origin's branches against main, deleting none; a usage or git error is one line and exit 1. */
export function leftoversCommand(argv: readonly string[], depsFor: (dir: string) => LeftoversDeps = realLeftoversDeps): number {
  const [dir, ...extra] = argv;
  if (dir === undefined || dir.startsWith('--') || extra.length > 0) {
    console.error(LEFTOVERS_USAGE);
    return 1;
  }
  const deps = depsFor(dir);
  try {
    const profile = profileFor(deps.profiles, slugOf(deps.git('remote', 'get-url', 'origin')));
    for (const line of leftoverLines(readStates(deps.git, profile.main, profile.regenerated), profile.main)) deps.out(line);
    return 0;
  } catch (error) {
    deps.err(messageOf(error));
    return 1;
  }
}
