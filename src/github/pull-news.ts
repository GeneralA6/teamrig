import type { HostPull, PullChecks, PullMergeable, PullReview } from '../issues/pull.ts';
import { cut } from '../register/views.ts';
import { branchTaskOf } from '../worktree/owner.ts';
import { issueRef } from './map.ts';
import { isInsideAuthor } from './trust.ts';

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
export type PullEventKind = 'opened' | 'merged' | 'closed' | 'conflict' | 'checks-failing' | 'approved' | 'changes-requested';

export interface PullEvent {
  readonly kind: PullEventKind;
  readonly pull: HostPull;
  /** For failing checks of a session's own pull request: the file its failed jobs' log ends went to (ci-excerpt.ts). */
  readonly ci?: CiExcerpt;
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
 * starts, never again while it lasts; GitHub's `unknown` mergeable (not worked out yet) keeps the last known value. A
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
 * branch of the repository itself by an author inside it, else `watcher`. A fork's branch name, or an outsider's,
 * is theirs to choose, so it never routes news to a session.
 */
export function pullRecipient(pull: HostPull, ownerOf: (task: string) => string | undefined, watcher: string): string {
  const task = ownBranchTask(pull);
  return (task === undefined ? undefined : ownerOf(task)) ?? watcher;
}

/** The task an inside author's own branch of the repository names (`t<id>-...`); undefined for a fork, an outsider or another branch name. */
export function ownBranchTask(pull: HostPull): string | undefined {
  return pull.fork || !isInsideAuthor(pull.authorAssociation) ? undefined : branchTaskOf(pull.head);
}

/** The events of each recipient, in the order first seen (`pullRecipient`). */
export function eventsByRecipient(events: readonly PullEvent[], recipientOf: (pull: HostPull) => string): Map<string, PullEvent[]> {
  const byRecipient = new Map<string, PullEvent[]>();
  for (const event of events) {
    const to = recipientOf(event.pull);
    byRecipient.set(to, [...(byRecipient.get(to) ?? []), event]);
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
 * needs its hand now (T3021 section 3): an outsider's new pull request, and a conflict or failing checks on a
 * session's own pull request (an inside author's branch that names a task). The rest (a merge, a close, a review, an
 * outsider's conflict or red checks, which are the outsider's to fix) waits for the session's next turn.
 */
export function pullNewsText(events: readonly PullEvent[]): PullNews {
  const byPull = new Map<string, { pull: HostPull; events: PullEvent[] }>();
  for (const event of events) {
    const key = issueRef(event.pull.repo, event.pull.number);
    const entry = byPull.get(key) ?? { pull: event.pull, events: [] };
    entry.events.push(event);
    byPull.set(key, entry);
  }
  const entries = [...byPull].map(([ref, { pull, events: own }]) => `${ref} ${JSON.stringify(cut(pull.title, TITLE_CHARS))}: ${own.map(eventWords).join(', ')}`);
  const more = entries.length - NAMED_PULLS;
  return {
    text: `GitHub pull requests: ${entries.slice(0, NAMED_PULLS).join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
    wake: events.some(({ kind, pull }) => wakes(kind, pull)),
  };
}

/** Whether `kind` on `pull` wakes its recipient (pullNewsText). */
function wakes(kind: PullEventKind, pull: HostPull): boolean {
  switch (kind) {
    case 'opened':
      return !isInsideAuthor(pull.authorAssociation);
    case 'conflict':
    case 'checks-failing':
      return ownBranchTask(pull) !== undefined;
    case 'merged':
    case 'closed':
    case 'approved':
    case 'changes-requested':
      return false;
  }
}

function eventWords({ kind, pull, ci }: PullEvent): string {
  if (kind === 'checks-failing' && ci !== undefined) {
    const jobs = ci.jobs.map(({ name, step }) => `${JSON.stringify(cut(name, JOB_CHARS))}${step === undefined ? '' : ` at ${JSON.stringify(cut(step, JOB_CHARS))}`}`);
    return `${EVENT_WORDS[kind]} (${jobs.join(', ')}; log end in ${ci.file})`;
  }
  if (kind !== 'opened') {
    return EVENT_WORDS[kind];
  }
  const by = pull.author === '' ? 'a deleted account' : pull.author;
  const where = [...(isInsideAuthor(pull.authorAssociation) ? [] : ['outside']), ...(pull.fork ? ['fork'] : []), ...(pull.draft ? ['draft'] : [])];
  return `opened by ${by}${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
}
