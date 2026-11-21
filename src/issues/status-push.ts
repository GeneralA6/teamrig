import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, GITHUB_SOURCE, type TaskStatus } from '../register/model.ts';
import { DESIGN_LABEL } from './design-label.ts';
import { targetText, type CloseReason, type IssueTarget, type LabelNaming, type LabelSpec } from './host.ts';
import type { HostIssue } from './issue.ts';
import { parseRef } from './ref.ts';

/**
 * The status push (T2682): each issue a task holds shows that task's status, so a reader of the issue list sees
 * where the work stands without a teamrig team. The register is the store of record: an active task gives its
 * issue one `status:` label, a done task closes it as completed, a dropped one as not planned. The plan compares
 * the task with the issue as the host lists it now, not with what an earlier run sent, so five status changes since
 * the last run are one label swap, a run that failed half way is redone by the next, and a status label someone
 * edited by hand is set back. A person's close is never undone here: the issue stays closed and the plan names it.
 * An open issue with no assignee gets one (T2999): the login of the task's owning session, else the login the sync runs
 * as (T4581), else none; never the repository's owner, which may be an organization no one can be assigned as. An
 * issue a person assigned keeps its assignees, and the push takes none off.
 * An open task no session has scheduled leaves its issue open to anyone (T3021): `status:open` and no assignee, so a
 * contributor sees what is free to take. A scheduled one, or one a person took, shows `status:claimed`. A goal, a
 * task planned after its parts, shows no status label: its parts' issues carry theirs (T3056).
 */

/** The label namespace the push owns: any label in it but the task's own is taken off. */
export const STATUS_LABEL_PREFIX = 'status:';

/** The labels an open issue shows: one per active status, and `claimed` for an open task that is taken. */
export const STATUS_LABELS: Readonly<Record<'open' | 'claimed' | 'in-progress' | 'waiting' | 'verifying', string>> = {
  open: `${STATUS_LABEL_PREFIX}open`,
  claimed: `${STATUS_LABEL_PREFIX}claimed`,
  'in-progress': `${STATUS_LABEL_PREFIX}in progress`,
  waiting: `${STATUS_LABEL_PREFIX}waiting`,
  verifying: `${STATUS_LABEL_PREFIX}in review`,
};

/**
 * The status labels as the push makes them in a repository that lacks one: a new repository has none, and without
 * them every change would be held. Only these five can be made (github/gh.ts allows no other label create), so a
 * push never makes a label a person did not see in the docs. The colours read on light and dark backgrounds alike.
 */
export const STATUS_LABEL_SPECS: readonly LabelSpec[] = [
  { name: STATUS_LABELS.open, color: 'ededed', description: 'Open to anyone: no one has taken it yet' },
  { name: STATUS_LABELS.claimed, color: '1d76db', description: 'Taken: its assignee plans to work on it' },
  { name: STATUS_LABELS['in-progress'], color: '8957e5', description: 'Work on it is under way' },
  { name: STATUS_LABELS.waiting, color: 'fbca04', description: 'Waiting on an answer, a review or another issue' },
  { name: STATUS_LABELS.verifying, color: '0e8a16', description: 'Done, and in review until its proof exists' },
];

/**
 * The writes one run sends at most. GitHub's secondary limit on content-creating calls is 80 a minute; half of it
 * leaves room for the team's other writes (comments, the ship's pull requests) in the same minute. The rest of the
 * plan waits for the next run, which plans it again from the issues as they are then.
 */
export const PUSH_WRITES_PER_RUN = 40;

/**
 * The writes the automatic push sends in an hour at most. GitHub's secondary limit on content-creating calls is also
 * 500 an hour; half of it leaves the same room as PUSH_WRITES_PER_RUN does within the minute.
 */
export const PUSH_WRITES_PER_HOUR = 250;

