import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { type Gh, ghWithToken } from './github.ts';
import { type Credential, SHIP_TOKEN_TARGET, readCredential, windowsPowerShell } from './keychain.ts';
import { readProfiles } from './repos.ts';

/**
 * Says whether ship's token is stored and what it can read, never the token itself (at most its type prefix).
 * Usage: node token-check.ts [--repo <owner>/<repo>]... [--pr <number>]   (default: every repo in repos.json)
 * Writes are not probed (that would change the repo); the first merge proves them.
 */
const KNOWN_PREFIXES = ['github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_'];

export function describeCredential(credential: Credential): string {
  if (credential.kind === 'missing') return `${SHIP_TOKEN_TARGET}: not stored. Store it (prompts, nothing echoed): cmdkey /generic:${SHIP_TOKEN_TARGET} /user:teamrig /pass`;
  if (credential.kind === 'error') return `${SHIP_TOKEN_TARGET}: unreadable: ${credential.reason}`;
  const prefix = KNOWN_PREFIXES.find(known => credential.secret.startsWith(known)) ?? 'an unknown';
  return `${SHIP_TOKEN_TARGET}: found, ${credential.secret.length} chars, ${prefix} prefix`;
}

interface Probe {
  label: string;
  /** false: a refusal is expected and does not fail the check. */
  needed: boolean;
  args(repo: string, sha: string): string[];
  says(stdout: string): string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const countOf = (stdout: string): string => {
  const body: unknown = JSON.parse(stdout);
  return Array.isArray(body) ? `${body.length} read` : isRecord(body) && typeof body['total_count'] === 'number' ? `${body['total_count']} in all` : 'read';
};

const PROBES: readonly Probe[] = [
  { label: 'pull requests (Pull requests: read)', needed: true, args: repo => ['api', `repos/${repo}/pulls?state=all&per_page=1`], says: countOf },
  { label: 'Actions runs (Actions: read)', needed: true, args: repo => ['api', `repos/${repo}/actions/runs?per_page=1`], says: countOf },
  { label: 'commit statuses (Commit statuses: read)', needed: true, args: (repo, sha) => ['api', `repos/${repo}/commits/${sha}/status`], says: countOf },
  { label: 'check runs (no Checks permission on fine-grained tokens: ship reads Actions jobs instead)', needed: false, args: (repo, sha) => ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=1`], says: countOf },
];

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0] ?? '';

/** The lines to print and whether every needed read worked. */
export function probeRepo(gh: Gh, repo: string, pr: number | null): { lines: string[]; ok: boolean } {
  let sha: string;
  try {
    const head: unknown = JSON.parse(gh(['api', `repos/${repo}/commits?per_page=1`]));
    const first: unknown = Array.isArray(head) ? head[0] : undefined;
    if (!isRecord(first) || typeof first['sha'] !== 'string') throw new Error('no commit to probe with');
    sha = first['sha'];
  } catch (error) {
    return { lines: [`${repo}: contents (Contents: read): no: ${firstLine(error)}`], ok: false };
  }
  const lines = [`${repo}: contents (Contents: read): yes, newest commit ${sha.slice(0, 7)}`];
  let ok = true;
  for (const probe of PROBES) {
    try {
      lines.push(`${repo}: ${probe.label}: yes, ${probe.says(gh(probe.args(repo, sha)))}`);
    } catch (error) {
      ok &&= !probe.needed;
      lines.push(`${repo}: ${probe.label}: no: ${firstLine(error)}`);
    }
  }
  if (pr !== null) {
    try {
      const checks: unknown = JSON.parse(gh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state']));
      lines.push(`${repo}: gh pr checks ${pr}: yes, ${Array.isArray(checks) ? checks.length : 0} check(s) visible`);
    } catch (error) {
      lines.push(`${repo}: gh pr checks ${pr}: no: ${firstLine(error)} (ship does not need it)`);
    }
  }
  return { lines, ok };
}

export function tokenCheck(credential: Credential, ghFor: (token: string) => Gh, repos: readonly string[], pr: number | null): { lines: string[]; ok: boolean } {
  const lines = [describeCredential(credential)];
  if (credential.kind !== 'found') return { lines, ok: false };
  const gh = ghFor(credential.secret);
  let ok = true;
  for (const repo of repos) {
    const result = probeRepo(gh, repo, pr);
    lines.push(...result.lines);
    ok &&= result.ok;
  }
  lines.push('writes (Contents, Pull requests: write) are not probed: the first merge proves them');
  return { lines, ok };
}

export function parseArgs(argv: readonly string[], known: readonly string[]): { repos: string[]; pr: number | null } {
  const repos: string[] = [];
  let pr: number | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--repo') repos.push(value);
    else if (flag === '--pr' && /^\d+$/.test(value)) pr = Number(value);
    else throw new Error(`usage: token-check.ts [--repo <owner>/<repo>]... [--pr <number>] (got ${flag})`);
  }
  return { repos: repos.length > 0 ? repos : [...known], pr };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { repos, pr } = parseArgs(process.argv.slice(2), [...readProfiles().values()].map(profile => profile.slug));
  const { lines, ok } = tokenCheck(readCredential(SHIP_TOKEN_TARGET, windowsPowerShell), token => ghWithToken(token), repos, pr);
  for (const line of lines) console.log(line);
  process.exitCode = ok ? 0 : 1;
}
