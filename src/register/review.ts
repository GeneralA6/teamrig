import type { RegisterReviewConfig } from '../config/types.ts';
import { isRecord } from '../core/guards.ts';
import { CARD_MIN_WORDS, namedTaskIds, plainWords } from './card.ts';
import type { Task } from './fold.ts';
import { itemTypeOf, traitsOf } from './item-types.ts';
import type { TaskStatus } from './model.ts';

/**
 * A bug's review (T916): beside the fix, how the bug came about, what stops it coming back and how it
 * was missed, so the next one is caught sooner. Each part is given with its own `set` flag and kept across sets, a
 * later one replacing it (fold.ts); an empty review is a task no one has reviewed yet.
 */
export interface ProblemReview {
  /** The root cause, at its source: a file and line, a config key, a data row. */
  readonly cause?: string;
  /** How it happened: the change, decision or assumption that let the cause in, and when. */
  readonly how?: string;
  /** What now stops it coming back: a guard, test, type, check or rule. */
  readonly prevent?: string;
  /** Asked of a critical problem only: hardening past the direct guard, or why none fits. */
  readonly harden?: string;
  /** The test before merge that should have caught it: a follow-up task, or why no test can. */
  readonly missedTest?: string;
  /** The monitor or alert at run time that should have fired: a follow-up task, or why none can. */
  readonly missedMonitor?: string;
  /** The log line that should have shown it and let it be traced: a follow-up task, or why none can. */
  readonly missedLog?: string;
}

export type ReviewPart = keyof ProblemReview;

/** Every part, in the order a review prints and a refusal names them. */
export const REVIEW_ORDER: readonly ReviewPart[] = ['cause', 'how', 'prevent', 'harden', 'missedTest', 'missedMonitor', 'missedLog'];

/** The `set` flag that gives each part. */
export const REVIEW_FLAGS: Readonly<Record<ReviewPart, string>> = {
  cause: '--cause',
  how: '--how',
  prevent: '--prevent',
  harden: '--harden',
  missedTest: '--missed-test',
  missedMonitor: '--missed-monitor',
  missedLog: '--missed-log',
};

/** How `show` labels each part. */
const REVIEW_LABELS: Readonly<Record<ReviewPart, string>> = {
  cause: 'cause',
  how: 'how it happened',
  prevent: 'prevented by',
  harden: 'hardened by',
  missedTest: 'missed by test',
  missedMonitor: 'missed by monitor',
  missedLog: 'missed by log',
};

/** The parts that say how the problem was missed: each names a follow-up task or why that kind cannot catch it. */
const MISSED_PARTS: readonly ReviewPart[] = ['missedTest', 'missedMonitor', 'missedLog'];

/** The parts a bug's review needs: every one but `harden`, which only a critical bug needs too. */
export function requiredParts(critical: boolean): ReviewPart[] {
  return REVIEW_ORDER.filter((part) => critical || part !== 'harden');
}

/** The parts the review still lacks, in print order. */
export function missingParts(review: ProblemReview, critical: boolean): ReviewPart[] {
  return requiredParts(critical).filter((part) => review[part] === undefined);
}

/** Whether an item gives the problem review: its type has one (item-types.ts), as a bug does. */
export function asksReview(task: Pick<Task, 'type'>): boolean {
  return traitsOf(task).review;
}

/** Whether an item that gives the review is critical, and so asked `--harden` too: marked `--critical`, or owned by one of `criticalOwners`. */
export function isCritical(task: Pick<Task, 'type' | 'critical' | 'owner'>, criticalOwners: readonly string[]): boolean {
  return asksReview(task) && (task.critical || criticalOwners.includes(task.owner));
}

/**
 * The review parts a task still lacks to reach `status` once `given` is added to its review: none when its type gives
 * no review, the status is not one `requireOn` lists, or the review is `off`.
 */
export function reviewGap(task: Pick<Task, 'type' | 'critical' | 'owner' | 'review'>, status: TaskStatus, given: ProblemReview, config: RegisterReviewConfig): ReviewPart[] {
  if (config.mode === 'off' || !asksReview(task) || !config.requireOn.includes(status)) {
    return [];
  }
  return missingParts({ ...task.review, ...given }, isCritical(task, config.criticalOwners));
}

/** What a task whose type gives the review lacks to reach `status`, naming the flags that give it, for a refusal or a warning. */
export function reviewGapText(task: Pick<Task, 'id' | 'type'>, status: TaskStatus, missing: readonly ReviewPart[]): string {
  return `${task.id} is a ${itemTypeOf(task)}: ${status} needs its review, ${partFlags(missing)} (how it happened, what stops it and how it was missed; teamrig help set)`;
}

/** The flags that give `parts`, as one phrase: `--cause, --how and --missed-log`. */
export function partFlags(parts: readonly ReviewPart[]): string {
  const flags = parts.map((part) => REVIEW_FLAGS[part]);
  const last = flags.pop();
  return last === undefined ? '' : flags.length === 0 ? last : `${flags.join(', ')} and ${last}`;
}

/**
 * Why the parts given cannot be written, or undefined: each says at least CARD_MIN_WORDS plain words besides task
 * ids, as a card's parts do, so a bare `T124` is refused and a follow-up says what it adds.
 */
export function reviewProblem(given: ProblemReview): string | undefined {
  for (const part of REVIEW_ORDER) {
    const text = given[part];
    if (text !== undefined && plainWords(text) < CARD_MIN_WORDS) {
      return `${REVIEW_FLAGS[part]} says "${text}": give at least ${CARD_MIN_WORDS} plain words besides task ids, so it reads without the task list`;
    }
  }
  return undefined;
}

/** The task ids the missed parts name: the follow-ups that add the test, monitor or log that was missing. */
export function missedTaskIds(review: ProblemReview): string[] {
  return namedTaskIds(MISSED_PARTS.flatMap((part) => review[part] ?? []));
}

/** The parts given, as [flag, text] pairs in print order, for the checks every stored text passes. */
export function reviewTexts(review: ProblemReview): [string, string][] {
  return REVIEW_ORDER.flatMap((part): [string, string][] => {
    const text = review[part];
    return text === undefined ? [] : [[REVIEW_FLAGS[part], text]];
  });
}

/** The review as `show` prints it: a line per part given, each led by `indent`. */
export function reviewLines(review: ProblemReview, indent: string): string[] {
  return REVIEW_ORDER.flatMap((part) => {
    const text = review[part];
    return text === undefined ? [] : [`${indent}${REVIEW_LABELS[part]}: ${text}`];
  });
}

/** The parts a status line gave, by flag name, as its history line prints them: `cause,how,missed-test`. */
export function reviewPartNames(review: ProblemReview): string {
  return reviewTexts(review)
    .map(([flag]) => flag.slice(2))
    .join(',');
}

/**
 * A status line's review: undefined when absent or null, else the parts it gives, or the reason it is not a review.
 * A part this teamrig does not know is a newer one's and is skipped; what a part must say is judged on write.
 */
export function parseReview(value: unknown): ProblemReview | undefined | string {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return 'review is not an object';
  }
  const review: { -readonly [K in ReviewPart]?: string } = {};
  for (const part of REVIEW_ORDER) {
    const text = value[part];
    if (text === undefined || text === null) {
      continue;
    }
    if (typeof text !== 'string') {
      return `review ${part} is not text`;
    }
    review[part] = text;
  }
  return review;
}