/**
 * The writes one automatic push sends at most when the watch can run a sync every `probeSeconds` and the hour's
 * count of sent writes cannot be read (push-hour.ts): PUSH_WRITES_PER_RUN, lowered so that the runs of an hour stay
 * within PUSH_WRITES_PER_HOUR. An hour holds up to ceil(3600 / probeSeconds) runs (every 420 seconds: 9, at 0, 7,
 * ..., 56 minutes), so the hourly writes are split by that. 0 seconds is the watch turned off: no writes.
 */
export function autoPushWrites(probeSeconds: number): number {
  if (probeSeconds <= 0) {
    return 0;
  }
  return Math.min(PUSH_WRITES_PER_RUN, Math.floor(PUSH_WRITES_PER_HOUR / Math.ceil(3600 / probeSeconds)));
}

/**
 * The writes one automatic push sends at most when `sent` writes went out in the last hour (T4592):
 * PUSH_WRITES_PER_RUN, or what PUSH_WRITES_PER_HOUR has left when that is less. A backlog drains at the run limit
 * until the hour is spent, however often the watch runs; 0 seconds is the watch turned off: no writes.
 */
export function hourPushWrites(probeSeconds: number, sent: number): number {
  if (probeSeconds <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(PUSH_WRITES_PER_RUN, PUSH_WRITES_PER_HOUR - sent));
}

/**
 * What an issue should show for its task: open with one status label (none for a goal), or closed for a reason.
 * `claim` is set for an open issue the push assigns when it has no assignee.
 */
export type IssueGoal = { readonly open: true; readonly label: string | undefined; readonly claim: boolean } | { readonly open: false; readonly reason: CloseReason };

/** The task facts that decide its issue's look. */
export type GoalFacts = Pick<Task, 'status' | 'due' | 'after'>;

/**
 * Whether a session has taken the task on: started, or given a due date. An open one with neither is work no session
 * has planned, so its issue stays open to anyone.
 */
export function scheduled(task: Pick<Task, 'status' | 'due'>): boolean {
  return task.status !== 'open' || task.due !== null;
}

/**
 * Whether the task is a goal: a whole planned after its parts, which the issue links make the parent of their issues
 * (issues/links.ts). Its parts carry the status, so its own issue shows none.
 */
export function isGoal(task: Pick<Task, 'after'>): boolean {
  return task.after.length > 0;
}

/**
 * What the issue shows besides its task: whether it has an assignee (someone took it), and whether it is a design issue
 * (talk only, design-label.ts).
 */
export interface IssueFacts {
  readonly assigned: boolean;
  readonly design: boolean;
}

/**
 * The issue a task calls for. A design issue shows no status label and is assigned to no one: it is talk, not work
 * to take, until it is agreed (T3096).
 */
export function issueGoal(task: GoalFacts, issue: IssueFacts): IssueGoal {
  switch (task.status) {
    case 'done':
      return { open: false, reason: 'completed' };
    case 'dropped':
      return { open: false, reason: 'not-planned' };
    default: {
      if (issue.design) {
        return { open: true, label: undefined, claim: false };
      }
      const claim = scheduled(task);
      if (isGoal(task)) {
        return { open: true, label: undefined, claim };
      }
      if (task.status === 'open') {
        return { open: true, label: claim || issue.assigned ? STATUS_LABELS.claimed : STATUS_LABELS.open, claim };
      }
      return { open: true, label: STATUS_LABELS[task.status], claim };
    }
  }
}

/** The writes that bring one issue in step with its task: the labels to add and take off, and a close. */
export interface IssueChange {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** Set when the issue is to close, for this reason. */
  readonly close: CloseReason | undefined;
  /** Set when the open issue has no assignee: the login to assign it to. */
  readonly assign?: string;
}

/**
 * Each session's GitHub login, from `github.owners` (login to session): the first login listed for a session, so a
 * session two logins map to is assigned as the first of them.
 */
export type SessionLogins = ReadonlyMap<string, string>;

/** The session-to-login map of `owners`, a login-to-session map such as `github.owners`. */
export function sessionLogins(owners: Readonly<Record<string, string>>): SessionLogins {
  const logins = new Map<string, string>();
  for (const [login, session] of Object.entries(owners)) {
    if (!logins.has(session)) {
      logins.set(session, login);
    }
  }
  return logins;
}

