import { appendFileSync } from 'node:fs';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import type { GitText } from '../ship/approval.ts';
import { releaseRefusal } from '../ship/release-pull.ts';
import { profileFor, type RepoProfile } from '../ship/repos.ts';
import { TEAMRIG_SHIP_VERSION_FILES } from '../ship/version-bump.ts';
import {
  codeSpan,
  fetchGitHubApi,
  type AppKey,
  type Fetch,
  type GateDeps,
  type GateOutcome,
  type GateTarget,
  type MergeDeps,
  type MergeOutcome,
  type MergeTarget,
} from './release-merge.ts';

/**
 * The two commands release-merge-cli.ts runs for .github/workflows/release-merge.yml (T4712), every value read from
 * the environment so no event text reaches a shell, and every effect passed in:
 * - `gateCommand` (job token, read-only): passes the release pull request ci just passed, writes `pass`, `pr`, `sha`,
 *   `checks` and `paths` to GITHUB_OUTPUT and the outcome to GITHUB_STEP_SUMMARY; exit 0 on pass or stale, 1 refused.
 * - `mergeCommand` (the App key, in its own job): merges that pull request at that sha; 1 unless merged and commented.
 * A missing or malformed value throws, which the CLI exits 2 on.
 */

export type Env = Readonly<Record<string, string | undefined>>;

const DIGITS = /^\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

export interface GateCommandDeps {
  /** Git in the checkout of main the job runs in. */
  readonly git: GitText;
  readonly profiles: ReadonlyMap<string, RepoProfile>;
  readonly gate: (target: GateTarget, deps: GateDeps) => Promise<GateOutcome>;
  readonly fetchFn: Fetch;
  readonly out: (text: string) => void;
}

export interface MergeCommandDeps {
  readonly merge: (target: MergeTarget, key: AppKey, deps: MergeDeps) => Promise<MergeOutcome>;
  readonly fetchFn: Fetch;
  readonly nowSeconds: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function envValue(env: Env, name: string, pattern?: RegExp): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`${name} is not in the form ${pattern.source}`);
  return value;
}

const apiRoot = (env: Env): string | undefined => env['GITHUB_API_URL'] || undefined;

export function gateSummary(outcome: GateOutcome): string {
  if (outcome.kind === 'pass') return `Release merge gate passed pull request #${outcome.pr} at ${codeSpan(outcome.sha)}: ${outcome.checks} checks green.\n`;
  return `Release merge gate ${outcome.kind === 'stale' ? 'found nothing to merge' : 'refused'}: ${outcome.reason}\n`;
}

export async function gateCommand(env: Env, deps: GateCommandDeps): Promise<number> {
  const repo = envValue(env, 'GITHUB_REPOSITORY');
  const runId = Number(envValue(env, 'RUN_ID', DIGITS));
  const token = envValue(env, 'GITHUB_TOKEN');
  const output = envValue(env, 'GITHUB_OUTPUT');
  const summaryFile = envValue(env, 'GITHUB_STEP_SUMMARY');
  const profile = profileFor(deps.profiles, repo);
  if (profile.release === null || profile.summary === null) throw new Error(`repos.json names no release pull request or summary check for ${repo}`);
  const release = profile.release;
  const { git } = deps;
  // Only the files the profile regenerates: approval.ts holds this split but loads src/, whose packages this job never
  // installs (no npm ci in a job that runs before review of what it reads).
  const versionFiles = TEAMRIG_SHIP_VERSION_FILES.filter((file) => profile.regenerated.includes(file.path));
  let paths: readonly string[] = [];
  const filesRefusal = (sha: string): string | null => {
    git(['fetch', '-q', '--no-tags', 'origin', sha]);
    const refusal = releaseRefusal(git, 'HEAD', sha, release, versionFiles);
    if (refusal === null) paths = git(['diff', '--name-only', '--no-renames', git(['merge-base', 'HEAD', sha]).trim(), sha]).split('\n').filter((line) => line !== '');
    return refusal;
  };
  const outcome = await deps.gate(
    { repo, runId, main: profile.main, head: release.head, summary: profile.summary },
    { api: fetchGitHubApi(deps.fetchFn, apiRoot(env)), token, filesRefusal },
  );
  const summary = gateSummary(outcome);
  appendFileSync(summaryFile, summary);
  deps.out(summary);
  if (outcome.kind !== 'pass') {
    appendFileSync(output, 'pass=false\n');
    return outcome.kind === 'stale' ? EXIT_CLEAN : EXIT_FINDINGS;
  }
  appendFileSync(output, `pass=true\npr=${outcome.pr}\nsha=${outcome.sha}\nchecks=${outcome.checks}\npaths=${paths.join(',')}\n`);
  return EXIT_CLEAN;
}

export async function mergeCommand(env: Env, deps: MergeCommandDeps): Promise<number> {
  const target: MergeTarget = {
    repo: envValue(env, 'GITHUB_REPOSITORY'),
    pr: Number(envValue(env, 'PR', DIGITS)),
    sha: envValue(env, 'SHA', FULL_SHA),
    checks: Number(envValue(env, 'CHECKS', DIGITS)),
    paths: envValue(env, 'PATHS').split(','),
    runUrl: envValue(env, 'RUN_URL', HTTPS_URL),
  };
  const key: AppKey = { appId: Number(envValue(env, 'APP_ID', DIGITS)), privateKey: envValue(env, 'APP_KEY') };
  const outcome = await deps.merge(target, key, { api: fetchGitHubApi(deps.fetchFn, apiRoot(env)), nowSeconds: deps.nowSeconds });
  const revoked = outcome.revoked ? 'the App token was revoked' : 'the App token could not be revoked: it expires within the hour';
  if (outcome.kind === 'refused') {
    deps.err(`release merge refused: ${outcome.reason}; ${revoked}`);
    return EXIT_FINDINGS;
  }
  deps.out(`release pull request #${target.pr} merged as ${outcome.sha}; ${revoked}`);
  if (!outcome.commented) deps.err("the gate comment could not be posted: teamrig's GitHub watch counts this merge as an incident until one is");
  return outcome.commented ? EXIT_CLEAN : EXIT_FINDINGS;
}
