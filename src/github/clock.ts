/**
 * The response clock on GitHub threads (T3021 section 4, slice E): how long an outsider has waited for an answer of
 * ours in words, against a target per kind of thread. Code keeps it at 0 tokens: at REMIND_SHARE of the target the
 * owning session gets one unwoken inbox line, at the target an unwoken GH-LATE line, and `teamrig check` raises
 * GH-LATE for the lead a second window later (leadTurnAt), or at the target when the owner is told nothing. Pure: the
 * sync reads the threads and keeps the clocks in their own state file (src/cli/commands/issue-clock.ts).
 */

import { isRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';
import type { HostIssue, IssueComment } from '../issues/issue.ts';
import type { HostPull } from '../issues/pull.ts';
import { isInsideAuthor, isOurAuthor, type OurLogins } from './trust.ts';

/** The kinds of thread, each with its own answer target. */
export const THREAD_KINDS = ['security', 'bug', 'pull', 'comment', 'feature'] as const;

export type ThreadKind = (typeof THREAD_KINDS)[number];

const HOUR_MS = 3_600_000;

/**
 * How long each kind may wait for an answer in words (the design's table): a security report 4 h, a bug from outside,
 * a contributor's pull request and a comment on a thread we hold 24 h, a feature ask or a question 72 h.
 */
export const ANSWER_TARGET_HOURS: Readonly<Record<ThreadKind, number>> = { security: 4, bug: 24, pull: 24, comment: 24, feature: 72 };

/** The share of its target a thread waits before its owner is reminded, once. */
export const REMIND_SHARE = 0.75;

/** One post on a thread, its opening post too: when, and whether we wrote it. A bot's post is none: it neither starts nor stops a clock. */
export interface ThreadPost {
  readonly at: number;
  readonly ours: boolean;
}

/** An open thread as one read saw it. */
export interface Thread {
  /** `owner/name`. */
  readonly repo: string;
  /** As the task list names it (github/map.ts issueRef). */
  readonly ref: string;
  readonly kind: ThreadKind;
  /** The session that answers it. */
  readonly owner: string;
  readonly posts: readonly ThreadPost[];
}

/** A running clock: the thread has waited since `since` for an answer of ours. */
export interface Clock {
  readonly repo: string;
  readonly ref: string;
  readonly kind: ThreadKind;
  readonly owner: string;
  readonly since: number;
  /** When its owner was reminded; undefined until then. */
  readonly remindedAt: number | undefined;
  /** When its owner was told GH-LATE at the target; undefined until then, and always for an owner not told first. */
  readonly toldAt: number | undefined;
}

/**
 * Whether a thread's owner is told GH-LATE at the target before the lead is (#1507): a session of the team other
 * than the lead. The lead's own threads, and those of an owner off the team, go to the lead at the target.
 */
export type OwnerFirst = (owner: string) => boolean;

export function ownerFirstOf(sessions: readonly string[], lead: string): OwnerFirst {
  const first = new Set(sessions.filter((id) => id !== lead));
  return (owner) => first.has(owner);
}

/** The longest the lead waits after a thread's owner was told GH-LATE; shorter targets wait their own length. */
export const LEAD_WINDOW_MAX_HOURS = 24;

/**
 * When `teamrig check` shows the lead GH-LATE: at the target for an owner not told first, else a second window
 * after the owner was told (from the target while not told yet), as long as the target and at most
 * LEAD_WINDOW_MAX_HOURS: a security report 8 h in all, a bug 48 h, a feature ask 96 h.
 */
export function leadTurnAt(clock: Pick<Clock, 'kind' | 'owner' | 'since' | 'toldAt'>, ownerFirst: OwnerFirst): number {
  const target = clock.since + targetMs(clock.kind);
  return ownerFirst(clock.owner) ? (clock.toldAt ?? target) + Math.min(targetMs(clock.kind), LEAD_WINDOW_MAX_HOURS * HOUR_MS) : target;
}

/**
 * When the thread started waiting on us: its oldest outside post after our newest one, or undefined when we spoke
 * last or no outsider posted. The oldest, not the newest: a "any news?" follow-up must not restart the wait.
 */
export function waitingSince(posts: readonly ThreadPost[]): number | undefined {
  const ordered = [...posts].sort((a, b) => a.at - b.at);
  const lastOurs = ordered.findLastIndex((post) => post.ours);
  return ordered.slice(lastOurs + 1).find((post) => !post.ours)?.at;
}

/** A clock's target in milliseconds. */
export function targetMs(kind: ThreadKind): number {
  return ANSWER_TARGET_HOURS[kind] * HOUR_MS;
}

/** Whether a clock passed its target at `now`. */
export function isLate(clock: Pick<Clock, 'kind' | 'since'>, now: number): boolean {
  return now - clock.since >= targetMs(clock.kind);
}

/** What one sync's read does to the clocks: the clocks kept, those whose owner is reminded now, and those whose owner is told GH-LATE now. */
export interface ClockStep {
  readonly clocks: ReadonlyMap<string, Clock>;
  readonly remind: readonly Clock[];
  readonly tell: readonly Clock[];
}

/**
 * The clocks after a read of the repositories in `read`: each open thread waiting on us keeps its clock (and whether
 * its owner was reminded and told) while the wait it times and its owner are the same, else starts a fresh one; a thread
 * answered, closed or gone stops its clock. A repository not read this time (it failed) keeps its clocks as they
 * were. A clock past its target whose owner is told first (`ownerFirst`) and was not told yet is told now, once,
 * with no reminder; else a clock past REMIND_SHARE of its target that was never reminded is reminded now, once.
 */
export function stepClocks(before: ReadonlyMap<string, Clock>, read: ReadonlySet<string>, threads: readonly Thread[], now: number, ownerFirst: OwnerFirst): ClockStep {
  const clocks = new Map([...before].filter(([, clock]) => !read.has(clock.repo)));
  const remind: Clock[] = [];
  const tell: Clock[] = [];
  for (const thread of threads) {
    const since = waitingSince(thread.posts);
    if (since === undefined) {
      continue;
    }
    // A reminder or GH-LATE went to the owner then: one who takes the thread over mid-wait was told nothing yet.
    const last = before.get(thread.ref);
    const kept = last?.since === since && last.owner === thread.owner ? last : undefined;
    let clock: Clock = { repo: thread.repo, ref: thread.ref, kind: thread.kind, owner: thread.owner, since, remindedAt: kept?.remindedAt, toldAt: kept?.toldAt };
    if (clock.toldAt === undefined && ownerFirst(clock.owner) && isLate(clock, now)) {
      clock = { ...clock, remindedAt: clock.remindedAt ?? now, toldAt: now };
      tell.push(clock);
    } else if (clock.remindedAt === undefined && now - since >= targetMs(clock.kind) * REMIND_SHARE) {
      clock = { ...clock, remindedAt: now };
      remind.push(clock);
    }
    clocks.set(thread.ref, clock);
  }
  return { clocks, remind, tell };
}

/**
 * An open issue as a thread: its opening post and its comments read, a bot's left out, each ours by postIsOurs; `owner`
 * answers it. Its kind by label (`security`, then `bug`, matched without case), else a comment on a thread we hold
 * (`held`: a task of ours tracks it), else a feature ask or question. Undefined for a closed one.
 */
export function issueThread(issue: HostIssue, ref: string, owner: string, held: boolean, ours: OurLogins): Thread | undefined {
  if (issue.state !== 'open') {
    return undefined;
  }
  const opening = issue.createdAt === undefined ? [] : [{ at: issue.createdAt, login: issue.author, authorAssociation: issue.authorAssociation, authorKind: issue.authorKind }];
  return { repo: issue.repo, ref, kind: issueKind(issue.labels, held), owner, posts: threadPosts([...opening, ...issue.comments], ours) };
}

/**
 * An open pull request as a `pull` thread: its opening and its comments and reviews read, a bot's left out, each ours
 * by postIsOurs, as on an issue; `owner` answers it. Undefined for a merged or closed one, and for a draft: it asks
 * nobody to look yet, so its wait starts once it is marked ready.
 */
export function pullThread(pull: HostPull, ref: string, owner: string, ours: OurLogins): Thread | undefined {
  if (pull.state !== 'open' || pull.draft) {
    return undefined;
  }
  const opening = { at: pull.createdAt, login: pull.author, authorAssociation: pull.authorAssociation, authorKind: pull.authorKind };
  return { repo: pull.repo, ref, kind: 'pull', owner, posts: threadPosts([opening, ...pull.posts], ours) };
}

/**
 * Whether a post is the team's answer. With `github.owners` naming the team's people, only their logins and the
 * repository's owner answer (isOurAuthor): an outside contributor given collaborator access still waits on us, and
 * their follow-up is no answer. A team that named no one falls back to the author's tie to the repository
 * (isInsideAuthor).
 */
export function postIsOurs(association: string, login: string, ours: OurLogins): boolean {
  return ours.size === 0 ? isInsideAuthor(association) : isOurAuthor(association, login, ours);
}

/** An app's or a workflow's account kind: its posts are no one's answer and no one's ask. */
const BOT = 'Bot';

/** A thread's posts with a bot's left out, each ours by postIsOurs. */
function threadPosts(posts: readonly IssueComment[], ours: OurLogins): ThreadPost[] {
  return posts.filter((post) => post.authorKind !== BOT).map((post) => ({ at: Date.parse(post.at), ours: postIsOurs(post.authorAssociation, post.login, ours) }));
}

function issueKind(labels: readonly string[], held: boolean): ThreadKind {
  const has = (name: string): boolean => labels.some((label) => label.toLowerCase() === name);
  if (has('security')) {
    return 'security';
  }
  if (has('bug')) {
    return 'bug';
  }
  return held ? 'comment' : 'feature';
}

/**
 * The format of the clocks file this code writes: 2 added `toldAt` (#1507); 1 is still read, as told nothing. A file
 * in a newer format, or damaged, reads as no clock running; a write refuses a newer one (src/cli/commands/issue-clock.ts).
 */
export const CLOCK_STATE_FORMAT = 2;

/** The clocks a file holds by ref; a damaged entry is left out, a damaged file reads as none. */
export function parseClocks(text: string): Map<string, Clock> {
  const record = parseObject(text.trim());
  const format = record?.[VERSION_FIELD];
  const list = format === 1 || format === CLOCK_STATE_FORMAT ? record?.['clocks'] : undefined;
  const clocks = Array.isArray(list) ? list.flatMap((value: unknown) => clockOf(value, format === CLOCK_STATE_FORMAT)) : [];
  return new Map(clocks.map((clock) => [clock.ref, clock]));
}

function clockOf(value: unknown, readsTold: boolean): Clock[] {
  if (!isRecord(value)) {
    return [];
  }
  const { repo, ref, kind, owner, since, remindedAt, toldAt } = value;
  const time = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at);
  if (typeof repo !== 'string' || typeof ref !== 'string' || typeof owner !== 'string' || !isThreadKind(kind) || !time(since)) {
    return [];
  }
  return [{ repo, ref, kind, owner, since, remindedAt: time(remindedAt) ? remindedAt : undefined, toldAt: readsTold && time(toldAt) ? toldAt : undefined }];
}

