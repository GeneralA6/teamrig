/**
 * A task's issue ref, `gh:<owner>/<name>#<number>`, read and written here only. Whether a ref is one at all is
 * `isIssueRef` (register/model.ts, which the write policy needs and which cannot import this folder); everything past
 * the prefix is here, so the shape of a ref has one place to change when a second tracker brings its own.
 */
import { ISSUE_REF_PREFIX, isIssueRef } from "../register/model.js";
import { parseIssueTarget, targetText } from "./host.js";
/** `<owner>/<name>#<number>` as a branch reads it: looser than a command's target, as it only takes the number. */
const NUMBERED = /^[^#\s]+#(\d+)$/;
/** The issue or pull request a ref names, or undefined when it is no issue ref or names none. */
export function parseRef(ref) {
    return isIssueRef(ref) ? parseIssueTarget(bareRef(ref)) : undefined;
}
/** The ref of an issue or pull request: one per item, whatever its title or state. */
export function refOf(target) {
    return `${ISSUE_REF_PREFIX}${targetText(target)}`;
}
/** A ref as a person reads and types it, `owner/name#number`: its prefix taken off; any other text as it is. */
export function bareRef(text) {
    return isIssueRef(text) ? text.slice(ISSUE_REF_PREFIX.length) : text;
}
/** The issue number a ref gives a branch name (`{issue}` in `delivery.branches`); undefined for none. */
export function branchHint(ref) {
    return isIssueRef(ref) ? NUMBERED.exec(bareRef(ref))?.[1] : undefined;
}