/**
 * The login the sync's access belongs to, the one it runs as: not read yet, or read, undefined when the host could not
 * say. It costs a read, so the push asks for it only when a plan needs it (PushPlan.wantsViewer).
 */
export type ViewerLogin = { readonly kind: 'unread' } | { readonly kind: 'read'; readonly login: string | undefined };

/** The viewer of a run that has not read it yet. */
export const VIEWER_UNREAD: ViewerLogin = { kind: 'unread' };

/** The viewer as read: `login`, undefined when it could not be read. */
export function viewerRead(login: string | undefined): ViewerLogin {
  return { kind: 'read', login };
}

/** The viewer's login, undefined while it is unread or when it could not be read. */
function viewerLogin(viewer: ViewerLogin): string | undefined {
  return viewer.kind === 'read' ? viewer.login : undefined;
}

/**
 * Whom the push may assign in one repository: each session's login, the login the sync runs as, and what the host
 * answered for each login read so far. GitHub logins match whatever their case, so both sets key by the lowercase.
 */
export interface PushAssignees {
  readonly logins: SessionLogins;
  /** The login the sync's access belongs to, the one it runs as (ViewerLogin). */
  readonly viewer: ViewerLogin;
  /** Logins the repository may not assign, lowercase: each is passed over for the next in line. */
  readonly refused: ReadonlySet<string>;
  /** Logins the repository may assign, lowercase, to the host's own spelling, which GitHub's assign needs. */
  readonly spelled: ReadonlyMap<string, string>;
}

/** The assignees of a run whose logins the host has not been asked about yet. */
export function pushAssignees(logins: SessionLogins, viewer: ViewerLogin): PushAssignees {
  return { logins, viewer, refused: new Set(), spelled: new Map() };
}

/**
 * Who an issue whose task `session` owns is assigned to: the session's login, else the login the sync runs as, each
 * skipped when the repository may not assign it; undefined when neither is left, and the issue stays unassigned, or
 * while the viewer is unread. Sessions are not GitHub users, so a session no login maps to cannot be named itself; the
 * repository's owner is never a fallback, as an organization owns it once moved and no one is assigned as one.
 */
export function assigneeOf(session: string, who: PushAssignees): string | undefined {
  for (const login of [who.logins.get(session), viewerLogin(who.viewer)]) {
    if (login !== undefined && !who.refused.has(login.toLowerCase())) {
      return who.spelled.get(login.toLowerCase()) ?? login;
    }
  }
  return undefined;
}

/** A closed issue whose task is still active: closed by a person, so it stays closed, and the task's owner decides. */
export interface ClosedActive {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
  /** Why it closed, as the host names it; empty when it gives none. */
  readonly stateReason: string;
}

/**
 * An open issue a finished task holds that the push leaves open: the task only took part in it, so its end is not the
 * issue's. A design issue ends by its maintainers' `Agreed:` (write-issue, section 6), and an issue assigned only to
 * logins outside the team is its taker's work, closed by their pull request or by a person. A task that only posted a
 * comment there, done, must never close it.
 */
export interface KeptOpen {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
  /** Why the close is left: a design issue, or the outside logins it is assigned to. */
  readonly why: { readonly kind: 'design' } | { readonly kind: 'taken'; readonly assignees: readonly string[] };
}

/** An issue an active task holds that the host did not list as open or lately closed. */
export interface UnlistedIssue {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
}

/**
 * An issue two or more team tasks hold (#1449). Which of them speaks for it is not the push's to guess: following the
 * first one read set an issue back to the status of an older task while another landed its fix. So the push writes
 * nothing to it and names the tasks, for a person to give the ref to one of them.
 */
export interface SharedIssue {
  readonly target: IssueTarget;
  /** The team tasks holding it, in id order. */
  readonly tasks: readonly string[];
}

