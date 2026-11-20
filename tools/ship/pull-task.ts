import { openKit, type KitReader } from '../../src/cli/kit.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import type { IssueTarget } from '../../src/issues/host.ts';
import { refTarget } from '../../src/issues/links.ts';
import type { Task } from '../../src/register/fold.ts';
import { LOCAL_REF_PREFIX, priorityText } from '../../src/register/model.ts';
import { JsonlEventLog } from '../../src/register/store.ts';
import { taskOfBranch } from './approval.ts';
import type { Gh } from './github.ts';
import { arrayOf, isRecord, recordOf, stringAt } from './json.ts';

/**
 * What a pull request a ship opens says about its task (T4796, owner order): the title `T<n>: <issue title>`, a
 * `Closes` line for the task's GitHub issue, and the labels the repo has for the task's priority and type and the
 * issue's area. The title is the issue's, the public wording, never the task's own: a task kept off GitHub (a `local: `
 * ref, as every security fix is) may say what its issue would not, so its pull request is titled by its first commit
 * subject and closes nothing. A task with no ref at all opens no pull request (`unlinked`) until its issue is linked.
 * A read or label write GitHub fails is a warning line, never a failed merge.
 */

/** The fields of a branch's task a pull request is dressed from. */
export type PullTask = Pick<Task, 'id' | 'priority' | 'type' | 'ref'>;

/** The register's task of a head branch (`taskOfBranch`), or undefined when the branch names none the register holds. */
export type PullTaskRead = (head: string) => Promise<PullTask | undefined>;

/** `PullTaskRead` from the register of the team `env` names, read as the merge's approval reads it. */
export function pullTaskFrom(env: Env, reader: KitReader): PullTaskRead {
  return async head => {
    const id = taskOfBranch(head);
    const team = env[ENV.team]?.trim();
    if (id === null || team === undefined || team === '') return undefined;
    const kit = await openKit(reader, team);
    const { state } = await new JsonlEventLog(reader.files, kit.paths.events).read();
    return state.tasks.get(id);
  };
}

/** A GitHub issue as a pull request reads it. */
export interface IssueFacts {
  readonly title: string;
  readonly labels: readonly string[];
}

/** What a pull request opens with: its title, the note opening its body (pullBody), its labels, and why it may not open (null when it may). */
export interface PullFace {
  readonly title: string;
  readonly note: string | null;
  readonly labels: readonly string[];
  readonly unlinked: string | null;
}

/** The labels a ship never copies from the issue: its own priority and status, which the task's say again. */
const STALE_LABEL = /^(?:p\d+|blocker|status:.*)$/i;
/** The labels that say what kind of work a pull request is; `task` when the issue has none. */
const KIND_LABELS = new Set(['bug', 'feature', 'task', 'enhancement', 'documentation']);

