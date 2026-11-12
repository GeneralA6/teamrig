import { ID_PATTERN } from "../core/ids.js";
/**
 * Task states. The first four are active: the task still needs its owner. `verifying` is a change that has
 * shipped and waits for what proves it (a test run, a night's flow, a number), named by its `--proof`; it may also
 * carry what that proof waits for, typed (waits.ts). `waiting` cannot go on until each of its typed reasons clears.
 */
export const TASK_STATUSES = ['open', 'in-progress', 'verifying', 'waiting', 'done', 'dropped'];
export const ACTIVE_STATUSES = ['open', 'in-progress', 'verifying', 'waiting'];
/** The statuses a change may name the task's follow-ups with (`set --followups`): shipping, finishing or dropping it. */
export const FOLLOWUP_STATUSES = ['verifying', 'done', 'dropped'];
/** The statuses a bug's review may be asked at (`register.review.requireOn`): never dropped, whose note says why. */
export const REVIEW_STATUSES = ['verifying', 'done'];
/**
 * The statuses that carry typed wait reasons (waits.ts): `waiting` needs at least one; `verifying` may name what its
 * proof waits for (the task asked of whoever runs the proof, the time it comes, the owner's approval), so the party
 * that holds the proof has it on its own list and the owner is not asked to verify what it cannot yet.
 */
export const WAIT_STATUSES = ['waiting', 'verifying'];
/**
 * The status `waiting` replaced in teamrig 0.10.0. A line that names it reads as `waiting` with no reasons and is
 * never rewritten; the CLI and the config refuse it, naming `waiting`.
 */
export const LEGACY_WAITING_STATUS = 'blocked';
/** What a refusal of the old status starts with. */
export const LEGACY_WAITING_HINT = `${LEGACY_WAITING_STATUS} was replaced by waiting`;
export function isTaskStatus(value) {
    return TASK_STATUSES.some((status) => status === value);
}
/** Session and area names: the shared id rule, as they name inbox files and folders. */
export const SESSION_NAME = ID_PATTERN;
/**
 * The source of a task imported from a GitHub issue: only `teamrig gh sync` writes one (github/sync.ts),
 * and a session cannot give it to a task (policy.ts). Kept here, with the register's other names, so the
 * read side (views.ts, and the pane's copy of it) needs no write policy.
 */
export const GITHUB_SOURCE = 'github';
/** A priority as the CLI prints and takes it: `p1`, the most urgent, `p2` and so on. */
export function priorityText(priority) {
    return `p${priority}`;
}
/**
 * How a work class is spelled (`Roadmap`, `Tech debt`; T2076): a letter, then up to 31 letters, digits, spaces, `_` or
 * `-`. Kept here so the register's parse and the config's `focus.classes` share it.
 */
export const WORK_CLASS_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;
/** Whether a priority is at the top: `p1`, or a `p0` above it, so an urgent task never falls out of a top count. */
export function isTopPriority(priority) {
    return priority <= 1;
}
/** Task ids are `T` and a positive integer, allocated in order by the register. */
export const TASK_ID = /^T[1-9]\d*$/;
