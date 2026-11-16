import { readFileSync } from 'node:fs';

/**
 * Each repo ship merges, keyed by its GitHub slug (not a local path, so moving a checkout changes nothing
 * here), with the proof a pull request's head needs before it merges: its `gate`. A repo with no entry,
 * or a gate with nothing to check, cannot merge: a missing check list is a fail, like a missing check.
 */
export type Gate = 'ci' | 'local';

export interface LocalChecks {
  /**
   * The repo's own local CI runner, relative to the repo dir: it runs every check the repo's CI runs that
   * can run here, and writes the pass record itself. Null when repos.json names none, so nothing proves a tree.
   */
  runner: string | null;
}

export interface RepoProfile {
  slug: string;
  /**
   * The other `<owner>/<repo>` names the same repo is reached by, its entry found under each: the name a transfer
   * moves it to, before the move, and the one it moved from after it, as a checkout whose remote still names the old
   * owner works through GitHub's redirect. Empty when not listed.
   */
  aliases: readonly string[];
  /** The branch pull requests merge into. */
  main: string;
  /**
   * What merge waits for: `ci`, every name in `checks` green on GitHub; `local`, a pass record of the
   * pull request head's tree on this machine, else the local checks run in the repo dir.
   */
  gate: Gate;
  /** Check names as GitHub shows them: an Actions job's name, or a commit status's context. */
  checks: readonly string[];
  /**
   * The check that fails whenever any other job of its run did not succeed (`every check passed`), one of `checks`:
   * its failure beside legs GitHub cancelled before any step ran is their echo, re-run with them (github.ts).
   * Null when not listed.
   */
  summary: string | null;
  local: LocalChecks;
  /**
   * Paths every reship writes again on a newer main (the built dist, the version files), a folder ending in
   * `/`: a remote branch whose other commits main holds is a leftover (leftovers.ts). Empty when not listed.
   */
  regenerated: readonly string[];
  /**
   * Checks whose failure a merge re-runs once on the same sha before it fails (T2988): tests that fail under load and
   * pass alone (T2532). Each is one of `checks`, never the summary, which echoes them (github.ts). Empty when not listed.
   */
  flaky: readonly string[];
}

export const PROFILES_PATH = new URL('./repos.json', import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');
const isGate = (value: unknown): value is Gate => value === 'ci' || value === 'local';
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function parseLocalChecks(slug: string, value: unknown): LocalChecks {
  if (value === undefined) return { runner: null };
  const runner = isRecord(value) ? value['runner'] : undefined;
  if (!isText(runner)) throw new Error(`repos.json: ${slug} "local" needs a "runner": the path of the repo's local CI runner`);
  return { runner };
}

function parseSummary(slug: string, value: unknown, checks: readonly string[]): string | null {
  if (value === undefined) return null;
  if (!isText(value) || !checks.includes(value)) throw new Error(`repos.json: ${slug} "summary" needs the name of one of its "checks"`);
  return value;
}

function parseFlaky(slug: string, value: unknown, checks: readonly string[], summary: string | null): readonly string[] {
  if (value === undefined) return [];
  if (!isNameList(value) || value.some(name => !checks.includes(name) || name === summary)) {
    throw new Error(`repos.json: ${slug} "flaky" needs a list of its "checks", the summary apart`);
  }
  if (new Set(value).size !== value.length) throw new Error(`repos.json: ${slug} lists a flaky check twice`);
  return value;
}

function parseRegenerated(slug: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!isNameList(value) || value.some(path => path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error(`repos.json: ${slug} "regenerated" needs a list of paths inside the repo (a folder ends in /)`);
  }
  if (new Set(value).size !== value.length) throw new Error(`repos.json: ${slug} lists a regenerated path twice`);
  return value;
}

const SLUG = /^[\w.-]+\/[\w.-]+$/u;

function parseAliases(slug: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!isNameList(value) || value.some(alias => !SLUG.test(alias))) {
    throw new Error(`repos.json: ${slug} "aliases" needs a list of <owner>/<repo> names`);
  }
  return value;
}

/** Each repo's own name once, its aliases apart: the repos repos.json lists. */
export function repoSlugs(profiles: ReadonlyMap<string, RepoProfile>): string[] {
  return [...new Set(profiles.values())].map(profile => profile.slug);
}

export function parseProfiles(json: string): Map<string, RepoProfile> {
  const body: unknown = JSON.parse(json);
  if (!isRecord(body)) throw new Error('repos.json: expected { "<owner>/<repo>": { "main", "gate", "checks", "summary", "local", "regenerated", "flaky", "aliases" } }');
  const profiles = new Map<string, RepoProfile>();
  for (const [slug, entry] of Object.entries(body)) {
    if (!isRecord(entry) || typeof entry['main'] !== 'string' || !isNameList(entry['checks'])) throw new Error(`repos.json: ${slug} needs "main" and a "checks" list of names`);
    if (new Set(entry['checks']).size !== entry['checks'].length) throw new Error(`repos.json: ${slug} lists a check twice`);
    const gate = entry['gate'];
    if (!isGate(gate)) throw new Error(`repos.json: ${slug} needs a "gate": "ci" (GitHub checks) or "local" (checks run on this machine)`);
    const summary = parseSummary(slug, entry['summary'], entry['checks']);
    const aliases = parseAliases(slug, entry['aliases']);
    const profile: RepoProfile = {
      slug,
      aliases,
      main: entry['main'],
      gate,
      checks: entry['checks'],
      summary,
      local: parseLocalChecks(slug, entry['local']),
      regenerated: parseRegenerated(slug, entry['regenerated']),
      flaky: parseFlaky(slug, entry['flaky'], entry['checks'], summary),
    };
    for (const name of [slug, ...aliases]) {
      const key = name.toLowerCase();
      const holder = profiles.get(key);
      if (holder !== undefined) throw new Error(`repos.json: ${name} names both ${holder.slug} and ${slug}: a name finds one repo`);
      profiles.set(key, profile);
    }
  }
  return profiles;
}

export function profileFor(profiles: ReadonlyMap<string, RepoProfile>, slug: string): RepoProfile {
  const profile = profiles.get(slug.toLowerCase());
  if (profile === undefined) throw new Error(`no check list for ${slug}: add it to repos.json (a repo without one cannot merge)`);
  if (profile.gate === 'ci' && profile.checks.length === 0) throw new Error(`${slug} lists no checks in repos.json: nothing would prove the change, so it cannot merge`);
  if (profile.gate === 'local' && profile.local.runner === null) throw new Error(`${slug} names no local runner in repos.json: nothing would prove the change, so it cannot merge`);
  return profile;
}

/** `git@github.com:Owner/Repo.git` or `https://github.com/Owner/Repo(.git)` → `Owner/Repo`. */
export function slugOf(remoteUrl: string): string {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (match === null) throw new Error(`${remoteUrl} is not a GitHub remote`);
  return `${match[1]}/${match[2]}`;
}

export function readProfiles(path: URL = PROFILES_PATH): Map<string, RepoProfile> {
  return parseProfiles(readFileSync(path, 'utf8'));
}
