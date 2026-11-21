import type { BranchesConfig } from '../config/types.ts';
import { branchHint } from '../issues/ref.ts';
import type { ItemType } from '../register/events.ts';

/**
 * A new branch's name from its task (T2690), by the team's pattern (`delivery.branches`), so every branch and the
 * worktree folder named after it read the same way: `feat/t12-parser` by default, after Conventional Branch. The task id
 * starts a part of the name, which is what tells whose branch it is (owner.ts `branchTaskOf`).
 */

/** A new branch's name, which also names its folder: from a letter or digit, then letters, digits, `.`, `_`, `-` and `/`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The longest new branch name. The worktree folder is named after the branch as one path component, which file systems
 * cap at 255 bytes (BRANCH_NAME allows ASCII only, so a character is a byte); the cap also bounds the pattern check.
 */
const BRANCH_NAME_MAX = 255;

/** Why `branch` cannot name a new branch and its folder, or undefined when it can; git refuses what this lets through. */
export function branchNameProblem(branch: string): string | undefined {
  if (branch.length > BRANCH_NAME_MAX) {
    return `expected a branch name of at most ${BRANCH_NAME_MAX} characters, since it also names the worktree folder; this one has ${branch.length}`;
  }
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

const LOWER = /[a-z]/;
const DIGIT = /[0-9]/;
const LOWER_OR_DIGIT = /[a-z0-9]/;
const SESSION_CHAR = /[a-z0-9-]/;
const NONZERO_DIGIT = /[1-9]/;

/** For each place in `text`, where the run of `allowed` characters from it ends: the place itself when none starts there. */
function runEnds(text: string, allowed: RegExp): Int32Array {
  const ends = new Int32Array(text.length + 1);
  ends[text.length] = text.length;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    ends[at] = allowed.test(text.charAt(at)) ? (ends[at + 1] ?? at) : at;
  }
  return ends;
}

/** What the matcher reads of a branch name, worked out once per name in passes from its end. */
class NameRuns {
  readonly text: string;
  readonly digits: Int32Array;
  readonly lowerOrDigits: Int32Array;
  readonly sessionChars: Int32Array;
  /** How far a slug from each place can reach: words of letters and digits joined by single `-`s ({@link slugOf}). */
  readonly slugReach: Int32Array;

  constructor(text: string) {
    this.text = text;
    this.digits = runEnds(text, DIGIT);
    this.lowerOrDigits = runEnds(text, LOWER_OR_DIGIT);
    this.sessionChars = runEnds(text, SESSION_CHAR);
    this.slugReach = new Int32Array(text.length + 1);
    for (let at = text.length; at >= 0; at -= 1) {
      const word = this.lowerOrDigits[at] ?? at;
      const joined = word > at && text.charAt(word) === '-' && this.is(word + 1, LOWER_OR_DIGIT);
      this.slugReach[at] = joined ? (this.slugReach[word + 1] ?? word) : word;
    }
  }

  is(at: number, allowed: RegExp): boolean {
    return at < this.text.length && allowed.test(this.text.charAt(at));
  }
}

/** The ends a placeholder's word can have from one start: every place from `first` to `last`, both included. */
interface EndRange {
  readonly first: number;
  readonly last: number;
}

/**
 * Where each placeholder's word can end when it starts at `at`, as {@link taskBranchName} fills it: a branch type, the
 * task id in lowercase, an issue number, a slug (which ends only after a letter or digit, see `placeholderEnds`), a
 * session name (core/ids.ts; its words run to any length here, though `ID_PATTERN` stops ids at 32 characters: looser,
 * never stricter, so no name a pattern makes is refused).
 */
const PLACEHOLDER_ENDS: { readonly [P in BranchPlaceholder]: (runs: NameRuns, at: number) => EndRange | undefined } = {
  type: (runs, at) => (runs.is(at, LOWER) ? { first: at + 1, last: runs.lowerOrDigits[at + 1] ?? at + 1 } : undefined),
  id: (runs, at) => (runs.text.charAt(at) === 't' && runs.is(at + 1, NONZERO_DIGIT) ? { first: at + 2, last: runs.digits[at + 2] ?? at + 2 } : undefined),
  issue: (runs, at) => (runs.is(at, DIGIT) ? { first: at + 1, last: runs.digits[at] ?? at + 1 } : undefined),
  slug: (runs, at) => (runs.is(at, LOWER_OR_DIGIT) ? { first: at + 1, last: runs.slugReach[at] ?? at + 1 } : undefined),
  session: (runs, at) => (runs.is(at, LOWER) ? { first: at + 1, last: runs.sessionChars[at + 1] ?? at + 1 } : undefined),
};

