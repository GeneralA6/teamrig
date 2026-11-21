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
  /** The branch the run checked: a pull request's head branch, or the pushed branch; null when GitHub names none. */
  branch: string | null;
  /** `queued`, `in_progress`, `completed`, ...; null when GitHub names none. */
  status: string | null;
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
  /** The attempt GitHub names on the job itself; absent when it names none. A re-run's jobs name the new attempt. */
  jobAttempt?: number;
  /** When the job was queued, began and completed, as GitHub gives them (ISO 8601); absent when it gives none. */
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  /** Set by `settleJobs` on a job it read as completed though GitHub lists it running: why, for the check's detail. */
  note?: string;
  /** Set by `settleJobs` on a job failed for running past the check time limit: no re-run proves it (#1341). */
  limited?: true;
}

export interface CommitStatus {
  context: string;
  state: string;
}

/**
 * `unstarted`: every run of the check that did not pass is a job GitHub cancelled before any step ran, in a run's first
 * attempt. `flaky`: the same, but among them a check listed as flaky failed in its run's first attempt (T2988).
 */
export type CheckState = 'passed' | 'failed' | 'pending' | 'missing' | 'unstarted' | 'flaky';

export interface CheckOutcome {
  name: string;
  state: CheckState;
  detail: string;
  /** For an `unstarted` or `flaky` check, the runs whose jobs a re-run would start again; empty otherwise. */
  reruns: readonly number[];
}

export function parseRuns(json: string): Run[] {
  return listAt(json, 'workflow_runs', 'actions runs').map(run => {
    const branch = run['head_branch'];
    return {
      id: numberAt(run, 'id', 'run'),
      workflowId: numberAt(run, 'workflow_id', 'run'),
      event: stringAt(run, 'event', 'run'),
      runNumber: numberAt(run, 'run_number', 'run'),
      runAttempt: numberAt(run, 'run_attempt', 'run'),
      branch: typeof branch === 'string' ? branch : null,
      status: typeof run['status'] === 'string' ? run['status'] : null,
    };
  });
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
      ...timesOf(job),
    };
  });
}

/** A job's queue, start and completion times, each only when GitHub gives one as text. */
function timesOf(job: Record<string, unknown>): Pick<Job, 'jobAttempt' | 'createdAt' | 'startedAt' | 'completedAt'> {
  const text = (key: string): string | undefined => {
    const value = job[key];
    return typeof value === 'string' ? value : undefined;
  };
  const created = text('created_at');
  const started = text('started_at');
  const completed = text('completed_at');
  const attempt = job['run_attempt'];
  return { ...(typeof attempt === 'number' ? { jobAttempt: attempt } : {}), ...(created === undefined ? {} : { createdAt: created }), ...(started === undefined ? {} : { startedAt: started }), ...(completed === undefined ? {} : { completedAt: completed }) };
}

/** The minutes a check may stay queued or running when repos.json gives no `checkMinutes` (#1341). */
export const CHECK_MINUTES_DEFAULT = 30;

