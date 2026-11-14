/**
 * A new branch's name from its task (T2690), by the team's pattern (`delivery.branches`), so every branch and the
 * worktree folder named after it read the same way: `feat/t12-parser` by default, after Conventional Branch. The task id
 * starts a part of the name, which is what tells whose branch it is (owner.ts `branchTaskOf`).
 */
/** A new branch's name, which also names its folder: from a letter or digit, then letters, digits, `.`, `_`, `-` and `/`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Why `branch` cannot name a new branch and its folder, or undefined when it can; git refuses what this lets through. */
export function branchNameProblem(branch) {
    const bad = !BRANCH_NAME.test(branch) || ['..', '//', '/.'].some((part) => branch.includes(part)) || ['/', '.', '.lock'].some((end) => branch.endsWith(end));
    return bad ? 'expected a branch name: letters, digits, ., _, - and /, from a letter or digit, without .., // or a part that starts with ., and not ending in /, . or .lock' : undefined;
}
/** The placeholders a pattern may use. */
export const BRANCH_PLACEHOLDERS = ['type', 'id', 'issue', 'slug', 'session'];
/** A branch type: a lowercase word, such as `feat`, `fix`, `docs`, `chore`, `refactor`, `hotfix` or `release`. */
const BRANCH_TYPE = /^[a-z][a-z0-9]*$/;
/** A placeholder in a pattern, such as `{slug}`. */
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** Whether `text` is a branch type `--type` and `delivery.branches.types` may give. */
export function isBranchType(text) {
    return BRANCH_TYPE.test(text);
}
function isPlaceholder(text) {
    return BRANCH_PLACEHOLDERS.some((name) => name === text);
}
/**
 * Why `pattern` cannot name branches, or undefined when it can: it uses only known placeholders, holds `{id}` once at
 * the start of a part (the start, or after a `/`) followed by `-`, `/` or its end, and filled with sample words makes
 * a branch name git takes.
 */
export function branchPatternProblem(pattern) {
    const names = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
    const unknown = names.find((name) => !isPlaceholder(name));
    if (unknown !== undefined) {
        return `{${unknown}} is no placeholder: use ${BRANCH_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`;
    }
    if (names.filter((name) => name === 'id').length !== 1) {
        return 'needs {id} exactly once: the task id tells whose branch it is';
    }
    if (!/(?:^|\/)\{id\}(?:[-/]|$)/.test(pattern)) {
        return '{id} must start the pattern or follow a /, and be followed by -, / or the end';
    }
    const sample = fill(pattern, { type: 'feat', id: 't1', issue: '1', slug: 'a-b', session: 's' });
    const problem = branchNameProblem(sample);
    return problem === undefined ? undefined : `makes no branch name (${sample}): ${problem}`;
}
/** The branch `pattern` names for `words`; refused when it uses a word the task lacks, or makes no branch name. */
export function branchNameFor(pattern, words) {
    const patternProblem = branchPatternProblem(pattern);
    if (patternProblem !== undefined) {
        return { kind: 'refused', reason: `the branch pattern ${pattern} ${patternProblem}` };
    }
    const missing = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').find((name) => isPlaceholder(name) && !words[name]);
    if (missing !== undefined) {
        return { kind: 'refused', reason: `the branch pattern ${pattern} names {${missing}}, which this task has none of: give a branch name instead` };
    }
    const branch = fill(pattern, words);
    const problem = branchNameProblem(branch);
    return problem === undefined ? { kind: 'name', branch } : { kind: 'refused', reason: `"${branch}": ${problem}` };
}
/**
 * The branch `teamrig worktree add --task` makes for `task`: its branch type is `type` when given, else its work class's
 * in `branches.classes`, else its item type's; the pattern is that branch type's own, else `branches.pattern`.
 */
export function taskBranchName(task, branches, type) {
    const branchType = type ?? branches.classes[task.workClass] ?? branches.itemTypes[task.itemType];
    const pattern = branches.typePatterns[branchType] ?? branches.pattern;
    return branchNameFor(pattern, {
        type: branchType,
        id: task.id.toLowerCase(),
        issue: issueNumberOf(task.ref),
        slug: slugOf(task.title, branches.slugMax),
        session: task.owner,
    });
}
/**
 * A title as a branch slug: lowercase letters and digits joined by `-`, task ids left out, cut at a `-` to at most
 * `max` characters; `work` when nothing is left.
 */
export function slugOf(title, max) {
    const words = title
        .replace(/\bT\d+\b/g, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== '');
    let slug = '';
    for (const word of words) {
        const next = slug === '' ? word : `${slug}-${word}`;
        if (next.length > max) {
            break;
        }
        slug = next;
    }
    return slug === '' ? (words[0]?.slice(0, max) ?? 'work') : slug;
}
/** The issue number of a task's `gh:<owner>/<repo>#<n>` ref; undefined for none. */
export function issueNumberOf(ref) {
    return ref === null ? undefined : /^gh:[^#\s]+#(\d+)$/.exec(ref)?.[1];
}
function fill(pattern, words) {
    return pattern.replace(PLACEHOLDER, (whole, name) => (isPlaceholder(name) ? (words[name] ?? '') : whole));
}
