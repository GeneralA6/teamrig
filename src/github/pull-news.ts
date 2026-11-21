import { formatUtcMinute } from '../core/time.ts';
import type { HostPull, PullChecks, PullMergeable, PullReview } from '../issues/pull.ts';
import type { ImportInput } from '../register/policy.ts';
import { cut } from '../register/views.ts';
import { branchTaskOf } from '../worktree/owner.ts';
import { ANSWER_TARGET_HOURS, targetMs } from './clock.ts';
import { plainLine } from './issues.ts';
import { cutTitle, issuePriority, issueRef, type ImportRules } from './map.ts';
import type { SyncStep } from './plan.ts';
import { isInsideAuthor, isOurAuthor, type OurLogins } from './trust.ts';

/**
 * The pull request monitor's decisions, kept pure: what happened to a repository's pull requests between two reads
 * (`pullEvents`, from what the last read marked), and the inbox line one session gets for its share of it
 * (`pullNewsText`, which also says whether the news wakes it).
 */

/** What the last read saw of one open pull request: the three things whose change is news. */
export interface PullMark {
  readonly number: number;
  readonly mergeable: PullMergeable;
  readonly checks: PullChecks;
  readonly review: PullReview;
}

/**
 * What the monitor keeps of one repository between reads: the newest change time it has read (an ISO time; undefined
 * while the repository had no pull request at all), and a mark per open pull request.
 */
export interface PullWatch {
  readonly cursor: string | undefined;
  readonly open: readonly PullMark[];
}

/** What happened to a pull request between two reads. */
export type PullEventKind = 'opened' | 'merged' | 'closed' | 'conflict' | 'checks-failing' | 'checks-passing' | 'approved' | 'changes-requested';

export interface PullEvent {
  readonly kind: PullEventKind;
  readonly pull: HostPull;
  /** For failing checks of a session's own pull request: the file its failed jobs' log ends went to (ci-excerpt.ts). */
  readonly ci?: CiExcerpt;
  /** A copy of the event for a session that only follows the pull request (`eventsByRecipient`): it never wakes. */
  readonly followed?: true;
}

/** Where a pull request's failed jobs' log ends were written, and each job's name and failed step (undefined when unread). */
export interface CiExcerpt {
  readonly file: string;
  readonly jobs: readonly { readonly name: string; readonly step: string | undefined }[];
}

/** The events since the last read, and what the next read compares with. */
export interface PullStep {
  readonly events: readonly PullEvent[];
  readonly after: PullWatch;
}

/** What a pull request that just opened is compared with, so one opened already conflicting or failing says so. */
const FRESH = { mergeable: 'mergeable', checks: 'none', review: 'none' } as const;

/**
 * What happened between the last read (`before`) and this one: `open`, every open pull request, and `changed`, those
 * in any state changed since the last read's cursor, each newest change first (host.ts).
 *
 * With no `before` (the first read of a repository) nothing is news: it only marks, so the history is never replayed.
 * An open one with no mark opened since the cursor, unless it was opened before it (reopened, or past an open read
 * cut at its limit): that one is marked silently. A conflict, failing checks or a review state is news when it
 * starts, never again while it lasts; checks turning passing from failing or pending (a CI run that ended green) are
 * news too, from none (no run seen) not; GitHub's `unknown` mergeable (not worked out yet) keeps the last known value. A
 * merged or closed one is news when it was marked open, or ended after the cursor. A mark of one neither open nor
 * ended in this read is dropped, as an open read cut at its limit leaves it out; it marks again silently when read.
 */