/** A GitHub time in ms since the epoch; undefined for none or text that is no time. */
function msOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The jobs as the merge reads them, so no check holds the ship slot to the overall deadline (#1341). A job GitHub
 * still lists queued or in progress after its run completed, or with its completion time set, is completed: its
 * conclusion when GitHub gave one, else failed, its detail saying so. A job still queued (since its queue time) or
 * running (since its start) for `checkMinutes` or more at `now` is failed, naming its minutes and the limit; no re-run
 * proves it. With no `now`, or no time to count from, the job stays as listed.
 */
export function settleJobs(jobs: readonly Job[], runs: readonly Run[], now: number | undefined, checkMinutes: number): Job[] {
  const doneRuns = new Map(runs.filter(run => run.status === 'completed').map(run => [run.id, run.runAttempt]));
  // A run read as completed speaks only for its jobs of that attempt: a re-run's jobs, read after a stale run status,
  // name a newer attempt and still wait.
  const runDone = (job: Job): boolean => doneRuns.has(job.runId) && (job.jobAttempt === undefined || job.jobAttempt === doneRuns.get(job.runId));
  return jobs.map((job): Job => {
    if (job.status === 'completed') return job;
    if (runDone(job) || job.completedAt !== undefined) {
      const why = runDone(job) ? 'its run completed' : 'its completion time was set';
      return { ...job, status: 'completed', conclusion: job.conclusion ?? 'failure', note: `listed ${job.status} after ${why}${job.conclusion === null ? ', with no conclusion' : ''}` };
    }
    const since = msOf(job.status === 'queued' ? job.createdAt : (job.startedAt ?? job.createdAt));
    if (now === undefined || since === undefined || now - since < checkMinutes * 60_000) return job;
    const minutes = Math.floor((now - since) / 60_000);
    return { ...job, status: 'completed', conclusion: 'failure', note: `${job.status} ${minutes} min, past the ${checkMinutes} min limit (checkMinutes)`, limited: true };
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

/** The checks a merge waits for, as repos.json lists them (repos.ts). */
export interface RequiredChecks {
  readonly names: readonly string[];
  /** The job that fails whenever any other job of its run did not succeed (`every check passed`), or null. */
  readonly summary: string | null;
  /** Checks a failure of which is re-run once before it fails the merge (repos.ts `flaky`). */
  readonly flaky: readonly string[];
  /** The minutes a check may stay queued or running before it counts failed (repos.ts `checkMinutes`); unset, CHECK_MINUTES_DEFAULT. */
  readonly checkMinutes?: number;
  /** Checks the summary's run makes only for some changes, not waited for once the summary passed without them (repos.ts `conditional`). */
  readonly conditional: readonly string[];
}

const PLANNED_OUT = 'not made by its run, whose summary passed: a check this change does not need';

/**
 * A `conditional` check that is missing counts as passed once the summary passed: the run made every job it planned
 * and each succeeded, so a docs-only run's absent windows and macOS legs (T4617) do not hold the merge until its
 * timeout. Before the summary passed, a missing one still waits; one that shows keeps its own verdict.
 */
export function plannedOut(outcomes: readonly CheckOutcome[], summary: string | null, conditional: readonly string[]): CheckOutcome[] {
  const summaryPassed = summary !== null && outcomes.some(outcome => outcome.name === summary && outcome.state === 'passed');
  return outcomes.map((outcome): CheckOutcome =>
    summaryPassed && outcome.state === 'missing' && conditional.includes(outcome.name) ? { ...outcome, state: 'passed', detail: PLANNED_OUT } : outcome,
  );
}

const firstAttemptUnstarted = (job: Job): boolean => cancelledUnstarted(job) && job.runAttempt === 1;

/**
 * A job of a check listed as flaky that failed in its run's first attempt: a test that fails under load and passes
 * alone (T2532) says nothing sure about the change until it fails again on a re-run of the same sha (T2988).
 */
const firstAttemptFlaky = (flaky: readonly string[]) => (job: Job): boolean =>
  flaky.includes(job.name) && job.status === 'completed' && job.conclusion === 'failure' && job.started && job.runAttempt === 1 && job.limited !== true;

/**
 * The runs whose summary job's failure only echoes legs a re-run may still prove: every other job of the run that
 * did not succeed was cancelled before any step ran, or is a flaky check's failure, in the run's first attempt. A
 * re-run starts the summary again with them.
 */
function echoingRuns(jobs: readonly Job[], summary: string | null, rerunnable: (job: Job) => boolean): ReadonlySet<number> {
  if (summary === null) return new Set();
  const short = new Map<number, Job[]>();
  for (const job of jobs) {
    if (job.name === summary || job.conclusion === 'success') continue;
    short.set(job.runId, [...(short.get(job.runId) ?? []), job]);
  }
  return new Set([...short].filter(([, legs]) => legs.every(rerunnable)).map(([runId]) => runId));
}

const ECHO = 'an echo of legs cancelled before any step ran';
const FLAKY_ECHO = "an echo of a flaky leg's failure";

/**
 * Each listed check must show up and every run of it must pass; skipped or neutral is not a pass. A check whose only
 * runs short of a pass are jobs cancelled before any step ran, in a run's first attempt, is `unstarted`: a re-run may
 * still prove it. The same in a later attempt is a fail, so a runner that never comes is re-run once only. A check in
 * `flaky` whose only runs short of a pass failed in a run's first attempt is `flaky`, re-run once the same way (T2988).
 * The `summary` job's failure counts as such a job when it only echoes them (`echoingRuns`); any other failure fails.
 */
export function evaluate(required: readonly string[], jobs: readonly Job[], statuses: readonly CommitStatus[], summary: string | null = null, flaky: readonly string[] = []): CheckOutcome[] {
  const flakyFailure = firstAttemptFlaky(flaky);
  const echoing = echoingRuns(jobs, summary, (job) => firstAttemptUnstarted(job) || flakyFailure(job));
  const flakyRuns = new Set(jobs.filter(flakyFailure).map((job) => job.runId));
  const echoes = (job: Job): boolean => job.name === summary && job.status === 'completed' && job.conclusion === 'failure' && echoing.has(job.runId);
  const awaitsRerun = (job: Job): boolean => firstAttemptUnstarted(job) || flakyFailure(job) || echoes(job);
  const isFlaky = (job: Job): boolean => flakyFailure(job) || (echoes(job) && flakyRuns.has(job.runId));
  const jobResult = (job: Job): string => {
    if (job.status !== 'completed') return job.status;
    if (job.note !== undefined) return `${job.conclusion ?? 'none'}, ${job.note}`;
    if (echoes(job)) return `failure, ${flakyRuns.has(job.runId) ? FLAKY_ECHO : ECHO}`;
    if (!cancelledUnstarted(job)) return job.conclusion ?? 'none';
    return job.runAttempt === 1 ? UNSTARTED : `${UNSTARTED}, again on attempt ${job.runAttempt}`;
  };
  return required.map((name): CheckOutcome => {
    const ownJobs = jobs.filter(job => job.name === name);
    const ownStatuses = statuses.filter(status => status.context === name);
    if (ownJobs.length === 0 && ownStatuses.length === 0) return { name, state: 'missing', detail: 'no job or status of that name', reruns: [] };
    const results = [...ownJobs.map(jobResult), ...ownStatuses.map(status => status.state)];
    const detail = results.join(', ');
    const passed = ownJobs.every(job => job.status === 'completed' && job.conclusion === 'success') && ownStatuses.every(status => status.state === 'success');
    if (passed) return { name, state: 'passed', detail, reruns: [] };
    const running = ownJobs.some(job => job.status !== 'completed') || ownStatuses.some(status => status.state === 'pending');
    if (running) return { name, state: 'pending', detail, reruns: [] };
    const short = ownJobs.filter(job => job.conclusion !== 'success');
    if (short.every(awaitsRerun) && ownStatuses.every(status => status.state === 'success')) {
      return { name, state: short.some(isFlaky) ? 'flaky' : 'unstarted', detail, reruns: [...new Set(short.map(job => job.runId))] };
    }
    return { name, state: 'failed', detail, reruns: [] };
  });
}

/** `rerun`: nothing failed or runs, and some check waits only on a re-run (jobs cancelled before any step ran, a flaky failure). */
export type Verdict = 'passed' | 'failed' | 'waiting' | 'rerun';

export function verdictOf(outcomes: readonly CheckOutcome[]): Verdict {
  if (outcomes.some(outcome => outcome.state === 'failed')) return 'failed';
  if (outcomes.some(outcome => outcome.state === 'pending' || outcome.state === 'missing')) return 'waiting';
  return outcomes.some(outcome => outcome.state === 'unstarted' || outcome.state === 'flaky') ? 'rerun' : 'passed';
}

/** Starts the failed and cancelled jobs of a completed run again, as a new attempt of it (Actions: write). */
export function rerunFailedJobs(gh: Gh, repo: string, runId: number): void {
  gh(['api', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, '-X', 'POST']);
}

/**
 * Every listed check of a commit on `branch`, read from the Actions jobs and the commit statuses. Only the runs of
 * that branch count: the same sha re-shipped under a new branch name (the route after a cancelled job) still carries
 * the old branch's runs, and before the new branch's run exists those were all there was, so its cancel failed the
 * merge (T2749). The new branch's checks are missing until its run starts, and missing waits. With `now`, the jobs are
 * settled first (`settleJobs`): one listed running after its run completed, or past the time limit, is read as done.
 */
export function readChecks(gh: Gh, repo: string, sha: string, branch: string, required: RequiredChecks, now?: number): CheckOutcome[] {
  const runs = newestRuns(parseRuns(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])).filter(run => run.branch === branch));
  const listed = runs.flatMap(run => parseJobs(gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]), run));
  const jobs = settleJobs(listed, runs, now, required.checkMinutes ?? CHECK_MINUTES_DEFAULT);
  const statuses = parseStatuses(gh(['api', `repos/${repo}/commits/${sha}/status`]));
  return plannedOut(evaluate(required.names, jobs, statuses, required.summary, required.flaky), required.summary, required.conditional);
}
