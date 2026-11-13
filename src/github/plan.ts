import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import { GITHUB_SOURCE } from '../register/model.ts';
import type { ImportChanges, ImportInput, StatusInput } from '../register/policy.ts';
import type { GithubIssue } from './issues.ts';
import { ISSUE_REF_PREFIX, issueTask, type ImportRules, type IssueTask } from './map.ts';
import { issueTrust } from './trust.ts';

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

/** What a sync would write, how many issues it would add, change or leave as they are, and which it leaves out. */
export interface SyncPlan {
  readonly steps: readonly SyncStep[];
  readonly inserted: number;
  readonly changed: number;
  readonly unchanged: number;
  /** The numbers, lowest first, of the open issues with no task that are neither trusted nor accepted (trust.ts): never their text. */
  readonly leftOut: readonly number[];
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
 * The refs of the team's own tasks that point at an issue: each issue the team opened for one of its tasks (gh
 * migrate) is tracked by that task, so the import must not add a second task for it. Its text, owner and status
 * stay the team's: the issue holds the public wording, the task the team's own.
 */
export function linkedRefs(tasks: Iterable<Task>): Set<string> {
  const refs = new Set<string>();
  for (const task of tasks) {
    if (task.source !== GITHUB_SOURCE && task.ref !== null && task.ref.startsWith(ISSUE_REF_PREFIX)) {
      refs.add(task.ref);
    }
  }
  return refs;
}

/**
 * The writes that bring the register in step with a repository's issues. An issue a team task links to
 * (`linked`, from linkedRefs) is that task's: nothing is written for it. An open issue with no task is
 * added when it is trusted or accepted (trust.ts), else left out by its number; a closed one with no task is
 * not, as there is nothing left to do. On a task the import added, only the title, the description, the
 * priority and whether it is open follow GitHub: any active status stands for an open issue, and its owner,
 * notes and plans stay the team's. The title and description follow only while the issue is trusted or
 * accepted, so an outsider's edit after the accept stays on GitHub until someone accepts the issue again;
 * the task keeps the text of the last accept, and stays when its issue stops qualifying.
 */
export function planSync(issues: readonly GithubIssue[], imported: ReadonlyMap<string, Task>, rules: ImportRules, linked: ReadonlySet<string> = new Set()): SyncPlan {
  const perIssue = issues.map((issue) => issueSteps(issue, imported, rules, linked));
  const count = (known: boolean, writes: boolean): number => perIssue.filter((one) => one.known === known && (one.steps.length > 0) === writes).length;
  return {
    steps: perIssue.flatMap((one) => one.steps),
    inserted: count(false, true),
    changed: count(true, true),
    unchanged: count(true, false),
    leftOut: perIssue.flatMap((one) => one.leftOut ?? []).sort((a, b) => a - b),
  };
}

/** An issue's writes, whether the register already has its task, and its number when the trust rule left it out. */
interface IssueSteps {
  readonly known: boolean;
  readonly steps: readonly SyncStep[];
  readonly leftOut?: number;
}

function issueSteps(issue: GithubIssue, imported: ReadonlyMap<string, Task>, rules: ImportRules, linked: ReadonlySet<string>): IssueSteps {
  const wanted = issueTask(issue, rules);
  const task = imported.get(wanted.ref);
  const followsText = issueTrust(issue, rules.acceptLabel) !== 'untrusted';
  if (task === undefined && linked.has(wanted.ref)) {
    return { known: true, steps: [] };
  }
  if (task === undefined) {
    if (wanted.outcome !== 'open') {
      return { known: false, steps: [] };
    }
    if (!followsText) {
      return { known: false, steps: [], leftOut: issue.number };
    }
    const input: ImportInput = { title: wanted.title, description: wanted.description, owner: wanted.owner, ref: wanted.ref, priority: wanted.priority };
    return { known: false, steps: [{ kind: 'add', ref: wanted.ref, input }] };
  }
  const steps: SyncStep[] = [];
  const changes = fieldChanges(task, wanted, followsText);
  const names = Object.keys(changes);
  if (names.length > 0) {
    steps.push({ kind: 'update', ref: wanted.ref, id: task.id, changes, note: `${namesText(names)} as on GitHub` });
  }
  const status = statusChange(task, wanted, issue);
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

/** The priority the issue now gives, and with `followsText` its title and description, where they differ from the task's. */
function fieldChanges(task: Task, wanted: IssueTask, followsText: boolean): ImportChanges {
  return {
    ...(!followsText || task.title === wanted.title ? {} : { title: wanted.title }),
    ...(!followsText || task.description === wanted.description ? {} : { description: wanted.description }),
    ...(task.priority === wanted.priority ? {} : { priority: wanted.priority }),
  };
}

/**
 * The status the issue calls for, when the task is not in it: an active status counts as open. A task set done or
 * dropped while its issue is open goes back to open only once GitHub changed the issue after that, as reopening it
 * does, so the team's own close of an issue still open on GitHub stands.
 */
function statusChange(task: Task, wanted: IssueTask, issue: GithubIssue): StatusInput | undefined {
  switch (wanted.outcome) {
    case 'open':
      return ACTIVE_STATUSES.includes(task.status) || !changedSince(issue, task.statusAt) ? undefined : { status: 'open', note: 'open on GitHub, changed there since this task closed' };
    case 'done':
      return task.status === 'done' ? undefined : { status: 'done', note: closedNote(issue.stateReason), evidence: wanted.url };
    case 'dropped':
      return task.status === 'dropped' ? undefined : { status: 'dropped', note: closedNote(issue.stateReason) };
  }
}

/** Whether GitHub changed the issue after `at`; an issue gh gave no time for counts as unchanged. */
function changedSince(issue: GithubIssue, at: string): boolean {
  return issue.updatedAt !== undefined && Date.parse(issue.updatedAt) > Date.parse(at);
}

/** The note on a closed issue's task: how GitHub closed it, when it is a reason GitHub names. */
export function closedNote(stateReason: string): string {
  const reason = CLOSE_REASONS.get(stateReason.toUpperCase());
  return reason === undefined ? 'closed on GitHub' : `closed on GitHub as ${reason}`;
}