export function pullEvents(before: PullWatch | undefined, open: readonly HostPull[], changed: readonly HostPull[]): PullStep {
  const marks = new Map((before?.open ?? []).map((mark) => [mark.number, mark]));
  const ended = new Map<number, HostPull>();
  for (const pull of changed) {
    if (pull.state !== 'open' && !ended.has(pull.number)) {
      ended.set(pull.number, pull);
    }
  }
  const events: PullEvent[] = [];
  const after: PullMark[] = [];
  for (const pull of open) {
    if (ended.has(pull.number)) {
      continue;
    }
    const mark = marks.get(pull.number);
    const fresh = mark === undefined && before !== undefined && isAfter(pull.createdAt, before.cursor);
    if (fresh) {
      events.push({ kind: 'opened', pull });
    }
    const last = mark ?? (fresh ? { number: pull.number, ...FRESH } : undefined);
    const now: PullMark = { number: pull.number, mergeable: pull.mergeable === 'unknown' ? (last?.mergeable ?? 'unknown') : pull.mergeable, checks: pull.checks, review: pull.review };
    if (last !== undefined) {
      events.push(...changes(last, now).map((kind) => ({ kind, pull })));
    }
    after.push(now);
  }
  if (before !== undefined) {
    for (const pull of ended.values()) {
      if (marks.has(pull.number) || isAfter(pull.mergedAt ?? pull.closedAt ?? pull.updatedAt, before.cursor)) {
        events.push({ kind: pull.state === 'merged' ? 'merged' : 'closed', pull });
      }
    }
  }
  return { events, after: { cursor: newest([...open, ...changed].map((pull) => pull.updatedAt), before?.cursor), open: after } };
}

/** The events a mark's change makes: each state that starts with it. */
function changes(last: PullMark, now: PullMark): PullEventKind[] {
  return [
    ...(now.mergeable === 'conflicting' && last.mergeable !== 'conflicting' ? ['conflict' as const] : []),
    ...(now.checks === 'failing' && last.checks !== 'failing' ? ['checks-failing' as const] : []),
    ...(now.checks === 'passing' && (last.checks === 'failing' || last.checks === 'pending') ? ['checks-passing' as const] : []),
    ...(now.review !== last.review && now.review === 'approved' ? ['approved' as const] : []),
    ...(now.review !== last.review && now.review === 'changes-requested' ? ['changes-requested' as const] : []),
  ];
}

/** Whether `time` is after `cursor`; every time is after no cursor (a repository that had no pull request yet). */
function isAfter(time: string, cursor: string | undefined): boolean {
  return cursor === undefined || Date.parse(time) > Date.parse(cursor);
}

/** The newest of `times` and `cursor`, or undefined when there is none. */
function newest(times: readonly string[], cursor: string | undefined): string | undefined {
  return [...times, ...(cursor === undefined ? [] : [cursor])].reduce<string | undefined>((best, time) => (best === undefined || Date.parse(time) > Date.parse(best) ? time : best), undefined);
}

/**
 * Who hears about `pull`: the owner of the task its branch names (`t<id>-...`, worktree/owner.ts), when it is a
 * branch of the repository itself by one of the team's own authors (`isOurAuthor`), else `watcher`. A fork's
 * branch name, or anyone else's, is theirs to choose, so it never routes news to a session.
 */
export function pullRecipient(pull: HostPull, ours: OurLogins, ownerOf: (task: string) => string | undefined, watcher: string): string {
  return branchOwner(pull, ours, ownerOf) ?? watcher;
}

/** The owner of the task one of our authors' own branch names (`ownBranchTask`); undefined when the pull request goes to the watcher. */
function branchOwner(pull: HostPull, ours: OurLogins, ownerOf: (task: string) => string | undefined): string | undefined {
  const task = ownBranchTask(pull, ours);
  return task === undefined ? undefined : ownerOf(task);
}

/** What `pullTasks` judges a new pull request by. */
export interface PullTaskRules {
  readonly ours: OurLogins;
  readonly ownerOf: (task: string) => string | undefined;
  readonly watcher: string;
  /** Every ref a task of the register holds: a pull request one holds gets no second task. */
  readonly held: ReadonlySet<string>;
  readonly rules: Pick<ImportRules, 'maxTitle' | 'priorities' | 'secrets'>;
}

/**
 * The import steps that give each new pull request going to the watcher (`pullRecipient`: a fork's, an outside
 * author's, or one on a branch naming no task with an owner) a task of the watcher's, so it sits on a list until
 * someone answers it, not only in an inbox line. Its ref is the pull request's and it is due at a contributor's pull
 * request's answer target (clock.ts) after it opened. A ref a task holds gets none, so a second read adds no twin.
 */