/** A pattern as the parts a name must hold in order: text kept as written, or a placeholder's word. */
type PatternPart = { readonly text: string } | { readonly placeholder: BranchPlaceholder };

function partsOf(pattern: string): readonly PatternPart[] {
  const parts: PatternPart[] = [];
  let at = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    parts.push({ text: pattern.slice(at, match.index) }, isPlaceholder(name) ? { placeholder: name } : { text: match[0] });
    at = match.index + match[0].length;
  }
  parts.push({ text: pattern.slice(at) });
  return parts;
}

/** The places a placeholder's word can end at, from any of `places`: each start marks one range, one pass reads them all. */
function placeholderEnds(runs: NameRuns, placeholder: BranchPlaceholder, places: Uint8Array): Uint8Array {
  const length = runs.text.length;
  const marks = new Int32Array(length + 2);
  for (let at = 0; at <= length; at += 1) {
    const range = places[at] === 1 ? PLACEHOLDER_ENDS[placeholder](runs, at) : undefined;
    if (range !== undefined && range.first <= range.last) {
      marks[range.first] = (marks[range.first] ?? 0) + 1;
      marks[range.last + 1] = (marks[range.last + 1] ?? 0) - 1;
    }
  }
  const ends = new Uint8Array(length + 1);
  let open = 0;
  for (let end = 0; end <= length; end += 1) {
    open += marks[end] ?? 0;
    // A slug's range spans its joining `-`s, where no slug ends.
    ends[end] = open > 0 && (placeholder !== 'slug' || runs.text.charAt(end - 1) !== '-') ? 1 : 0;
  }
  return ends;
}

/**
 * Whether `pattern` makes `branch`. It keeps the places in the name each part can end at, each part read in one pass
 * over the name: a regex backtracks through every split between neighbouring placeholders that both take a `-`, which
 * grows as the name's length to the power of their count (a long name that misses `{slug}-{slug}-{slug}` takes seconds).
 */
function patternMakes(pattern: string, branch: string): boolean {
  const runs = new NameRuns(branch);
  let places: Uint8Array = new Uint8Array(branch.length + 1);
  places[0] = 1;
  for (const part of partsOf(pattern)) {
    if ('placeholder' in part) {
      places = placeholderEnds(runs, part.placeholder, places);
      continue;
    }
    const next = new Uint8Array(branch.length + 1);
    for (let at = 0; at + part.text.length <= branch.length; at += 1) {
      if (places[at] === 1 && branch.startsWith(part.text, at)) {
        next[at + part.text.length] = 1;
      }
    }
    places = next;
  }
  return places[branch.length] === 1;
}

/** A branch name with a retry suffix, `-1` to `-999`, and the name before it. */
const RETRY_SUFFIX = /^(.+)-[1-9]\d{0,2}$/;

/** A team's branch patterns: `pattern`, then each branch type's own, each once. */
export function branchPatternsOf(branches: BranchesConfig): readonly string[] {
  return [...new Set([branches.pattern, ...Object.values(branches.typePatterns)])];
}

/**
 * Why `branch` may not be made as a new branch, or undefined when it may (T1433): while `delivery.branches.enforce` is
 * on, its name must be one of the team's patterns makes, so a project never mixes branch styles. Only a new branch is
 * checked; branches already there keep their names, and every task-from-branch read stays owner.ts `branchTaskOf`,
 * whose rule is the one {@link branchPatternProblem} holds every pattern's `{id}` to. A name a pattern makes plus a
 * retry suffix (`-2`) passes too: a re-ship after a rebase goes out under a new name, and a pattern ending at `{id}` or
 * `{issue}` has no `{slug}` to take the suffix in.
 */
export function branchPatternRefusal(branch: string, branches: BranchesConfig): string | undefined {
  if (!branches.enforce) {
    return undefined;
  }
  const patterns = branchPatternsOf(branches);
  const retried = RETRY_SUFFIX.exec(branch)?.[1];
  if (patterns.some((pattern) => patternMakes(pattern, branch) || (retried !== undefined && patternMakes(pattern, retried)))) {
    return undefined;
  }
  const sample = fill(branches.pattern, { type: branches.itemTypes.task, id: 't12', issue: '933', slug: 'parser', session: 'web' });
  const names = patterns.length === 1 ? `the branch pattern ${patterns[0]}` : `any of the branch patterns ${patterns.join(', ')}`;
  return `"${branch}" does not match ${names} (delivery.branches), such as ${sample}; delivery.branches.enforce false lets any name through`;
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
    issue: branchHint(task.ref),
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

function fill(pattern: string, words: BranchWords): string {
  return pattern.replace(PLACEHOLDER, (whole, name: string) => (isPlaceholder(name) ? (words[name] ?? '') : whole));
}