/** What a push of one repository would send, and what it leaves. */
export interface PushPlan {
  readonly repo: string;
  /** The changes this run sends, whole, in issue order, within the run's writes. */
  readonly changes: readonly IssueChange[];
  /** The changes left for the next run, past the run's writes. */
  readonly deferred: readonly IssueChange[];
  /** The closes this push may not send (PushLimits.closes off): planned and printed, sent by a session's push. */
  readonly heldCloses: readonly IssueChange[];
  /** Issues already showing their task's status. */
  readonly unchanged: number;
  readonly closedActive: readonly ClosedActive[];
  /** Open issues a finished task holds whose close is not the task's to send (KeptOpen). */
  readonly keptOpen: readonly KeptOpen[];
  /** Issues an active task holds that the list did not include: closed before the listed days, or gone. */
  readonly unlisted: readonly UnlistedIssue[];
  /** Issues two or more team tasks hold: nothing planned for them (SharedIssue). */
  readonly shared: readonly SharedIssue[];
  /** Numbers an active task holds that are open pull requests, which the issue list never holds (#1451). */
  readonly openPulls: readonly UnlistedIssue[];
  /**
   * Whether the plan would change once the unread viewer is known: an issue to assign that its session's login cannot
   * take, or a close left for logins outside the team, which may be the viewer's. Planned again after the read.
   */
  readonly wantsViewer: boolean;
}

/** The writes one change sends: one per label added or taken off, one for the assign, and one for the close. */
export function changeWrites(change: IssueChange): number {
  return change.add.length + change.remove.length + (change.assign === undefined ? 0 : 1) + (change.close === undefined ? 0 : 1);
}

/** What one push may send. */
export interface PushLimits {
  /** The writes the run sends at most; the rest is deferred. */
  readonly writesPerRun: number;
  /**
   * Whether the push may close an issue. The automatic push may not (security verdict F1 on T2876): a close is the
   * one write a person sees as a decision, so only a session's `issue sync --push --yes` sends it; the automatic push
   * holds it, printed, outside the run's writes.
   */
  readonly closes: boolean;
}

/** A session's push: the run's writes, closes sent. */
export const SESSION_PUSH: PushLimits = { writesPerRun: PUSH_WRITES_PER_RUN, closes: true };

/**
 * The push of `repo`: for each issue of it a task holds, by `ref: gh:<repo>#<n>`, the writes that make the issue
 * show the task's status, planned against `issues` as the host listed them now (open ones and those closed lately).
 * When a team task and an imported one hold the same issue, the team task speaks for it: the issue is its work. When
 * two or more active team tasks hold it, none does: the plan writes nothing to it and names them (SharedIssue); one
 * active team task speaks over finished ones (holders). The run sends at most `limits.writesPerRun` writes; the rest is deferred. Without `limits.closes` a closing change
 * is held instead, taking none of the run's writes. With `who` an open issue of a scheduled task with no assignee
 * is assigned (assigneeOf); without, the plan assigns nobody. While `who`'s viewer is unread, the plan says where it
 * would count (wantsViewer), for the caller to read it and plan again. A login `who` refuses is never planned, so it takes none
 * of the run's writes and the changes behind it go out (T4581). A number the list left out that is in `openPulls`, the
 * repository's open pull requests, is named as one, not as an issue gone from the list. A status label is planned
 * under the name the tracker holds it by (`labelName`, the tracker's Labels.labelName), as the list gives it back
 * under that name: planned by its own name, a label the tracker renames would be added again on every run.
 */