/** `#n` for an issue of the pull request's own repo, else `owner/name#n`, as a closing keyword takes it. */
export function issueRef(target: IssueTarget, repo: string): string {
  return target.repo.toLowerCase() === repo.toLowerCase() ? `#${target.number}` : `${target.repo}#${target.number}`;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The keywords before an issue ref that say what the pull request does to it: GitHub's closing keywords, and the
 * `Part of` and `Refs` a slice of a larger issue says, which must leave the issue open for the later slices.
 */
const NAMING_KEYWORDS = 'close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\\s+of|refs?';

/**
 * The note with a `Closes` line for the issue appended, unless it already says what it does to that issue: closes,
 * fixes or resolves it, or is `Part of` it or `Refs` it, as a slice whose merge must not close it.
 */
export function withCloses(note: string | null, target: IssueTarget, repo: string): string {
  const refs = [`${target.repo}#${target.number}`, ...(target.repo.toLowerCase() === repo.toLowerCase() ? [`#${target.number}`] : [])];
  const naming = new RegExp(`\\b(?:${NAMING_KEYWORDS}):?\\s+(?:${refs.map(escaped).join('|')})(?!\\d)`, 'i');
  const text = (note ?? '').trim();
  if (naming.test(text)) return text;
  const line = `Closes ${issueRef(target, repo)}`;
  return text === '' ? line : `${text}\n\n${line}`;
}

/** Why a branch whose task links no issue opens no pull request, with the fix. */
export function unlinkedReason(head: string, task: PullTask | undefined): string {
  if (task === undefined) {
    const id = taskOfBranch(head);
    return id === null
      ? `${head} names no task, so its pull request would link no issue: ship it from a task's branch`
      : `the register holds no task ${id}, ${head}'s task, so its pull request would link no issue`;
  }
  return `${task.id} links no GitHub issue, so its pull request would close none: open its issue, then teamrig update ${task.id} --ref gh:<owner/name>#<n> (or --ref "${LOCAL_REF_PREFIX}<why>" for a task kept off GitHub), and ship again`;
}

/** The labels of the task's priority and type and the issue's area, each in the repo's own spelling; a label the repo lacks is left out. */
export function pullLabels(task: PullTask, issue: IssueFacts | null, repoLabels: readonly string[]): string[] {
  const copied = (issue?.labels ?? []).filter(label => !STALE_LABEL.test(label));
  const kinds = task.type === 'bug' ? ['bug'] : copied.some(label => KIND_LABELS.has(label.toLowerCase())) ? [] : ['task'];
  const wanted = [priorityText(task.priority), ...kinds, ...copied];
  const spelled = new Map(repoLabels.map(label => [label.toLowerCase(), label]));
  const labels: string[] = [];
  for (const label of wanted) {
    const name = spelled.get(label.toLowerCase());
    if (name !== undefined && !labels.includes(name)) labels.push(name);
  }
  return labels;
}

/** What `facePull` needs: the pull request's repo, head and commits, the note, and what was read of its task and issue. */
export interface PullFacts {
  readonly repo: string;
  readonly head: string;
  readonly subjects: readonly string[];
  readonly note: string | null;
  readonly task: PullTask | undefined;
  /** The task's issue as GitHub has it; null when it has none or the read failed. */
  readonly issue: IssueFacts | null;
  /** The labels the repo has; empty when the read failed. */
  readonly repoLabels: readonly string[];
}

/** The pull request's face for `facts`. */
export function facePull(facts: PullFacts): PullFace {
  const { repo, head, subjects, note, task, issue } = facts;
  const subject = subjects[0] ?? head;
  if (task === undefined || task.ref === null) return { title: subject, note, labels: [], unlinked: unlinkedReason(head, task) };
  const labels = pullLabels(task, issue, facts.repoLabels);
  const target = refTarget(task);
  if (target === undefined) return { title: subject, note, labels, unlinked: null };
  return { title: issue === null ? `${task.id}: ${subject}` : `${task.id}: ${issue.title}`, note: withCloses(note, target, repo), labels, unlinked: null };
}

/** The title and labels of issue `target`; null with a warning line when GitHub does not answer. */
export function readIssue(gh: Gh, target: IssueTarget, warn: (line: string) => void): IssueFacts | null {
  try {
    const issue = recordOf(gh(['api', `repos/${target.repo}/issues/${target.number}`]), 'issue');
    const labels = issue['labels'];
    return {
      title: stringAt(issue, 'title', 'issue'),
      labels: Array.isArray(labels) ? labels.filter(isRecord).map(label => stringAt(label, 'name', 'issue label')) : [],
    };
  } catch (error) {
    warn(`warning: issue ${target.repo}#${target.number} was not read (${error instanceof Error ? error.message : String(error)}): the pull request takes its first commit's subject and no issue labels`);
    return null;
  }
}

/** The labels `repo` has (the first 100); empty with a warning line when GitHub does not answer. */
export function readRepoLabels(gh: Gh, repo: string, warn: (line: string) => void): string[] {
  try {
    return arrayOf(gh(['api', `repos/${repo}/labels?per_page=100`]), 'labels').map(label => stringAt(label, 'name', 'label'));
  } catch (error) {
    warn(`warning: the labels of ${repo} were not read (${error instanceof Error ? error.message : String(error)}): the pull request gets none`);
    return [];
  }
}

/**
 * Reads what the pull request of `head` needs from GitHub and dresses it. A task with no issue reads nothing; a label
 * is applied only when the repo has it, since adding one it lacks would create it.
 */
export function pullFaceOf(gh: Gh, input: Omit<PullFacts, 'issue' | 'repoLabels'>, warn: (line: string) => void): PullFace {
  const { task } = input;
  if (task === undefined || task.ref === null) return facePull({ ...input, issue: null, repoLabels: [] });
  const target = refTarget(task);
  const issue = target === undefined ? null : readIssue(gh, target, warn);
  const face = facePull({ ...input, issue, repoLabels: readRepoLabels(gh, input.repo, warn) });
  if (target === undefined) warn(`${task.id} is kept off GitHub: its pull request is titled by its first commit and closes no issue`);
  return face;
}

/** Adds `labels` to pull request `number`; a failure is a warning line. */
export function labelPull(gh: Gh, repo: string, number: number, labels: readonly string[], warn: (line: string) => void): void {
  if (labels.length === 0) return;
  try {
    gh(['api', `repos/${repo}/issues/${number}/labels`, '-X', 'POST', ...labels.flatMap(label => ['-f', `labels[]=${label}`])]);
    warn(`labelled pull request #${number}: ${labels.join(', ')}`);
  } catch (error) {
    warn(`warning: pull request #${number} was not labelled ${labels.join(', ')} (${error instanceof Error ? error.message : String(error)}): add them by hand`);
  }
}