function isThreadKind(value: unknown): value is ThreadKind {
  return THREAD_KINDS.some((kind) => kind === value);
}

export function formatClocks(clocks: ReadonlyMap<string, Clock>): string {
  return toJsonlLine({
    [VERSION_FIELD]: CLOCK_STATE_FORMAT,
    clocks: [...clocks.values()].map(({ repo, ref, kind, owner, since, remindedAt, toldAt }) => ({
      repo,
      ref,
      kind,
      owner,
      since,
      ...(remindedAt === undefined ? {} : { remindedAt }),
      ...(toldAt === undefined ? {} : { toldAt }),
    })),
  });
}

/** How long a clock has run, in whole hours. */
function waitedHours(clock: Pick<Clock, 'since'>, now: number): number {
  return Math.floor((now - clock.since) / HOUR_MS);
}

/** The owner's unwoken reminder at REMIND_SHARE of the target. */
export function reminderText(clock: Clock, now: number, zone: TimeZone, ownerFirst: OwnerFirst): string {
  const due = new Date(clock.since + targetMs(clock.kind));
  const after = ownerFirst(clock.owner) ? `GH-LATE goes to you, and to the lead from ${zone.shortMinute(new Date(leadTurnAt(clock, ownerFirst)))}` : 'GH-LATE goes to the lead';
  return (
    `GitHub ${clock.ref} (${clock.kind}) has waited ${waitedHours(clock, now)} h for an answer of ours, since ${zone.shortMinute(new Date(clock.since))}; ` +
    `answer it in words on GitHub by ${zone.shortMinute(due)}, its ${ANSWER_TARGET_HOURS[clock.kind]} h target, or ${after}`
  );
}

