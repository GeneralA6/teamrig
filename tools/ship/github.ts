import { spawnSync } from 'node:child_process';
import { listAt, numberAt, stringAt } from './json.ts';

/**
 * ship's GitHub reads and writes through `gh api`, with the ship token in that child's GH_TOKEN only.
 * The token is fine-grained, and fine-grained tokens get no Checks permission (a GitHub App one), so the
 * proof that a check passed comes from the Actions jobs of the head sha (Actions: read) and its commit
 * statuses (Commit statuses: read). A listed check that neither shows is missing, and missing is a fail.
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
}

export interface CommitStatus {
  context: string;
  state: string;
}

export type CheckState = 'passed' | 'failed' | 'pending' | 'missing';

export interface CheckOutcome {
  name: string;
  state: CheckState;
  detail: string;
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

export function parseJobs(json: string): Job[] {
  return listAt(json, 'jobs', 'run jobs').map(job => {
    const conclusion = job['conclusion'];
    return { name: stringAt(job, 'name', 'job'), status: stringAt(job, 'status', 'job'), conclusion: typeof conclusion === 'string' ? conclusion : null };
  });
}

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

/** Each listed check must show up and every run of it must pass; skipped or neutral is not a pass. */
export function evaluate(required: readonly string[], jobs: readonly Job[], statuses: readonly CommitStatus[]): CheckOutcome[] {
  return required.map(name => {
    const ownJobs = jobs.filter(job => job.name === name);
    const ownStatuses = statuses.filter(status => status.context === name);
    if (ownJobs.length === 0 && ownStatuses.length === 0) return { name, state: 'missing', detail: 'no job or status of that name' };
    const results = [...ownJobs.map(job => (job.status === 'completed' ? (job.conclusion ?? 'none') : job.status)), ...ownStatuses.map(status => status.state)];
    const detail = results.join(', ');
    if (results.every(result => result === 'success')) return { name, state: 'passed', detail };
    const running = ownJobs.some(job => job.status !== 'completed') || ownStatuses.some(status => status.state === 'pending');
    return { name, state: running ? 'pending' : 'failed', detail };
  });
}

export type Verdict = 'passed' | 'failed' | 'waiting';

export function verdictOf(outcomes: readonly CheckOutcome[]): Verdict {
  if (outcomes.some(outcome => outcome.state === 'failed')) return 'failed';
  return outcomes.every(outcome => outcome.state === 'passed') ? 'passed' : 'waiting';
}

/** Every listed check of a commit, read from the Actions jobs and the commit statuses. */
export function readChecks(gh: Gh, repo: string, sha: string, required: readonly string[]): CheckOutcome[] {
  const runs = newestRuns(parseRuns(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])));
  const jobs = runs.flatMap(run => parseJobs(gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`])));
  const statuses = parseStatuses(gh(['api', `repos/${repo}/commits/${sha}/status`]));
  return evaluate(required, jobs, statuses);
}
