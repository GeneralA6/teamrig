import type { CoordinatorConfig, CoordinatorRepoConfig, RollConfig } from '../config/types.ts';
import { rangeText } from '../coordinator/ledger.ts';
import { rangeInstallTouches } from '../integrate/dependencies.ts';
import { ORIGIN, type IntegrateGit } from '../integrate/git.ts';

/**
 * What a roll would pull for a repository with a roll block: its main checkout's `HEAD..origin/<default branch>` after
 * a fetch, or why a roll must not pull it. `teamrig roll` reads it before and under the host lock, `teamrig deploys`
 * to show what each repository has pushed but not rolled.
 */

export type RollGit = Pick<IntegrateGit, 'checkoutOf' | 'changes' | 'fetch' | 'defaultBranch' | 'sha' | 'commits' | 'isAncestor' | 'changedPaths' | 'fileAt' | 'fastForward' | 'resetTo'>;

/** A repository with a roll block, and where its main checkout is. */
export interface RollRepo {
  readonly name: string;
  readonly config: CoordinatorRepoConfig;
  readonly roll: RollConfig;
  readonly main: string;
}


/** The repositories with a roll block, in config order, each with its main checkout as a place. */
export function rollRepos(coordinator: Pick<CoordinatorConfig, 'repos'>, inTeam: (path: string) => string): RollRepo[] {
  return Object.entries(coordinator.repos).flatMap(([name, config]) => (config.roll === undefined ? [] : [{ name, config, roll: config.roll, main: inTeam(config.mainCheckout) }]));
}

/** A dependency change the roll checks and installs right after the pull, under the host lock. */
export interface DependencyStep {
  /** The package files the range changes in a way that needs an install, as `installTouches` names them. */
  readonly touches: readonly string[];
  /** `dependencyCheck`, run when `dependencyGate` is on; undefined when it is off. */
  readonly check: readonly string[] | undefined;
  /** `roll.dependencyInstall`. */
  readonly install: readonly string[];
}

/** What a roll would pull: the main checkout's HEAD up to origin's default branch, and the commits between. */
export interface Pending {
  readonly head: string;
  readonly target: string;
  readonly commits: readonly string[];
  /** The commits as the ledger names them. */
  readonly range: string;
  /** The dependency change to check and install after the pull; undefined when the range needs no install or nothing is set to run one. */
  readonly deps: DependencyStep | undefined;
}

export type PendingRead =
  | { readonly kind: 'pending'; readonly pending: Pending }
  | { readonly kind: 'none'; readonly head: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export function short(sha: string): string {
  return sha.slice(0, 8);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

type DependencyRead = { readonly kind: 'step'; readonly step: DependencyStep | undefined } | { readonly kind: 'held'; readonly reason: string };

/**
 * What the range's package files need after the pull: nothing, an install (checked first when `dependencyGate` is on)
 * or a hold. The gate holds a dependency change unless `dependencyCheck` and `roll.dependencyInstall` are both set;
 * with the gate off, an install set runs unchecked, and with neither the range rolls as it is.
 */
async function dependencyStep(git: RollGit, repo: RollRepo, head: string, target: string): Promise<DependencyRead> {
  const { name, main, config, roll } = repo;
  const install = roll.dependencyInstall;
  if (!config.dependencyGate && install === undefined) {
    return { kind: 'step', step: undefined };
  }
  const touches = await rangeInstallTouches(git, main, head, target);
  if (touches === undefined) {
    return { kind: 'held', reason: `could not read what ${short(head)}..${short(target)} changes, so the roll cannot tell whether it changes the dependencies` };
  }
  if (touches.length === 0) {
    return { kind: 'step', step: undefined };
  }
  const check = config.dependencyGate ? config.dependencyCheck : undefined;
  if (install !== undefined && (check !== undefined || !config.dependencyGate)) {
    return { kind: 'step', step: { touches, check, install } };
  }
  const unset = [...(check === undefined ? ['dependencyCheck'] : []), ...(install === undefined ? ['roll.dependencyInstall'] : [])].map((key) => `coordinator.repos.${name}.${key}`);
  return {
    kind: 'held',
    reason: `deps changed (${touches.join(', ')}): coordinator.repos.${name}.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; set ${unset.join(' and ')} to roll one, or pull and install by hand`,
  };
}

/** Fetches and reads what a roll would pull now, refusing a main checkout it must not pull into. */
export async function readPending(git: RollGit, repo: RollRepo): Promise<PendingRead> {
  const { main, name } = repo;
  const checkout = git.checkoutOf(main);
  if (checkout === undefined) {
    return { kind: 'refused', reason: `${main} (coordinator.repos.${name}.mainCheckout) is not a git checkout` };
  }
  const fetched = git.fetch(main, ORIGIN);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `git fetch failed in ${main}: ${fetched.reason}` };
  }
  const defaultBranch = git.defaultBranch(main, ORIGIN);
  if (checkout.branch !== defaultBranch) {
    return { kind: 'refused', reason: `the ${name} main checkout ${main} is on ${checkout.branch ?? 'a detached HEAD'}, not ${defaultBranch}` };
  }
  const changes = git.changes(main, false);
  if (changes === undefined) {
    return { kind: 'failed', reason: `git status failed in ${main}` };
  }
  if (changes.length > 0) {
    return { kind: 'refused', reason: `the ${name} main checkout ${main} has ${plural(changes.length, 'uncommitted change')}: a roll pulls only into a clean checkout` };
  }
  const head = git.sha(main, 'HEAD');
  const target = git.sha(main, `origin/${defaultBranch}`);
  if (head === undefined || target === undefined) {
    return { kind: 'failed', reason: head === undefined ? `HEAD names no commit in ${main}` : `origin/${defaultBranch} is missing in ${main} after the fetch` };
  }
  if (head === target) {
    return { kind: 'none', head };
  }
  if (!git.isAncestor(main, head, target)) {
    return { kind: 'refused', reason: `the ${name} main checkout ${main} has commits that are not on origin/${defaultBranch}: a roll only pulls fast-forward` };
  }
  const deps = await dependencyStep(git, repo, head, target);
  if (deps.kind === 'held') {
    return { kind: 'refused', reason: deps.reason };
  }
  const commits = git.commits(main, head, target);
  return { kind: 'pending', pending: { head, target, commits, range: rangeText(commits, target), deps: deps.step } };
}
