/**
 * The response clock on GitHub threads (T3021 section 4, slice E): how long an outsider has waited for an answer of
 * ours in words, against a target per kind of thread. Code keeps it at 0 tokens: at REMIND_SHARE of the target the
 * owning session gets one unwoken inbox line, at the target `teamrig check` raises GH-LATE for the lead. Pure: the
 * sync reads the threads and keeps the clocks in their own state file (src/cli/commands/gh-clock.ts).
 */

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
  /** `owner/name#number`. */
  readonly ref: string;
  readonly kind: ThreadKind;
  /** The session that answers it. */
  readonly owner: string;
  readonly posts: readonly ThreadPost[];
}

/** A running clock: the thread has waited since `since` for an answer of ours. */
export interface Clock {
  readonly ref: string;
  readonly kind: ThreadKind;
  readonly owner: string;
  readonly since: number;
  /** When its owner was reminded; undefined until then. */
  readonly remindedAt: number | undefined;
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

/** What one sync's read does to the clocks: the clocks kept, and those whose owner is reminded now. */
export interface ClockStep {
  readonly clocks: ReadonlyMap<string, Clock>;
  readonly remind: readonly Clock[];
}

/**
 * The clocks after a read of the repositories in `read`: each open thread waiting on us keeps its clock (and whether
 * it was reminded) while the wait it times is the same one, else starts a fresh one; a thread answered, closed or
 * gone stops its clock. A repository not read this time (it failed) keeps its clocks as they were. A clock past
 * REMIND_SHARE of its target that was never reminded is reminded now, once.
 */
export function stepClocks(before: ReadonlyMap<string, Clock>, read: ReadonlySet<string>, threads: readonly Thread[], now: number): ClockStep {
  const clocks = new Map([...before].filter(([ref]) => !read.has(repoOf(ref))));
  const remind: Clock[] = [];
  for (const thread of threads) {
    const since = waitingSince(thread.posts);
    if (since === undefined) {
      continue;
    }
    const kept = before.get(thread.ref);
    const remindedAt = kept?.since === since ? kept.remindedAt : undefined;
    const clock: Clock = { ref: thread.ref, kind: thread.kind, owner: thread.owner, since, remindedAt };
    if (clock.remindedAt === undefined && now - since >= targetMs(clock.kind) * REMIND_SHARE) {
      const reminded = { ...clock, remindedAt: now };
      remind.push(reminded);
      clocks.set(thread.ref, reminded);
    } else {
      clocks.set(thread.ref, clock);
    }
  }
  return { clocks, remind };
}

/** The `owner/name` of a thread ref `owner/name#number`. */
export function repoOf(ref: string): string {
  const hash = ref.lastIndexOf('#');
  return hash < 0 ? ref : ref.slice(0, hash);
}
