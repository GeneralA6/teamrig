import { globRegExp } from "../secret-guard/glob.js";
/**
 * The paths teamrig holds for security in every repo behind the gate: what installs or runs code on a machine or in
 * CI, and how git reads the repo. A team or repo list adds entries; none removes these.
 */
export const GENERIC_REVIEW_PATHS = [
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
].map((glob) => ({ glob, mode: 'always', class: 'security' }));
/**
 * Whether a repo path falls under a review glob. A glob with no slash names a file at any depth (`hooks.json`); one
 * with a slash is read from the repo root (`.github/workflows/**`), so `**\/` reaches any depth. Case is ignored, so a
 * case-insensitive disk cannot dodge an entry, and names starting with a dot match like any other.
 */
export function reviewPathMatcher(glob) {
    const rooted = glob.replace(/^\/+/, '');
    const expression = globRegExp(rooted.includes('/') ? rooted : `**/${rooted}`, { ignoreCase: true, dotfiles: true });
    return (path) => expression.test(path.replace(/\\/g, '/'));
}
/** Each touched path with each entry that covers it, in the order of the paths, then of the entries. */
export function reviewHits(paths, entries) {
    const matchers = entries.map((entry) => ({ entry, matches: reviewPathMatcher(entry.glob) }));
    return paths.flatMap((path) => matchers.filter(({ matches }) => matches(path)).map(({ entry }) => ({ path, entry })));
}