export function pullTasks(events: readonly PullEvent[], at: PullTaskRules): SyncStep[] {
  const steps: SyncStep[] = [];
  const taken = new Set(at.held);
  for (const { kind, pull } of events) {
    const ref = issueRef(pull.repo, pull.number);
    if (kind !== 'opened' || taken.has(ref) || branchOwner(pull, at.ours, at.ownerOf) !== undefined) {
      continue;
    }
    taken.add(ref);
    steps.push({ kind: 'add', ref, input: pullTaskInput(pull, ref, at) });
  }
  return steps;
}

/**
 * The watcher's task for `pull`. Its title is outside input, read as the issue import reads an issue's: it carries
 * the pull request's title only for an author inside the repository (trust.ts), on one plain line and only when no
 * secret shape is in it; else it names the pull request and its author. Its description is written here, from the
 * host's fields, as the pull request read carries no body.
 */
function pullTaskInput(pull: HostPull, ref: string, at: PullTaskRules): ImportInput {
  const opened = Date.parse(pull.createdAt);
  const due = formatUtcMinute(new Date(opened + targetMs('pull')));
  const by = pull.author === '' ? 'a deleted account' : pull.author;
  const inside = isInsideAuthor(pull.authorAssociation);
  const title = plainLine(pull.title);
  const shown = inside && title !== '' && at.rules.secrets.find(title) === undefined ? `Pull request: ${title}` : `Pull request ${pull.repo}#${pull.number} by ${by}`;
  const where = [...(isOurAuthor(pull.authorAssociation, pull.author, at.ours) ? [] : ['outside']), ...(pull.fork ? ['fork'] : [])];
  const description = [
    `Pull request ${pull.url} opened by ${by}${where.length > 0 ? ` (${where.join(', ')})` : ''} at ${formatUtcMinute(new Date(opened))} UTC:`,
    `answer it on GitHub by ${due} UTC, its ${ANSWER_TARGET_HOURS.pull} h target.`,
    ...(inside ? [] : ['Its title stays on GitHub: its author is outside the repository.']),
  ].join(' ');
  return { title: cutTitle(shown, at.rules.maxTitle), description, owner: at.watcher, ref, priority: issuePriority([], at.rules.priorities), due };
}

/** One session that hears about a pull request, and whether it only follows it (its copy never wakes). */
export interface PullListener {
  readonly to: string;
  readonly followed: boolean;
}

/**
 * Everyone who hears about a pull request: its `recipient` (`pullRecipient`), then the `holder`, the owner of a task
 * whose ref links it, and its `followers` (follows.ts), those two as followers: the pull request's needs are its
 * recipient's to wake for. A session is listed once, as the first it is.
 */
export function pullListeners(recipient: string, linked: readonly string[], followers: readonly string[]): PullListener[] {
  const listeners: PullListener[] = [{ to: recipient, followed: false }];
  for (const to of [...linked, ...followers]) {
    if (!listeners.some((listener) => listener.to === to)) {
      listeners.push({ to, followed: true });
    }
  }
  return listeners;
}

/** The task one of our authors' own branch of the repository names (`t<id>-...`); undefined for a fork, anyone else or another branch name. */
export function ownBranchTask(pull: HostPull, ours: OurLogins): string | undefined {
  return pull.fork || !isOurAuthor(pull.authorAssociation, pull.author, ours) ? undefined : branchTaskOf(pull.head);
}

/** The events of each listener, in the order first seen (`pullListeners`); a follower gets its own copy, marked `followed`. */
export function eventsByRecipient(events: readonly PullEvent[], listenersOf: (pull: HostPull) => readonly PullListener[]): Map<string, PullEvent[]> {
  const byRecipient = new Map<string, PullEvent[]>();
  for (const event of events) {
    for (const { to, followed } of listenersOf(event.pull)) {
      byRecipient.set(to, [...(byRecipient.get(to) ?? []), followed ? { ...event, followed: true } : event]);
    }
  }
  return byRecipient;
}

