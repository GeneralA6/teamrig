import type { ReviewPath } from '../config/types.ts';
import { globRegExp } from '../secret-guard/glob.ts';

/**
 * The review gate's path half (T800 §2.2): the review entries the paths of a change hit. The paths are git's
 * `--name-only --no-renames` list (`IntegrateGit.changedPaths`), which names a rename at its old and its new path and a
 * deletion at its path, so moving or removing a file cannot slip past an entry.
 */

/** One path a change touches that a review entry covers. */
export interface ReviewHit {
  readonly path: string;
  readonly entry: ReviewPath;
}

/**
 * The paths teamrig holds for security in every repo behind the gate: what installs or runs code on a machine or in
 * CI, and how git reads the repo. A team or repo list adds entries; none removes these.
 */
export const GENERIC_REVIEW_PATHS: readonly ReviewPath[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.yarnrc*',
  '.pnpmfile.cjs',
  '**/.husky/**',
  '**/.githooks/**',
  '**/.claude/hooks/**',
  '**/.claude/settings*.json',
  'hooks.json',
  '.github/workflows/**',
  'Procfile',
  'Dockerfile',
  'Dockerfile.*',
  '*.dockerfile',
  '.dockerignore',
  '.gitmodules',
  '.gitattributes',
].map((glob): ReviewPath => ({ glob, mode: 'always', class: 'security' }));

/**
 * Whether a repo path falls under a review glob. A glob with no slash names a file at any depth (`hooks.json`); one
 * with a slash is read from the repo root (`.github/workflows/**`), so `**\/` reaches any depth. Case is ignored, so a
 * case-insensitive disk cannot dodge an entry, and names starting with a dot match like any other.
 */
export function reviewPathMatcher(glob: string): (path: string) => boolean {
  const rooted = glob.replace(/^\/+/, '');
  const expression = globRegExp(rooted.includes('/') ? rooted : `**/${rooted}`, { ignoreCase: true, dotfiles: true });
  return (path) => expression.test(path.replace(/\\/g, '/'));
}

/** Each touched path with each entry that covers it, in the order of the paths, then of the entries. */
export function reviewHits(paths: readonly string[], entries: readonly ReviewPath[]): readonly ReviewHit[] {
  const matchers = entries.map((entry) => ({ entry, matches: reviewPathMatcher(entry.glob) }));
  return paths.flatMap((path) => matchers.filter(({ matches }) => matches(path)).map(({ entry }) => ({ path, entry })));
}
