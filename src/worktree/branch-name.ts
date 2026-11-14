import type { BranchesConfig } from '../config/types.ts';
import type { ItemType } from '../register/events.ts';

/**
 * A new branch's name from its task (T2690), by the team's pattern (`delivery.branches`), so every branch and the
 * worktree folder named after it read the same way: `feat/t12-parser` by default, after Conventional Branch. The task id
 * starts a part of the name, which is what tells whose branch it is (owner.ts `branchTaskOf`).
 */

/** A new branch's name, which also names its folder: from a letter or digit, then letters, digits, `.`, `_`, `-` and `/`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Why `branch` cannot name a new branch and its folder, or undefined when it can; git refuses what this lets through. */
export function branchNameProblem(branch: string): string | undefined {
  const bad =
    !BRANCH_NAME.test(branch) || ['..', '//', '/.'].some((part) => branch.includes(part)) || ['/', '.', '.lock'].some((end) => branch.endsWith(end));
  return bad ? 'expected a branch name: letters, digits, ., _, - and /, from a letter or digit, without .., // or a part that starts with ., and not ending in /, . or .lock' : undefined;
}

/** The placeholders a pattern may use. */
export const BRANCH_PLACEHOLDERS = ['type', 'id', 'issue', 'slug', 'session'] as const;
export type BranchPlaceholder = (typeof BRANCH_PLACEHOLDERS)[number];

/** A branch type: a lowercase word, such as `feat`, `fix`, `docs`, `chore`, `refactor`, `hotfix` or `release`. */
const BRANCH_TYPE = /^[a-z][a-z0-9]*$/;
/** A placeholder in a pattern, such as `{slug}`. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The words a pattern is filled with. */
export type BranchWords = { readonly [P in BranchPlaceholder]: string | undefined };

export type BranchName = { readonly kind: 'name'; readonly branch: string } | { readonly kind: 'refused'; readonly reason: string };

/** Whether `text` is a branch type `--type` and `delivery.branches.types` may give. */
export function isBranchType(text: string): boolean {
  return BRANCH_TYPE.test(text);
}

function isPlaceholder(text: string): text is BranchPlaceholder {
  return BRANCH_PLACEHOLDERS.some((name) => name === text);
}

/**
 * Why `pattern` cannot name branches, or undefined when it can: it uses only known placeholders, holds `{id}` once at
 * the start of a part (the start, or after a `/`) followed by `-`, `/` or its end, and filled with sample words makes
 * a branch name git takes.
 */
export function branchPatternProblem(pattern: string): string | undefined {
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
export function branchNameFor(pattern: string, words: BranchWords): BranchName {
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

/** What a task's branch is named from. */
export interface BranchTask {
  /** Such as `T12`. */
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  /** Such as `gh:acme/app#933`; null for none. */
  readonly ref: string | null;
  readonly itemType: ItemType;
  /** The work class the task counts as (register/focus.ts `classOf`). */
  readonly workClass: string;
}

/**
 * The branch `teamrig worktree add --task` makes for `task`: its branch type is `type` when given, else its work class's
 * in `branches.classes`, else its item type's; the pattern is that branch type's own, else `branches.pattern`.
 */
export function taskBranchName(task: BranchTask, branches: BranchesConfig, type: string | undefined): BranchName {
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
export function slugOf(title: string, max: number): string {
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
export function issueNumberOf(ref: string | null): string | undefined {
  return ref === null ? undefined : /^gh:[^#\s]+#(\d+)$/.exec(ref)?.[1];
}

function fill(pattern: string, words: BranchWords): string {
  return pattern.replace(PLACEHOLDER, (whole, name: string) => (isPlaceholder(name) ? (words[name] ?? '') : whole));
}