export function planPush(
  repo: string,
  issues: readonly HostIssue[],
  tasks: Iterable<Task>,
  limits: PushLimits = SESSION_PUSH,
  who?: PushAssignees,
  openPulls: ReadonlySet<number> = new Set(),
  labelName: LabelNaming = (label) => label,
): PushPlan {
  const listed = new Map(issues.filter((issue) => issue.repo === repo).map((issue) => [issue.number, issue]));
  const planned: IssueChange[] = [];
  const closedActive: ClosedActive[] = [];
  const keptOpen: KeptOpen[] = [];
  const unlisted: UnlistedIssue[] = [];
  const pulls: UnlistedIssue[] = [];
  let unchanged = 0;
  let wantsViewer = false;
  const held = holders(repo, tasks);
  for (const [target, task] of [...held.speakers].sort(([a], [b]) => a - b).map(([number, holder]) => [{ repo, number }, holder] as const)) {
    const issue = listed.get(target.number);
    if (issue === undefined) {
      // The list holds every open issue, so one it left out is closed (or gone): as a closed task wants it. An open
      // pull request is never on it: the push writes only issues, so it leaves that one as it is.
      if (issueGoal(task, { assigned: false, design: false }).open) {
        (openPulls.has(target.number) ? pulls : unlisted).push({ target, task: task.id, status: task.status });
      } else {
        unchanged += 1;
      }
      continue;
    }
    const plan = planIssue(target, task, issue, who, labelName);
    if (plan.kind === 'closed-active') {
      closedActive.push({ target, task: task.id, status: task.status, stateReason: issue.stateReason });
    } else if (plan.kind === 'kept-open') {
      wantsViewer ||= plan.wantsViewer;
      keptOpen.push({ target, task: task.id, status: task.status, why: plan.why });
    } else if (plan.kind === 'unchanged') {
      wantsViewer ||= plan.wantsViewer;
      unchanged += 1;
    } else {
      wantsViewer ||= plan.wantsViewer;
      planned.push(plan.change);
    }
  }
  const heldCloses = limits.closes ? [] : planned.filter((change) => change.close !== undefined);
  const sendable = limits.closes ? planned : planned.filter((change) => change.close === undefined);
  const { changes, deferred } = withinRun(sendable, limits.writesPerRun);
  const shared = [...held.shared].sort(([a], [b]) => a - b).map(([number, ids]) => ({ target: { repo, number }, tasks: ids }));
  return { repo, changes, deferred, heldCloses, unchanged, closedActive, keptOpen, unlisted, shared, openPulls: pulls, wantsViewer };
}

/** `goal` with its status label under the name the tracker holds it by. */
function heldGoal(goal: IssueGoal, labelName: LabelNaming): IssueGoal {
  return goal.open && goal.label !== undefined ? { ...goal, label: labelName(goal.label) } : goal;
}

/**
 * Why a finished task's close of the open `issue` is left, or undefined when the close is the task's to send. The
 * team's logins are its sessions' (from `github.owners`), the one the sync runs as, and the repository's owner account,
 * whom pushes before T4581 assigned; GitHub logins match whatever their case. A session two logins map to counts by its
 * first, as assigneeOf assigns it.
 */
function closeLeft(repo: string, issue: IssueNow, who: PushAssignees | undefined): KeptOpen['why'] | undefined {
  if (issue.labels.includes(DESIGN_LABEL)) {
    return { kind: 'design' };
  }
  const viewer = who === undefined ? undefined : viewerLogin(who.viewer);
  const ours = [repo.slice(0, repo.indexOf('/')), ...(who?.logins.values() ?? []), ...(viewer === undefined ? [] : [viewer])];
  const team = new Set(ours.map((login) => login.toLowerCase()));
  const outside = issue.assignees.filter((login) => !team.has(login.toLowerCase()));
  return issue.assignees.length > 0 && outside.length === issue.assignees.length ? { kind: 'taken', assignees: outside } : undefined;
}

/** What one issue's push reads of it now: its state, labels and assignees. */
export type IssueNow = Pick<HostIssue, 'state' | 'labels' | 'assignees'>;

/**
 * One issue's push: the change that makes it show its task's status, unchanged when it already does, closed-active
 * for a closed issue whose task is still active (a person closed it, so it stays closed and the task's owner decides),
 * or kept-open for an open issue whose close is not its finished task's to send (closeLeft).
 */
