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
  /** The branch pull requests merge into. */
  main: string;
  /**
   * What merge waits for: `ci`, every name in `checks` green on GitHub; `local`, a pass record of the
   * pull request head's tree on this machine, else the local checks run in the repo dir.
   */
  gate: Gate;
  /** Check names as GitHub shows them: an Actions job's name, or a commit status's context. */
  checks: readonly string[];
  local: LocalChecks;
  /**
   * Paths every reship writes again on a newer main (the built dist, the version files), a folder ending in
   * `/`: a remote branch whose other commits main holds is a leftover (leftovers.ts). Empty when not listed.
   */
  regenerated: readonly string[];
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

function parseRegenerated(slug: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!isNameList(value) || value.some(path => path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error(`repos.json: ${slug} "regenerated" needs a list of paths inside the repo (a folder ends in /)`);
  }
  if (new Set(value).size !== value.length) throw new Error(`repos.json: ${slug} lists a regenerated path twice`);
  return value;
}

export function parseProfiles(json: string): Map<string, RepoProfile> {
  const body: unknown = JSON.parse(json);
  if (!isRecord(body)) throw new Error('repos.json: expected { "<owner>/<repo>": { "main", "gate", "checks", "local", "regenerated" } }');
  const profiles = new Map<string, RepoProfile>();
  for (const [slug, entry] of Object.entries(body)) {
    if (!isRecord(entry) || typeof entry['main'] !== 'string' || !isNameList(entry['checks'])) throw new Error(`repos.json: ${slug} needs "main" and a "checks" list of names`);
    if (new Set(entry['checks']).size !== entry['checks'].length) throw new Error(`repos.json: ${slug} lists a check twice`);
    const gate = entry['gate'];
    if (!isGate(gate)) throw new Error(`repos.json: ${slug} needs a "gate": "ci" (GitHub checks) or "local" (checks run on this machine)`);
    profiles.set(slug.toLowerCase(), {
      slug,
      main: entry['main'],
      gate,
      checks: entry['checks'],
      local: parseLocalChecks(slug, entry['local']),
      regenerated: parseRegenerated(slug, entry['regenerated']),
    });
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
