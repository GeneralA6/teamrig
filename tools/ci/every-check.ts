import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { isRecord, stringField } from '../lib/guards.ts';

/** One job of a workflow run, as the jobs API lists its latest attempt. */
export interface RunJob {
  readonly name: string;
  readonly status: string;
  /** Null until the job completes. */
  readonly conclusion: string | null;
}

/** The run whose jobs are checked. */
export interface RunRef {
  /** `owner/name`. */
  readonly repo: string;
  readonly runId: string;
}

/** Runs the GitHub CLI with the arguments, never through a shell; resolves with what it prints. */
export type RunGh = (args: readonly string[]) => Promise<string>;

/** Runs a program by argv, never through a shell; resolves with what it printed. */
export type RunFile = (file: string, args: readonly string[], options: { windowsHide: boolean; maxBuffer: number }) => Promise<{ stdout: string }>;

/** The most a gh call may print: a page of 100 jobs stays far below it. */
export const GH_MAX_BUFFER = 16 * 1024 * 1024;

/** The GitHub CLI, which reads GH_TOKEN from the environment, run through `run` (Node's execFile by default). */
export function ghCli(run: RunFile = promisify(execFile)): RunGh {
  return async (args) => (await run('gh', [...args], { windowsHide: true, maxBuffer: GH_MAX_BUFFER })).stdout;
}

/** One page of the jobs API, and the count of jobs across every page. */
export interface JobsPage {
  readonly total: number;
  readonly jobs: readonly RunJob[];
}

/** The most jobs the API returns on one page. */
export const JOBS_PER_PAGE = 100;

/** The jobs a page of `GET .../runs/{id}/jobs?filter=latest` lists, refusing one in a shape GitHub never sends. */
export function jobsPageOf(payload: unknown): JobsPage {
  if (!isRecord(payload) || typeof payload['total_count'] !== 'number' || !Array.isArray(payload['jobs'])) {
    throw new Error('the jobs page has no total_count and jobs list');
  }
  const jobs = payload['jobs'].map((job: unknown): RunJob => {
    const name = isRecord(job) ? stringField(job, 'name') : undefined;
    const status = isRecord(job) ? stringField(job, 'status') : undefined;
    if (!isRecord(job) || name === undefined || status === undefined) {
      throw new Error('a listed job has no name and status');
    }
    return { name, status, conclusion: stringField(job, 'conclusion') ?? null };
  });
  return { total: payload['total_count'], jobs };
}

/**
 * Every job of the run at its newest attempt (`filter=latest`), page by page until the listed count is reached or a
 * page comes back empty. After a re-run of the failed jobs, a job that passed in attempt 1 still counts by that pass,
 * whatever the new attempt lists for it.
 */
export async function listJobs(gh: RunGh, run: RunRef): Promise<RunJob[]> {
  const jobs: RunJob[] = [];
  for (let page = 1; ; page += 1) {
    const path = `repos/${run.repo}/actions/runs/${run.runId}/jobs?filter=latest&per_page=${JOBS_PER_PAGE}&page=${page}`;
    const listed = jobsPageOf(JSON.parse(await gh(['api', path])));
    jobs.push(...listed.jobs);
    if (listed.jobs.length === 0 || jobs.length >= listed.total) {
      return jobs;
    }
  }
}

/**
 * The jobs other than `self` that did not complete with success. Each matrix leg is its own job here, which
 * `needs.<job>.result` is not: GitHub folds a matrix into one result, and a leg cancelled because no runner
 * took it left that result a success, so the summary passed a run that never tested one OS.
 */
export function unpassedJobs(jobs: readonly RunJob[], self: string): RunJob[] {
  return jobs.filter((job) => job.name !== self && !(job.status === 'completed' && job.conclusion === 'success'));
}

/** The run GitHub Actions describes in the environment (GITHUB_REPOSITORY, GITHUB_RUN_ID). */
export function runFromEnv(env: Readonly<Record<string, string | undefined>>): RunRef {
  const repo = env['GITHUB_REPOSITORY'];
  const runId = env['GITHUB_RUN_ID'];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !runId || !/^\d+$/.test(runId)) {
    throw new Error('needs GITHUB_REPOSITORY (owner/name) and GITHUB_RUN_ID (a number)');
  }
  return { repo, runId };
}

/** Lists the run's jobs and fails, naming each, unless every job but `self` completed with success. */
export async function checkEveryJob(run: RunRef, self: string, gh: RunGh, out: (line: string) => void): Promise<number> {
  const jobs = await listJobs(gh, run);
  const others = jobs.filter((job) => job.name !== self);
  if (others.length === 0) {
    out(`every-check: run ${run.runId} lists no job but ${self}`);
    return EXIT_FINDINGS;
  }
  const unpassed = unpassedJobs(jobs, self);
  for (const job of unpassed) {
    out(`every-check: ${job.name} ${job.status === 'completed' ? `ended ${job.conclusion ?? 'with no conclusion'}` : `is still ${job.status}`}`);
  }
  if (unpassed.length > 0) {
    return EXIT_FINDINGS;
  }
  out(`every-check: all ${others.length} jobs of run ${run.runId} passed`);
  return EXIT_CLEAN;
}