export type IssuePlan =
  | { readonly kind: 'change'; readonly change: IssueChange; readonly wantsViewer: boolean }
  | { readonly kind: 'unchanged'; readonly wantsViewer: boolean }
  | { readonly kind: 'closed-active' }
  | { readonly kind: 'kept-open'; readonly why: KeptOpen['why']; readonly wantsViewer: boolean };

/**
 * The push of the one issue `task` holds, planned against `issue` as the host has it now, the same way planPush plans
 * each issue of a repository: with `who` an open issue of a scheduled task with no assignee is assigned (assigneeOf),
 * and without, nobody is. `wantsViewer` says the plan would change once `who`'s unread viewer is known
 * (PushPlan.wantsViewer). Its status label is planned under the name the tracker holds it by (`labelName`), as
 * `issue` carries it under that name.
 */
export function planIssue(target: IssueTarget, task: Task, issue: IssueNow, who?: PushAssignees, labelName: LabelNaming = (label) => label): IssuePlan {
  const goal = heldGoal(issueGoal(task, { assigned: issue.assignees.length > 0, design: issue.labels.includes(DESIGN_LABEL) }), labelName);
  if (issue.state === 'closed' && goal.open) {
    return { kind: 'closed-active' };
  }
  const kept = goal.open || issue.state === 'closed' ? undefined : closeLeft(target.repo, issue, who);
  if (kept !== undefined) {
    return { kind: 'kept-open', why: kept, wantsViewer: kept.kind === 'taken' && who?.viewer.kind === 'unread' };
  }
  const assigns = goal.open && goal.claim && who !== undefined && issue.assignees.length === 0;
  const assign = assigns ? assigneeOf(task.owner, who) : undefined;
  const wantsViewer = assigns && assign === undefined && who.viewer.kind === 'unread';
  const change = changeFor(target, task, issue, goal, assign);
  return change === undefined ? { kind: 'unchanged', wantsViewer } : { kind: 'change', change, wantsViewer };
}

/**
 * The push of the one issue `task` holds (planIssue) as a plan of its repository, for a write of one issue
 * (issues/reply.ts): its change alone, or nothing to send, with the issue's `wantsViewer`, so planAssigned picks its
 * assignee as it does for the repository push and applyPush sends it. A closed issue of an active task sends nothing.
 */
export function issuePushPlan(target: IssueTarget, task: Task, issue: IssueNow, who: PushAssignees, labelName?: LabelNaming): PushPlan {
  const plan = planIssue(target, task, issue, who, labelName);
  const none = { repo: target.repo, changes: [], deferred: [], heldCloses: [], unchanged: 0, closedActive: [], keptOpen: [], unlisted: [], shared: [], openPulls: [] };
  if (plan.kind === 'closed-active') {
    return { ...none, wantsViewer: false };
  }
  return plan.kind === 'change' ? { ...none, changes: [plan.change], wantsViewer: plan.wantsViewer } : { ...none, unchanged: 1, wantsViewer: plan.wantsViewer };
}

/** Who holds one issue as the push picks it (holders): the one task speaking for it, or the active tasks sharing it. */
export type IssueHolder = { readonly kind: 'speaker'; readonly task: Task } | { readonly kind: 'shared'; readonly tasks: readonly string[] };

/** The holder of `target` as the push picks it (holders), or undefined when no task holds it. */
export function holderOf(target: IssueTarget, tasks: Iterable<Task>): IssueHolder | undefined {
  const held = holders(target.repo, tasks);
  const speaker = held.speakers.get(target.number);
  if (speaker !== undefined) {
    return { kind: 'speaker', task: speaker };
  }
  const shared = held.shared.get(target.number);
  return shared === undefined ? undefined : { kind: 'shared', tasks: shared };
}

/**
 * The tasks holding each issue number of `repo`: in `speakers`, the one task speaking for it, else the first one the
 * import added; in `shared`, the ids of an issue two or more active team tasks hold, which none speaks for.
 * A team task speaks when it is the only active one holding the issue: a finished task often keeps its ref, so a done
 * task beside its open follow-up never freezes the issue. With none active, the newest finished one speaks (the last
 * word on the issue), so old finished tasks never name an issue SHARED on every push.
 */
