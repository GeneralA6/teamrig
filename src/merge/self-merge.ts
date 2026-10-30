import type { CommitsConfig } from '../config/types.ts';
import { describeLargeCommits, largeCommits, pathMatcher, renamedPath, type CommitStat } from '../push-guard/commit-size.ts';
import type { PassRecord } from '../push-guard/pass-record.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';

/**
 * The self-merge gates of `teamrig merge` under `pushGuard.pushToProtected: gated` (T800 §2.1, T858), read after
 * the rebase onto the default branch. A session's change merges with no approval when its branch names an active task
 * of the session's, a pass record proves the rebased tree, no commit goes over the size bounds without a reason line,
 * a change of source changes a test too, and the repo's review gate looked at it. The review gate's holds, the queue
 * cutoff and the reset blackout stay the merge command's own steps; a miss here sends the change to a leader's approval instead.
 */

/**
 * The gates a change can miss, in the order they are read: its task, its pass record, its commit sizes, its tests,
 * and the repo's review gate.
 */
export const SELF_MERGE_GATES = ['task', 'pass', 'size', 'tests', 'review'] as const;

export type SelfMergeGate = (typeof SELF_MERGE_GATES)[number];

export function isSelfMergeGate(value: unknown): value is SelfMergeGate {
  return SELF_MERGE_GATES.some((gate) => gate === value);
}

export interface GateMiss {
  readonly gate: SelfMergeGate;
  /** What misses, and what would make it hold. */
  readonly why: string;
}

/** The register's task as the gates read it. */
export type SelfMergeTask = Pick<Task, 'owner' | 'status'>;

/** The rebased change, as the merge command read it. */
export interface SelfMergeChange {
  readonly session: string;
  readonly repo: string;
  /** Whether the repo's review gate looked at the change (`delivery.repos.<name>.reviewGate`). */
  readonly reviewGate: boolean;
  readonly branch: string;
  /** The task the branch names (`taskOfBranch`); undefined when it names none. */
  readonly taskId: string | undefined;
  /** The register's record of `taskId`; undefined when it has none. */
  readonly task: SelfMergeTask | undefined;
  /** The tree the rebased head makes. */
  readonly tree: string;
  /** The pass record of `tree`; undefined when none proves it. */
  readonly pass: PassRecord | undefined;
  /** The commits the change merges. */
  readonly commits: readonly CommitStat[];
}

/** The part of the team's `commits` config the gates read. */
export type SelfMergeRule = Pick<CommitsConfig, 'maxLines' | 'maxFiles' | 'largeCommitTrailer' | 'testPatterns' | 'sourcePatterns'>;

/** A miss names this many source files, then a count of the rest. */
const SOURCES_SHOWN = 3;

function short(sha: string): string {
  return sha.slice(0, 8);
}

function taskMiss(change: SelfMergeChange): GateMiss | undefined {
  const { session, branch, taskId, task } = change;
  if (taskId === undefined) {
    return { gate: 'task', why: `${branch} names no task: name the branch t<n>-… after your task` };
  }
  if (task === undefined) {
    return { gate: 'task', why: `${taskId}, which ${branch} names, is not in the register` };
  }
  if (task.owner !== session) {
    return { gate: 'task', why: `${taskId} is ${task.owner}'s, not ${session}'s` };
  }
  return ACTIVE_STATUSES.includes(task.status) ? undefined : { gate: 'task', why: `${taskId} is ${task.status}` };
}

/** A record from before the rebase proves another tree, so a moved default branch needs the checks run again. */
function passMiss(change: SelfMergeChange): GateMiss | undefined {
  if (change.pass !== undefined) {
    return undefined;
  }
  return { gate: 'pass', why: `no pass record proves the rebased tree ${short(change.tree)}: run the repo's local checks on the rebased branch, then merge again` };
}

function sizeMiss(change: SelfMergeChange, rule: SelfMergeRule): GateMiss | undefined {
  const large = largeCommits(change.commits, rule);
  return large.length === 0 ? undefined : { gate: 'size', why: describeLargeCommits(large, rule) };
}

/** Over the whole change, so a test in another of its commits counts; a file is judged where a rename ends. */
function testsMiss(change: SelfMergeChange, rule: SelfMergeRule): GateMiss | undefined {
  const isTest = pathMatcher(rule.testPatterns);
  const isSource = pathMatcher(rule.sourcePatterns);
  const paths = [...new Set(change.commits.flatMap((commit) => commit.files.map((file) => renamedPath(file.path))))];
  const sources = paths.filter((path) => isSource(path) && !isTest(path));
  if (sources.length === 0 || paths.some(isTest)) {
    return undefined;
  }
  const shown = sources.slice(0, SOURCES_SHOWN);
  const left = sources.length - shown.length;
  const named = [...shown, ...(left > 0 ? [`${left} more`] : [])].join(', ');
  return { gate: 'tests', why: `it changes source (${named}) and no test: add or change the tests that cover it` };
}

/** With no review gate, nothing held the change's review paths for their reviewer, so it is no clean review. */
function reviewMiss(change: SelfMergeChange): GateMiss | undefined {
  return change.reviewGate ? undefined : { gate: 'review', why: `delivery.repos.${change.repo}.reviewGate is off, so no review gate looked at its paths` };
}

/** The gates the change misses, in gate order; none lets it merge with no approval. */
export function selfMergeMisses(change: SelfMergeChange, rule: SelfMergeRule): readonly GateMiss[] {
  return [taskMiss(change), passMiss(change), sizeMiss(change, rule), testsMiss(change, rule), reviewMiss(change)].filter((miss): miss is GateMiss => miss !== undefined);
}

/** The misses as one line, each named by its gate. */
export function missesText(misses: readonly GateMiss[]): string {
  return misses.map((miss) => `${miss.gate}: ${miss.why}`).join('; ');
}
