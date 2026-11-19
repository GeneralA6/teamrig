import { execFile } from 'node:child_process';
import type { ChangeGit, GitCommit, Release, ResolvedPoint } from './source.ts';

/** A version as releases write it: `1.2.3`, maybe with a pre-release part (`1.2.3-rc.1`). */
const VERSION = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`;

/**
 * A version tag: `v1.2.3`, `1.2.3`, or a component's `teamrig-v1.2.3` as release-please tags one. Each component
 * word starts with a letter and holds no `-`, so a tag of any length is read in linear time.
 */
const VERSION_TAG = new RegExp(`^(?:[A-Za-z][\\w.]*(?:-[A-Za-z][\\w.]*)*-)?v?${VERSION}$`);

/**
 * A commit subject that names a release, for a project that tags none: `plugin: version 0.447.0, ...` (an area
 * prefix, then "version", "release" or "bump to"), release-please's `chore(main): release teamrig 1.2.3` (a
 * component before the version), `chore(release): 1.2.3` (a release scope), or a bare `v1.2.3`.
 */
const RELEASE_SUBJECTS: readonly RegExp[] = [
  new RegExp(`^(?:[\\w-]+(?:\\([^)]*\\))?!?:\\s*)?(?:release|version|bump(?:\\s+version)?(?:\\s+to)?)\\s+v?${VERSION}(?![\\w.])`, 'i'),
  new RegExp(`^[\\w-]+(?:\\([^)]*\\))?!?:\\s*release\\s+[\\w@/.-]+\\s+v?${VERSION}(?![\\w.])`, 'i'),
  new RegExp(`^[\\w-]+\\(release\\)!?:\\s*v?${VERSION}(?![\\w.])`, 'i'),
  new RegExp(`^v?${VERSION}$`),
];

/** The version a release commit's subject names; undefined for any other commit. */
export function releaseVersionOf(subject: string): string | undefined {
  for (const pattern of RELEASE_SUBJECTS) {
    const version = pattern.exec(subject.trim())?.[1];
    if (version !== undefined) {
      return version;
    }
  }
  return undefined;
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/** The `git log` format `parseCommits` reads: sha, committer time, subject, body, then the `--name-only` file list. */
export const COMMIT_FORMAT = `${RECORD}%H${FIELD}%cI${FIELD}%s${FIELD}%b${FIELD}`;

/** Reads `git log --name-only --format=<COMMIT_FORMAT>` output. */
export function parseCommits(text: string): GitCommit[] {
  return text
    .split(RECORD)
    .slice(1)
    .flatMap((record) => {
      const [sha = '', at = '', subject = '', body = '', files = ''] = record.split(FIELD);
      return sha === '' ? [] : [{ sha, at: utcOf(at), subject, body: body.trim(), files: linesOf(files) }];
    });
}

/** Reads `git log --format=%H%x1f%cI%x1f%s` output: the commits naming a release. */
export function parseReleaseCommits(text: string): Release[] {
  return linesOf(text).flatMap((line) => {
    const [sha = '', at = '', subject = ''] = line.split(FIELD);
    const version = releaseVersionOf(subject);
    return version === undefined || sha === '' ? [] : [{ version, at: utcOf(at), sha }];
  });
}

/** Reads `git for-each-ref refs/tags --format=<name>%x1f<time>%x1f<commit>` output: the version tags. */
export function parseReleaseTags(text: string): Release[] {
  return linesOf(text).flatMap((line) => {
    const [name = '', at = '', sha = ''] = line.split(FIELD);
    const version = VERSION_TAG.exec(name)?.[1];
    return version === undefined || sha === '' || at === '' ? [] : [{ version, at: utcOf(at), sha }];
  });
}

/** Tags first, so a tag wins over a commit naming the same version; the first commit met (the newest) wins among commits. Newest first. */
export function releaseIndexOf(tags: readonly Release[], commits: readonly Release[]): Release[] {
  const byVersion = new Map<string, Release>();
  for (const release of [...tags, ...commits]) {
    if (!byVersion.has(release.version)) {
      byVersion.set(release.version, release);
    }
  }
  return [...byVersion.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** The `git log` arguments for one range: by commit where both ends name one, else by time. */
export function logArgs(range: { readonly since: ResolvedPoint; readonly until: ResolvedPoint | undefined; readonly paths: readonly string[] }): string[] {
  const { since, until, paths } = range;
  const tip = until?.ref ?? 'HEAD';
  const span = since.ref === undefined ? [tip] : [`${since.ref}..${tip}`];
  const times = [
    ...(since.ref === undefined && since.at !== undefined ? [`--since=${since.at}`] : []),
    ...(until?.ref === undefined && until?.at !== undefined ? [`--until=${until.at}`] : []),
  ];
  return ['-c', 'core.quotePath=false', 'log', '--no-merges', '--name-only', `--format=${COMMIT_FORMAT}`, ...times, '--end-of-options', ...span, '--', ...paths];
}

function linesOf(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.replace(/\r$/, '').trim();
    return trimmed === '' ? [] : [trimmed];
  });
}

/** git's strict ISO time (`2026-11-16T22:41:00+02:00`) as UTC; kept as written when it does not read as a time. */
function utcOf(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : new Date(ms).toISOString();
}

/** A large range's log runs to tens of megabytes. */
const MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** One git run's stdout; a failure (no repository, an unknown commit, no git on PATH) rejects with git's own words. */
function runGit(dir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      const said = stderr.trim().split('\n')[0];
      reject(new Error(said === undefined || said === '' ? error.message : said));
    });
  });
}

/** The change reads from the git CLI, read-only. */
export const GIT_CHANGES: ChangeGit = {
  log: async (project, range) => parseCommits(await runGit(project, logArgs(range))),
  releases: async (project) => {
    const [tags, commits] = await Promise.all([
      runGit(project, ['for-each-ref', 'refs/tags', `--format=%(refname:short)${FIELD}%(creatordate:iso-strict)${FIELD}%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)`]),
      runGit(project, ['log', '--no-merges', `--format=%H${FIELD}%cI${FIELD}%s`, 'HEAD', '--']),
    ]);
    return releaseIndexOf(parseReleaseTags(tags), parseReleaseCommits(commits));
  },
};
