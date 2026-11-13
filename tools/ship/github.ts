import { spawnSync } from 'node:child_process';
import { listAt, numberAt, stringAt } from './json.ts';

/**
 * ship's GitHub reads and writes through `gh api`, with the ship token in that child's GH_TOKEN only.
 * The token is fine-grained, and fine-grained tokens get no Checks permission (a GitHub App one), so the
 * proof that a check passed comes from the Actions jobs of the head sha (Actions: read) and its commit
 * statuses (Commit statuses: read). A listed check that neither shows is missing, and missing is a fail.
 * Actions: write lets the merge re-run a job GitHub cancelled before any step ran (`rerunFailedJobs`).
 */

/**
 * Runs `gh` with the given arguments and returns stdout; throws when gh fails, naming the first two
 * arguments, so a write puts its path second (`api repos/o/r/pulls -X POST ...`).
 */
export type Gh = (args: readonly string[]) => string;

export interface GhSpawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GhSpawn = (args: readonly string[], env: NodeJS.ProcessEnv) => GhSpawned;

const spawnGh: GhSpawn = (args, env) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', env, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export function ghWithToken(token: string, spawn: GhSpawn = spawnGh): Gh {
  return args => {
    const result = spawn(args, { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' });
    if (result.status !== 0) {
      const firstLine = result.stderr.split(/\r?\n/).find(line => line.trim() !== '') ?? `exit ${result.status ?? 'by a signal'}`;
      throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${firstLine}`);
    }
    return result.stdout;
  };
}

export interface Run {
  id: number;
  workflowId: number;
  event: string;
  runNumber: number;
  runAttempt: number;
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  /** The run the job belongs to, and which attempt of it the job is. */
  runId: number;
  runAttempt: number;
  /** Whether any step of the job began: a job GitHub cancelled while it waited for a runner has none. */
  started: boolean;
}

export interface CommitStatus {
  context: string;
  state: string;
}

/** `unstarted`: every run of the check that did not pass is a job GitHub cancelled before any step ran, in a run's first attempt. */
export type CheckState = 'passed' | 'failed' | 'pending' | 'missing' | 'unstarted';

export interface CheckOutcome {
  name: string;
  state: CheckState;
  detail: string;
  /** For an `unstarted` check, the runs whose cancelled jobs a re-run would start again; empty otherwise. */
  reruns: readonly number[];
}

export function parseRuns(json: string): Run[] {
  return listAt(json, 'workflow_runs', 'actions runs').map(run => ({
    id: numberAt(run, 'id', 'run'),
    workflowId: numberAt(run, 'workflow_id', 'run'),
    event: stringAt(run, 'event', 'run'),
    runNumber: numberAt(run, 'run_number', 'run'),
    runAttempt: numberAt(run, 'run_attempt', 'run'),
  }));
}

/** The jobs of `run`'s latest attempt (`jobs?filter=latest`). */
export function parseJobs(json: string, run: Pick<Run, 'id' | 'runAttempt'>): Job[] {
  return listAt(json, 'jobs', 'run jobs').map(job => {
    const conclusion = job['conclusion'];
    const steps = job['steps'];
    return {
      name: stringAt(job, 'name', 'job'),
      status: stringAt(job, 'status', 'job'),
      conclusion: typeof conclusion === 'string' ? conclusion : null,
      runId: run.id,
      runAttempt: run.runAttempt,
      started: Array.isArray(steps) && steps.length > 0,
    };
  });
}

/**
 * A job GitHub cancelled before any step ran: it waited for a runner that never came (PR 937's macOS job, 15 min,
 * no runner, no steps). Nothing of the change ran, so it says nothing about the change.
 */
export const cancelledUnstarted = (job: Job): boolean => job.status === 'completed' && job.conclusion === 'cancelled' && !job.started;

const UNSTARTED = 'cancelled before any step ran';

export function parseStatuses(json: string): CommitStatus[] {
  return listAt(json, 'statuses', 'combined status').map(status => ({ context: stringAt(status, 'context', 'status'), state: stringAt(status, 'state', 'status') }));
}

/** The newest run of each workflow per event: an older run of the same sha (cancelled, superseded) does not count. */
export function newestRuns(runs: readonly Run[]): Run[] {
  const newest = new Map<string, Run>();
  for (const run of runs) {
    const key = `${run.workflowId}:${run.event}`;
    const kept = newest.get(key);
    if (kept === undefined || run.runNumber > kept.runNumber || (run.runNumber === kept.runNumber && run.runAttempt > kept.runAttempt)) newest.set(key, run);
  }
  return [...newest.values()];
}

function jobResult(job: Job): string {
  if (job.status !== 'completed') return job.status;
  if (!cancelledUnstarted(job)) return job.conclusion ?? 'none';
  return job.runAttempt === 1 ? UNSTARTED : `${UNSTARTED}, again on attempt ${job.runAttempt}`;
}

/**
 * Each listed check must show up and every run of it must pass; skipped or neutral is not a pass. A check whose only
 * runs short of a pass are jobs cancelled before any step ran, in a run's first attempt, is `unstarted`: a re-run may
 * still prove it. The same in a later attempt is a fail, so a runner that never comes is re-run once only.
 */
export function evaluate(required: readonly string[], jobs: readonly Job[], statuses: readonly CommitStatus[]): CheckOutcome[] {
  return required.map((name): CheckOutcome => {
    const ownJobs = jobs.filter(job => job.name === name);
    const ownStatuses = statuses.filter(status => status.context === name);
    if (ownJobs.length === 0 && ownStatuses.length === 0) return { name, state: 'missing', detail: 'no job or status of that name', reruns: [] };
    const results = [...ownJobs.map(jobResult), ...ownStatuses.map(status => status.state)];
    const detail = results.join(', ');
    if (results.every(result => result === 'success')) return { name, state: 'passed', detail, reruns: [] };
    const running = ownJobs.some(job => job.status !== 'completed') || ownStatuses.some(status => status.state === 'pending');
    if (running) return { name, state: 'pending', detail, reruns: [] };
    const short = ownJobs.filter(job => job.conclusion !== 'success');
    const firstAttemptUnstarted = short.every(job => cancelledUnstarted(job) && job.runAttempt === 1);
    if (firstAttemptUnstarted && ownStatuses.every(status => status.state === 'success')) {
      return { name, state: 'unstarted', detail, reruns: [...new Set(short.map(job => job.runId))] };
    }
    return { name, state: 'failed', detail, reruns: [] };
  });
}

/** `rerun`: nothing failed or runs, and some check waits only on jobs cancelled before any step ran. */
export type Verdict = 'passed' | 'failed' | 'waiting' | 'rerun';

export function verdictOf(outcomes: readonly CheckOutcome[]): Verdict {
  if (outcomes.some(outcome => outcome.state === 'failed')) return 'failed';
  if (outcomes.some(outcome => outcome.state === 'pending' || outcome.state === 'missing')) return 'waiting';
  return outcomes.some(outcome => outcome.state === 'unstarted') ? 'rerun' : 'passed';
}

/** Starts the failed and cancelled jobs of a completed run again, as a new attempt of it (Actions: write). */
export function rerunFailedJobs(gh: Gh, repo: string, runId: number): void {
  gh(['api', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, '-X', 'POST']);
}

/** Every listed check of a commit, read from the Actions jobs and the commit statuses. */
export function readChecks(gh: Gh, repo: string, sha: string, required: readonly string[]): CheckOutcome[] {
  const runs = newestRuns(parseRuns(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])));
  const jobs = runs.flatMap(run => parseJobs(gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]), run));
  const statuses = parseStatuses(gh(['api', `repos/${repo}/commits/${sha}/status`]));
  return evaluate(required, jobs, statuses);
}