/** The pull requests one inbox line names; the rest are counted. */
const NAMED_PULLS = 8;
/** How much of a pull request title an inbox line repeats. */
const TITLE_CHARS = 60;
/** How much of a CI job or step name an inbox line repeats. */
const JOB_CHARS = 40;

/** How each event reads in a line. */
const EVENT_WORDS: Readonly<Record<PullEventKind, string>> = {
  opened: 'opened',
  merged: 'merged',
  closed: 'closed unmerged',
  conflict: 'conflicts with its base',
  'checks-failing': 'checks failing',
  'checks-passing': 'checks passing',
  approved: 'approved',
  'changes-requested': 'changes requested',
};

/** One session's inbox line, and whether it wakes the session. */
export interface PullNews {
  readonly text: string;
  readonly wake: boolean;
}

/**
 * The inbox line for `events`, one entry per pull request in the order first seen, at most NAMED_PULLS named and
 * the rest counted. A title is outside input: quoted, as data, and cut short. Failing checks with an excerpt name
 * each failed job and step, quoted and cut the same way, and the file holding its log's end. It wakes the session only for what
 * needs its hand now (T3021 section 3): a conflict, failing checks or changes requested on a session's own pull
 * request (one of our authors' branch that names a task, `ownBranchTask`). The rest (a merge, a close, an approval,
 * checks passing, an outsider's conflict or red checks, which are the outsider's to fix, anything a follower hears,
 * and an outsider's new pull request, which is intake work for the watcher, githubWatcher, answered by its target, not
 * at once; waking the lead for each cost a full turn of its context) waits for the session's next turn. Anyone not
 * one of `ours` counts as an outsider, a collaborator too.
 */
export function pullNewsText(events: readonly PullEvent[], ours: OurLogins): PullNews {
  const byPull = new Map<string, { pull: HostPull; events: PullEvent[] }>();
  for (const event of events) {
    const key = issueRef(event.pull.repo, event.pull.number);
    const entry = byPull.get(key) ?? { pull: event.pull, events: [] };
    entry.events.push(event);
    byPull.set(key, entry);
  }
  const entries = [...byPull].map(([ref, { pull, events: own }]) => `${ref} ${JSON.stringify(cut(pull.title, TITLE_CHARS))}: ${own.map((event) => eventWords(event, ours)).join(', ')}`);
  const more = entries.length - NAMED_PULLS;
  return {
    text: `GitHub pull requests: ${entries.slice(0, NAMED_PULLS).join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
    wake: events.some(({ kind, pull, followed }) => followed !== true && wakes(kind, pull, ours)),
  };
}

/** Whether `kind` on `pull` wakes its recipient (pullNewsText). */
function wakes(kind: PullEventKind, pull: HostPull, ours: OurLogins): boolean {
  switch (kind) {
    case 'conflict':
    case 'checks-failing':
    case 'changes-requested':
      return ownBranchTask(pull, ours) !== undefined;
    case 'opened':
    case 'merged':
    case 'closed':
    case 'checks-passing':
    case 'approved':
      return false;
  }
}

function eventWords({ kind, pull, ci }: PullEvent, ours: OurLogins): string {
  if (kind === 'checks-failing' && ci !== undefined) {
    const jobs = ci.jobs.map(({ name, step }) => `${JSON.stringify(cut(name, JOB_CHARS))}${step === undefined ? '' : ` at ${JSON.stringify(cut(step, JOB_CHARS))}`}`);
    return `${EVENT_WORDS[kind]} (${jobs.join(', ')}; log end in ${ci.file})`;
  }
  if (kind !== 'opened') {
    return EVENT_WORDS[kind];
  }
  const by = pull.author === '' ? 'a deleted account' : pull.author;
  const where = [...(isOurAuthor(pull.authorAssociation, pull.author, ours) ? [] : ['outside']), ...(pull.fork ? ['fork'] : []), ...(pull.draft ? ['draft'] : [])];
  return `opened by ${by}${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
}