/** The owner's unwoken GH-LATE line at the target, saying by when the lead is told. */
export function toldText(clock: Clock, now: number, zone: TimeZone, ownerFirst: OwnerFirst): string {
  return (
    `GH-LATE ${clock.ref} (${clock.kind}) has waited ${waitedHours(clock, now)} h for an answer of ours since ${zone.shortMinute(new Date(clock.since))}, ` +
    `past its ${ANSWER_TARGET_HOURS[clock.kind]} h target: answer it in words on GitHub by ${zone.shortMinute(new Date(leadTurnAt(clock, ownerFirst)))}, or it goes to the lead`
  );
}

/** The lead's GH-LATE line for a clock at the lead's turn, saying when its owner was told, if it was. */
export function lateText(clock: Clock, now: number, zone: TimeZone): string {
  const told = clock.toldAt === undefined ? '' : `; ${clock.owner} was told at ${zone.shortMinute(new Date(clock.toldAt))}`;
  return (
    `GH-LATE ${clock.ref} (${clock.kind}, ${clock.owner}) has waited ${waitedHours(clock, now)} h for an answer of ours since ` +
    `${zone.shortMinute(new Date(clock.since))}, past its ${ANSWER_TARGET_HOURS[clock.kind]} h target${told}: have ${clock.owner} answer it on GitHub`
  );
}

