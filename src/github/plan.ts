import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import { GITHUB_SOURCE } from '../register/model.ts';
import type { ImportChanges, ImportInput, StatusInput } from '../register/policy.ts';
import type { GithubIssue } from './issues.ts';
import { issueTask, type ImportRules, type IssueTask } from './map.ts';

/** How GitHub closed an issue, in the note the sync writes; any other reason is left out. */
const CLOSE_REASONS: ReadonlyMap<string, string> = new Map([
  ['COMPLETED', 'completed'],
  ['NOT_PLANNED', 'not planned'],
  ['DUPLICATE', 'a duplicate'],
]);

/** One write of a sync, judged again under the register's lock when it runs (register.ts). */
export type SyncStep =
  | { readonly kind: 'add'; readonly ref: string; readonly input: ImportInput }
  | { readonly kind: 'update'; readonly ref: string; readonly id: string; readonly changes: ImportChanges; readonly note: string }
  | { readonly kind: 'status'; readonly ref: string; readonly id: string; readonly input: StatusInput };

/** What a sync would write, and how many issues it would add, change or leave as they are. */
export interface SyncPlan {
  readonly steps: readonly SyncStep[];
  readonly inserted: number;
  readonly changed: number;
  readonly unchanged: number;
}

/**
 * Each issue once, as last read: the closed list is read after the open one, so an issue on both lists
 * (closed between the two reads) counts as closed.
 */
export function latestIssues(open: readonly GithubIssue[], closed: readonly GithubIssue[]): GithubIssue[] {
  return [...new Map([...open, ...closed].map((issue) => [issue.number, issue])).values()];
}

/** The register's GitHub tasks by ref. Only the import adds them, one per ref (policy.ts). */
export function importedTasks(tasks: Iterable<Task>): Map<string, Task> {
  const byRef = new Map<string, Task>();
  for (const task of tasks) {
    if (task.source === GITHUB_SOURCE && task.ref !== null && !byRef.has(task.ref)) {
      byRef.set(task.ref, task);
    }
  }
  return byRef;
}

/**
 * The writes that bring the register in step with a repository's issues. An open issue with no task is
 * added; a closed one with no task is not, as there is nothing left to do. On a task the import added,
 * only the title, the description, the priority and whether it is open follow GitHub: any active status
 * stands for an open issue, and its owner, notes and plans stay the team's.
 */
export function planSync(issues: readonly GithubIssue[], imported: ReadonlyMap<string, Task>, rules: ImportRules): SyncPlan {
  const perIssue = issues.map((issue) => issueSteps(issue, imported, rules));
  const count = (known: boolean, writes: boolean): number => perIssue.filter((one) => one.known === known && (one.steps.length > 0) === writes).length;
  return { steps: perIssue.flatMap((one) => one.steps), inserted: count(false, true), changed: count(true, true), unchanged: count(true, false) };
}

/** An issue's writes, and whether the register already has its task. */
interface IssueSteps {
  readonly known: boolean;
  readonly steps: readonly SyncStep[];
}

function issueSteps(issue: GithubIssue, imported: ReadonlyMap<string, Task>, rules: ImportRules): IssueSteps {
  const wanted = issueTask(issue, rules);
  const task = imported.get(wanted.ref);
  if (task === undefined) {
    const input: ImportInput = { title: wanted.title, description: wanted.description, owner: wanted.owner, ref: wanted.ref, priority: wanted.priority };
    return { known: false, steps: wanted.outcome === 'open' ? [{ kind: 'add', ref: wanted.ref, input }] : [] };
  }
  const steps: SyncStep[] = [];
  const changes = fieldChanges(task, wanted);
  const names = Object.keys(changes);
  if (names.length > 0) {
    steps.push({ kind: 'update', ref: wanted.ref, id: task.id, changes, note: `${namesText(names)} as on GitHub` });
  }
  const status = statusChange(task, wanted, issue.stateReason);
  if (status !== undefined) {
    steps.push({ kind: 'status', ref: wanted.ref, id: task.id, input: status });
  }
  return { known: true, steps };
}

/** The field names a sync's note lists: `title`, `title and priority`, `title, description and priority`. */
function namesText(names: readonly string[]): string {
  const last = names.at(-1) ?? '';
  return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/** The title, description and priority the issue now gives, where they differ from the task's. */
function fieldChanges(task: Task, wanted: IssueTask): ImportChanges {
  return {
    ...(task.title === wanted.title ? {} : { title: wanted.title }),
    ...(task.description === wanted.description ? {} : { description: wanted.description }),
    ...(task.priority === wanted.priority ? {} : { priority: wanted.priority }),
  };
}

/** The status the issue calls for, when the task is not in it: an active status counts as open. */
function statusChange(task: Task, wanted: IssueTask, stateReason: string): StatusInput | undefined {
  switch (wanted.outcome) {
    case 'open':
      return ACTIVE_STATUSES.includes(task.status) ? undefined : { status: 'open', note: 'open on GitHub' };
    case 'done':
      return task.status === 'done' ? undefined : { status: 'done', note: closedNote(stateReason), evidence: wanted.url };
    case 'dropped':
      return task.status === 'dropped' ? undefined : { status: 'dropped', note: closedNote(stateReason) };
  }
}

/** The note on a closed issue's task: how GitHub closed it, when it is a reason GitHub names. */
export function closedNote(stateReason: string): string {
  const reason = CLOSE_REASONS.get(stateReason.toUpperCase());
  return reason === undefined ? 'closed on GitHub' : `closed on GitHub as ${reason}`;
}
