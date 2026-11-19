import type { Git } from '../lib/git.ts';
import type { Revisions } from './github-range.ts';

/**
 * What a CI run's changes are, which decides how much of ci.yml runs (T4617):
 * - `code`: any file outside the two kinds below, or no base to compare with: every check, on every OS.
 * - `docs`: only top-level Markdown and files under docs/: the commit checks, then on ubuntu alone the specs and the
 *   checks that hold the docs to the code.
 * - `design`: only files under docs/design/, which no spec holds to code: the commit checks and the docs' links.
 * Markdown anywhere else is code: a plugin's skills and guide ship to every user and specs read them, and a
 * `.github` or `.claude` page is read by the tools.
 */
export type ChangeKind = 'code' | 'docs' | 'design';

const DESIGN = /^docs\/design\//;
const DOCS = /^(?:docs\/|[^/]+\.md$)/;

/** The kind of a change that touched `files`, repo-relative with `/`; no file at all is code, so nothing is left out. */
export function changeKindOf(files: readonly string[]): ChangeKind {
  if (files.length === 0) return 'code';
  if (files.every((file) => DESIGN.test(file))) return 'design';
  if (files.every((file) => DOCS.test(file))) return 'docs';
  return 'code';
}

/**
 * The runners of ci.yml's test matrix for a code change: paths, renames and hook launch differ by OS. ci.yml reads the
 * run's list from change-kind-cli.ts, and the specs holding the docs and the ship's repos.json to the matrix read it here.
 */
export const TEST_SYSTEMS = ['ubuntu-latest', 'windows-latest', 'macos-latest'] as const;
export type TestSystem = (typeof TEST_SYSTEMS)[number];

/** The runners a change of `kind` is tested on: a docs or design change changes no code, so ubuntu alone. */
export function testSystems(kind: ChangeKind): readonly TestSystem[] {
  return kind === 'code' ? TEST_SYSTEMS : ['ubuntu-latest'];
}

/** A change's kind and the files that decided it; no files when there was no base to compare with. */
export interface ChangeReport {
  readonly kind: ChangeKind;
  readonly files: readonly string[] | undefined;
}

/**
 * The files changed from the base's common ancestor with the head to the head (`base...head`), so a pull request's
 * base that moved on adds none of its own. `--no-renames` lists both sides of a rename: a file moved from src/ into
 * docs/ is a code change.
 */
export async function changedFiles(git: Git, { base, head }: Revisions & { readonly base: string }): Promise<string[]> {
  const listed = await git.text(['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
  return listed.split('\0').filter((file) => file !== '');
}

/** The kind of the change between the two ends; a change with no base (a new branch, a run by hand) is code. */
export async function classifyChange(git: Git, revisions: Revisions): Promise<ChangeReport> {
  const { base, head } = revisions;
  if (base === undefined) return { kind: 'code', files: undefined };
  const files = await changedFiles(git, { base, head });
  return { kind: changeKindOf(files), files };
}

/** The line a run prints for its report, naming the range it read. */
export function describeChange(report: ChangeReport, revisions: Revisions): string {
  if (report.files === undefined) {
    return `change-kind: ${report.kind}: no base commit to compare with (a new branch or a run by hand), every check runs`;
  }
  return `change-kind: ${report.kind}: ${report.files.length} file(s) changed in ${revisions.base}...${revisions.head}`;
}
