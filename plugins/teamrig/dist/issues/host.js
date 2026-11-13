/**
 * The issue host port: where a team's issues and pull requests live, behind names that hold for any host. teamrig
 * writes to a host only through this port, and each host (GitHub is the only one so far, src/github/host.ts) is an
 * adapter that keeps its own access rules. A repository reaches a host only when the team config lists it there.
 */
/** `owner/name#number`, as a command takes and prints it: a name is never `.` or `..` alone. */
const TARGET_TEXT = /^([A-Za-z0-9-]+\/(?!\.\.?#)[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/u;
/** The issue or pull request `text` names as `owner/name#number`, or undefined when it names none. */
export function parseIssueTarget(text) {
    const match = TARGET_TEXT.exec(text.trim());
    const repo = match?.[1];
    const number = match?.[2];
    return repo === undefined || number === undefined ? undefined : { repo: repo.toLowerCase(), number: Number(number) };
}
/** `owner/name#number`. */
export function targetText(target) {
    return `${target.repo}#${target.number}`;
}
/** The host whose config list names `repo`, or undefined when none does. */
export function hostKindOf(repo, lists) {
    return lists.github.repos.includes(repo) ? 'github' : undefined;
}
