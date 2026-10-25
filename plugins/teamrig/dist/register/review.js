import { isRecord } from "../core/guards.js";
import { CARD_MIN_WORDS, namedTaskIds, plainWords } from "./card.js";
/** Every part, in the order a review prints and a refusal names them. */
export const REVIEW_ORDER = ['cause', 'how', 'prevent', 'harden', 'missedTest', 'missedMonitor', 'missedLog'];
/** The `set` flag that gives each part. */
export const REVIEW_FLAGS = {
    cause: '--cause',
    how: '--how',
    prevent: '--prevent',
    harden: '--harden',
    missedTest: '--missed-test',
    missedMonitor: '--missed-monitor',
    missedLog: '--missed-log',
};
/** How `show` labels each part. */
const REVIEW_LABELS = {
    cause: 'cause',
    how: 'how it happened',
    prevent: 'prevented by',
    harden: 'hardened by',
    missedTest: 'missed by test',
    missedMonitor: 'missed by monitor',
    missedLog: 'missed by log',
};
/** The parts that say how the problem was missed: each names a follow-up task or why that kind cannot catch it. */
const MISSED_PARTS = ['missedTest', 'missedMonitor', 'missedLog'];
/** The parts a problem's review needs: every one but `harden`, which only a critical problem needs too. */
export function requiredParts(critical) {
    return REVIEW_ORDER.filter((part) => critical || part !== 'harden');
}
/** The parts the review still lacks, in print order. */
export function missingParts(review, critical) {
    return requiredParts(critical).filter((part) => review[part] === undefined);
}
/** Whether a task is a problem whose review is asked: marked `--problem problem` or `--problem critical`. */
export function isProblem(task) {
    return task.kind === 'problem' || task.kind === 'critical';
}
/** Whether a problem is critical, and so asked `--harden` too: marked so, or owned by one of `criticalOwners`. */
export function isCritical(task, criticalOwners) {
    return task.kind === 'critical' || (task.kind === 'problem' && criticalOwners.includes(task.owner));
}
/**
 * The review parts a task still lacks to reach `status` once `given` is added to its review: none when it is not a
 * problem, the status is not one `requireOn` lists, or the review is `off`.
 */
export function reviewGap(task, status, given, config) {
    if (config.mode === 'off' || !isProblem(task) || !config.requireOn.includes(status)) {
        return [];
    }
    return missingParts({ ...task.review, ...given }, isCritical(task, config.criticalOwners));
}
/** What a problem task lacks to reach `status`, naming the flags that give it, for a refusal or a warning. */
export function reviewGapText(task, status, missing) {
    return `${task.id} is a problem: ${status} needs its review, ${partFlags(missing)} (how it happened, what stops it and how it was missed; teamrig help set)`;
}
/** The flags that give `parts`, as one phrase: `--cause, --how and --missed-log`. */
export function partFlags(parts) {
    const flags = parts.map((part) => REVIEW_FLAGS[part]);
    const last = flags.pop();
    return last === undefined ? '' : flags.length === 0 ? last : `${flags.join(', ')} and ${last}`;
}
/**
 * Why the parts given cannot be written, or undefined: each says at least CARD_MIN_WORDS plain words besides task
 * ids, as a card's parts do, so a bare `T124` is refused and a follow-up says what it adds.
 */
export function reviewProblem(given) {
    for (const part of REVIEW_ORDER) {
        const text = given[part];
        if (text !== undefined && plainWords(text) < CARD_MIN_WORDS) {
            return `${REVIEW_FLAGS[part]} says "${text}": give at least ${CARD_MIN_WORDS} plain words besides task ids, so it reads without the task list`;
        }
    }
    return undefined;
}
/** The task ids the missed parts name: the follow-ups that add the test, monitor or log that was missing. */
export function missedTaskIds(review) {
    return namedTaskIds(MISSED_PARTS.flatMap((part) => review[part] ?? []));
}
/** The parts given, as [flag, text] pairs in print order, for the checks every stored text passes. */
export function reviewTexts(review) {
    return REVIEW_ORDER.flatMap((part) => {
        const text = review[part];
        return text === undefined ? [] : [[REVIEW_FLAGS[part], text]];
    });
}
/** The review as `show` prints it: a line per part given, each led by `indent`. */
export function reviewLines(review, indent) {
    return REVIEW_ORDER.flatMap((part) => {
        const text = review[part];
        return text === undefined ? [] : [`${indent}${REVIEW_LABELS[part]}: ${text}`];
    });
}
/** The parts a status line gave, by flag name, as its history line prints them: `cause,how,missed-test`. */
export function reviewPartNames(review) {
    return reviewTexts(review)
        .map(([flag]) => flag.slice(2))
        .join(',');
}
/**
 * A status line's review: undefined when absent or null, else the parts it gives, or the reason it is not a review.
 * A part this teamrig does not know is a newer one's and is skipped; what a part must say is judged on write.
 */
export function parseReview(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return 'review is not an object';
    }
    const review = {};
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