/** How many refs a grouped line names before it gives the rest as a count (#1475). */
const GROUPED_REFS = 3;

/** When a clock's answer target falls. */
export function dueAt(clock: Pick<Clock, 'kind' | 'since'>): number {
  return clock.since + targetMs(clock.kind);
}

/** The first GROUPED_REFS of `clocks` as `named` words them, and ` and N more` for the rest. */
function namedRefs(clocks: readonly Clock[], named: (clock: Clock) => string): string {
  const more = clocks.length - GROUPED_REFS;
  return `${clocks.slice(0, GROUPED_REFS).map(named).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * One owner's reminders of one sync as one unwoken line (#1475): a thread alone as `reminderText` words it, several
 * as their count and the first few by when each falls due, so many open threads never flood the owner's inbox.
 */
export function remindersText(clocks: readonly Clock[], now: number, zone: TimeZone, ownerFirst: OwnerFirst): string {
  const [only] = clocks;
  if (only !== undefined && clocks.length === 1) {
    return reminderText(only, now, zone, ownerFirst);
  }
  const byDue = [...clocks].sort((a, b) => dueAt(a) - dueAt(b));
  const after = only !== undefined && ownerFirst(only.owner) ? 'GH-LATE goes to you, and to the lead a second window later' : 'GH-LATE goes to the lead';
  return (
    `${clocks.length} GitHub threads wait for an answer of ours: ${namedRefs(byDue, (clock) => `${clock.ref} (${clock.kind}, by ${zone.shortMinute(new Date(dueAt(clock)))})`)}; ` +
    `answer each in words on GitHub by its target, or ${after}`
  );
}

/**
 * One owner's GH-LATE lines of one sync as one unwoken line, as `remindersText` groups reminders (#1475): a thread
 * alone as `toldText` words it, several as their count and the first few by when each goes to the lead.
 */
export function toldsText(clocks: readonly Clock[], now: number, zone: TimeZone, ownerFirst: OwnerFirst): string {
  const [only] = clocks;
  if (only !== undefined && clocks.length === 1) {
    return toldText(only, now, zone, ownerFirst);
  }
  const turn = (clock: Clock): number => leadTurnAt(clock, ownerFirst);
  const byTurn = [...clocks].sort((a, b) => turn(a) - turn(b));
  return (
    `GH-LATE ${clocks.length} GitHub threads waited past their answer target for an answer of ours: ` +
    `${namedRefs(byTurn, (clock) => `${clock.ref} (${clock.kind}, by ${zone.shortMinute(new Date(turn(clock)))})`)}; answer each in words on GitHub by then, or it goes to the lead`
  );
}

/** The lead's one GH-LATE line for every late clock (#1475): one as `lateText` words it, several as their count and the oldest few. */
export function lateGroupText(clocks: readonly Clock[], now: number, zone: TimeZone): string {
  const [only] = clocks;
  if (only !== undefined && clocks.length === 1) {
    return lateText(only, now, zone);
  }
  const oldest = [...clocks].sort((a, b) => a.since - b.since);
  return (
    `GH-LATE ${clocks.length} GitHub threads waited past their answer target for an answer of ours, oldest first: ` +
    `${namedRefs(oldest, (clock) => `${clock.ref} (${clock.kind}, ${clock.owner}, ${waitedHours(clock, now)} h)`)}: have their owners answer them on GitHub`
  );
}

/**
 * The late clock that came to the lead last, by `turnAt` (the lead's turn, leadTurnAt, #1507): a grouped GH-LATE is
 * told again only when a newer wait goes late (#1475).
 */
export function newestLate(clocks: readonly Clock[], turnAt: (clock: Clock) => number): Clock | undefined {
  return clocks.reduce<Clock | undefined>((newest, clock) => (newest === undefined || turnAt(clock) > turnAt(newest) ? clock : newest), undefined);
}
