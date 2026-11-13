import { KIT_NAME } from '../core/home.ts';
import { targetText, type HeadRead, type IssueTarget } from './host.ts';

/**
 * Who may write on an issue or pull request (T2705): the team's GitHub admin on any of the team's repositories,
 * every other session only on its own. An issue is a session's own when one of its tasks has that issue as its ref;
 * a pull request when its head branch, in the same repository, is a `t<id>-` branch of one of its tasks. A fork's
 * branch is never a session's, whatever its name.
 */

/** The fields of a task the rule reads. */
export interface OwnedTask {
  readonly id: string;
  readonly owner: string;
  readonly ref: string | null;
}

/** The team's GitHub admin as the role reads now: its session, or undefined when none is set or the role is broken; `text` says which. */
export interface AdminView {
  readonly session: string | undefined;
  readonly text: string;
}

/** What the rule decided: the caller may write, and why; it may not; or it could not tell, as the host could not be read. */
export type WriteRight =
  | { readonly kind: 'allowed'; readonly why: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** What the rule reads. The admin and the head are read only when the tasks alone do not decide. */
export interface RightFacts {
  readonly caller: string;
  readonly target: IssueTarget;
  /** The task ref that names the target on its host, such as `gh:acme/web#7`. */
  readonly ref: string;
  readonly tasks: readonly OwnedTask[];
  readonly admin: () => Promise<AdminView>;
  readonly head: () => Promise<HeadRead>;
}

/** A task branch: `t<id>-<words>`, as each change's branch is named. */
const TASK_BRANCH = /^t([1-9][0-9]*)-/iu;

/** The task id a branch is named for, `T12` for `t12-fix`; undefined for any other branch. */
export function branchTaskId(branch: string): string | undefined {
  const digits = TASK_BRANCH.exec(branch)?.[1];
  return digits === undefined ? undefined : `T${digits}`;
}

/** Decides whether `facts.caller` may write on `facts.target`. */
export async function writeRight(facts: RightFacts): Promise<WriteRight> {
  const { caller, target, tasks } = facts;
  const ownTask = tasks.find((task) => task.owner === caller && task.ref === facts.ref);
  if (ownTask !== undefined) {
    return { kind: 'allowed', why: `${ownTask.id} of ${caller} has it as its ref` };
  }
  const admin = await facts.admin();
  if (admin.session === caller) {
    return { kind: 'allowed', why: `${caller} is the GitHub admin` };
  }
  const shown = targetText(target);
  const head = await facts.head();
  if (head.kind === 'failed') {
    return { kind: 'unknown', reason: `could not tell whose ${shown} is: ${head.reason}` };
  }
  const branchTask = head.kind === 'pull' && head.repo === target.repo ? branchTaskId(head.branch) : undefined;
  if (branchTask !== undefined && tasks.some((task) => task.id === branchTask && task.owner === caller)) {
    return { kind: 'allowed', why: `its branch is one of ${branchTask} of ${caller}` };
  }
  return {
    kind: 'refused',
    reason: `${caller} may write only on its own issues and pull requests, and ${shown} is not one: no task of ${caller} has it as its ref, and ${headText(head, target.repo, caller)}; ${admin.text}`,
  };
}

/** Why the pull request's head does not make it the caller's. */
function headText(head: Exclude<HeadRead, { readonly kind: 'failed' }>, repo: string, caller: string): string {
  if (head.kind === 'no-pull') {
    return 'it is no pull request';
  }
  if (head.repo !== repo) {
    return `its pull request's branch ${head.branch} is in ${head.repo ?? 'a fork since deleted'}, not ${repo}`;
  }
  return `its pull request's branch ${head.branch} is no t<id>- branch of a task of ${caller}`;
}

/** How a refusal names the admin, who may write where the caller may not. */
export function adminText(session: string | undefined, broken: string | undefined): string {
  if (session !== undefined) {
    return `the GitHub admin, ${session}, writes on the rest`;
  }
  const why = broken === undefined ? 'none is set' : `the role reads broken (${broken})`;
  return `the GitHub admin writes on the rest, and ${why}: the owner names one with ${KIT_NAME} owner github-admin <session>`;
}
