import { appendFileSync } from 'node:fs';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { gitSyncIn } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { releaseRefusal } from '../ship/release-pull.ts';
import { profileFor, readProfiles } from '../ship/repos.ts';
import { TEAMRIG_SHIP_VERSION_FILES } from '../ship/version-bump.ts';
import { codeSpan, fetchGitHubApi, mergeRelease, releaseGate, type GateOutcome } from './release-merge.ts';

/**
 * Run by .github/workflows/release-merge.yml in a checkout of main (T4712), every value read from the environment so
 * no event text reaches a shell:
 * - `gate` (job token, read-only): passes the release pull request ci just passed, writes `pass`, `pr`, `sha`,
 *   `checks` and `paths` to GITHUB_OUTPUT and the outcome to GITHUB_STEP_SUMMARY; exit 0 on pass or stale, 1 refused.
 * - `merge` (the App key, in its own job): merges that pull request at that sha; exit 1 unless it merged and commented.
 * A missing or malformed value exits 2.
 */

type Env = Readonly<Record<string, string | undefined>>;

const DIGITS = /^\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

function envValue(env: Env, name: string, pattern?: RegExp): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`${name} is not in the form ${pattern.source}`);
  return value;
}

function appendTo(env: Env, name: string, text: string): void {
  appendFileSync(envValue(env, name), text);
}

function summaryOf(outcome: GateOutcome): string {
  if (outcome.kind === 'pass') return `Release merge gate passed pull request #${outcome.pr} at ${codeSpan(outcome.sha)}: ${outcome.checks} checks green.\n`;
  return `Release merge gate ${outcome.kind === 'stale' ? 'found nothing to merge' : 'refused'}: ${outcome.reason}\n`;
}

async function gateCommand(env: Env, cwd: string): Promise<number> {
  const repo = envValue(env, 'GITHUB_REPOSITORY');
  const runId = Number(envValue(env, 'RUN_ID', DIGITS));
  const token = envValue(env, 'GITHUB_TOKEN');
  envValue(env, 'GITHUB_OUTPUT');
  envValue(env, 'GITHUB_STEP_SUMMARY');
  const profile = profileFor(readProfiles(), repo);
  if (profile.release === null || profile.summary === null) throw new Error(`repos.json names no release pull request or summary check for ${repo}`);
  const release = profile.release;
  const git = gitSyncIn(cwd);
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
  const outcome = await releaseGate(
    { repo, runId, main: profile.main, head: release.head, summary: profile.summary },
    { api: fetchGitHubApi(fetch, env['GITHUB_API_URL'] || undefined), token, filesRefusal },
  );
  appendTo(env, 'GITHUB_STEP_SUMMARY', summaryOf(outcome));
  process.stdout.write(summaryOf(outcome));
  if (outcome.kind !== 'pass') {
    appendTo(env, 'GITHUB_OUTPUT', 'pass=false\n');
    return outcome.kind === 'stale' ? EXIT_CLEAN : EXIT_FINDINGS;
  }
  appendTo(env, 'GITHUB_OUTPUT', `pass=true\npr=${outcome.pr}\nsha=${outcome.sha}\nchecks=${outcome.checks}\npaths=${paths.join(',')}\n`);
  return EXIT_CLEAN;
}

async function mergeCommand(env: Env): Promise<number> {
  const repo = envValue(env, 'GITHUB_REPOSITORY');
  const target = {
    repo,
    pr: Number(envValue(env, 'PR', DIGITS)),
    sha: envValue(env, 'SHA', FULL_SHA),
    checks: Number(envValue(env, 'CHECKS', DIGITS)),
    paths: envValue(env, 'PATHS').split(','),
    runUrl: envValue(env, 'RUN_URL', /^https:\/\/\S+$/),
  };
  const key = { appId: Number(envValue(env, 'APP_ID', DIGITS)), privateKey: envValue(env, 'APP_KEY') };
  const outcome = await mergeRelease(target, key, { api: fetchGitHubApi(fetch, env['GITHUB_API_URL'] || undefined), nowSeconds: () => Math.floor(Date.now() / 1000) });
  const revoked = outcome.revoked ? 'the App token was revoked' : 'the App token could not be revoked: it expires within the hour';
  if (outcome.kind === 'refused') {
    console.error(`release merge refused: ${outcome.reason}; ${revoked}`);
    return EXIT_FINDINGS;
  }
  console.log(`release pull request #${target.pr} merged as ${outcome.sha}; ${revoked}`);
  if (!outcome.commented) console.error("the gate comment could not be posted: teamrig's GitHub watch counts this merge as an incident until one is");
  return outcome.commented ? EXIT_CLEAN : EXIT_FINDINGS;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0) throw new Error('takes one argument: gate or merge');
  if (command === 'gate') return gateCommand(process.env, process.cwd());
  if (command === 'merge') return mergeCommand(process.env);
  throw new Error('takes one argument: gate or merge');
}

process.exitCode = await runMain('release-merge', main, (line) => console.error(line));
