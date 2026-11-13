import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { isRecord, stringField } from '../lib/guards.ts';

/** One job of a workflow run attempt, as the jobs API lists it. */
export interface RunJob {
  readonly name: string;
  readonly status: string;
  /** Null until the job completes. */
  readonly conclusion: string | null;
}

/** The run attempt whose jobs are checked. */
export interface RunAttempt {
  /** `owner/name`. */
  readonly repo: string;
  readonly runId: string;
  readonly attempt: string;
}

/** Runs the GitHub CLI with the arguments, never through a shell; resolves with what it prints. */
export type RunGh = (args: readonly string[]) => Promise<string>;

/** One page of the jobs API, and the count of jobs across every page. */
export interface JobsPage {
  readonly total: number;
  readonly jobs: readonly RunJob[];
}

/** The most jobs the API returns on one page. */
export const JOBS_PER_PAGE = 100;

/** The jobs a page of `GET .../attempts/{n}/jobs` lists, refusing one in a shape GitHub never sends. */
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

/** Every job of the run attempt, page by page until the listed count is reached or a page comes back empty. */
export async function listJobs(gh: RunGh, run: RunAttempt): Promise<RunJob[]> {
  const jobs: RunJob[] = [];
  for (let page = 1; ; page += 1) {
    const path = `repos/${run.repo}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`;
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

/** The run attempt GitHub Actions describes in the environment (GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT). */
export function runAttemptFromEnv(env: Readonly<Record<string, string | undefined>>): RunAttempt {
  const repo = env['GITHUB_REPOSITORY'];
  const runId = env['GITHUB_RUN_ID'];
  const attempt = env['GITHUB_RUN_ATTEMPT'];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !runId || !/^\d+$/.test(runId) || !attempt || !/^\d+$/.test(attempt)) {
    throw new Error('needs GITHUB_REPOSITORY (owner/name), GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT (numbers)');
  }
  return { repo, runId, attempt };
}

/** Lists the run attempt's jobs and fails, naming each, unless every job but `self` completed with success. */
export async function checkEveryJob(run: RunAttempt, self: string, gh: RunGh, out: (line: string) => void): Promise<number> {
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