function holders(repo: string, tasks: Iterable<Task>): { speakers: Map<number, Task>; shared: Map<number, string[]> } {
  const team = new Map<number, Task[]>();
  const imported = new Map<number, Task>();
  for (const task of tasks) {
    const target = heldIssue(task);
    if (target?.repo !== repo) {
      continue;
    }
    if (task.source !== GITHUB_SOURCE) {
      team.set(target.number, [...(team.get(target.number) ?? []), task]);
    } else if (!imported.has(target.number)) {
      imported.set(target.number, task);
    }
  }
  const speakers = new Map(imported);
  const shared = new Map<number, string[]>();
  for (const [number, held] of team) {
    speakers.delete(number);
    const byId = [...held].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const active = byId.filter((task) => ACTIVE_STATUSES.includes(task.status));
    const speaker = active.length === 0 ? byId.at(-1) : active.length === 1 ? active[0] : undefined;
    if (speaker !== undefined) {
      speakers.set(number, speaker);
    } else {
      shared.set(
        number,
        active.map((task) => task.id),
      );
    }
  }
  return { speakers, shared };
}

/** The issue a task holds by its ref, or undefined when its ref names none. */
export function heldIssue(task: Task): IssueTarget | undefined {
  return parseRef(task.ref);
}

/**
 * The writes for one listed issue, or undefined when it already shows its task's status. A closing issue loses its
 * status labels too, so a closed issue never shows work as still going on. `assign`, set for an open issue with no
 * assignee, is the login it gets.
 */
function changeFor(target: IssueTarget, task: Task, issue: IssueNow, goal: IssueGoal, assign: string | undefined): IssueChange | undefined {
  const statusLabels = issue.labels.filter((label) => label.startsWith(STATUS_LABEL_PREFIX));
  if (!goal.open) {
    if (issue.state === 'closed') {
      return undefined;
    }
    return { target, task: task.id, status: task.status, add: [], remove: statusLabels, close: goal.reason };
  }
  const wanted = goal.label === undefined ? [] : [goal.label];
  const add = wanted.filter((label) => !statusLabels.includes(label));
  const remove = statusLabels.filter((label) => !wanted.includes(label));
  if (add.length === 0 && remove.length === 0 && assign === undefined) {
    return undefined;
  }
  return { target, task: task.id, status: task.status, add, remove, close: undefined, ...(assign === undefined ? {} : { assign }) };
}

/** The whole changes that fit in one run's writes, in order, and the rest. A change is never split across runs. */
function withinRun(planned: readonly IssueChange[], writesPerRun: number): { changes: IssueChange[]; deferred: IssueChange[] } {
  const changes: IssueChange[] = [];
  const deferred: IssueChange[] = [];
  let writes = 0;
  for (const change of planned) {
    const cost = changeWrites(change);
    if (deferred.length === 0 && writes + cost <= writesPerRun) {
      changes.push(change);
      writes += cost;
    } else {
      deferred.push(change);
    }
  }
  return { changes, deferred };
}

/** One change on one line: CLOSE, LABEL or, for an assign alone, ASSIGN; the issue, its task and status, then each write. */
export function changeLine(change: IssueChange): string {
  const writes = [
    ...(change.close === undefined ? [] : [`close as ${change.close}`]),
    ...change.add.map((label) => `add ${label}`),
    ...change.remove.map((label) => `take off ${label}`),
    ...(change.assign === undefined ? [] : [`assign ${change.assign}`]),
  ];
  return `${changeTag(change)} ${targetText(change.target)} ${change.task} ${change.status}: ${writes.join(', ')}`;
}

/** The word a change's line starts with. */
function changeTag(change: IssueChange): 'CLOSE' | 'LABEL' | 'ASSIGN' {
  if (change.close !== undefined) {
    return 'CLOSE';
  }
  return change.add.length === 0 && change.remove.length === 0 ? 'ASSIGN' : 'LABEL';
}
