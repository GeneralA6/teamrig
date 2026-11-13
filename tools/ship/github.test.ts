import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { type Gh, type GhSpawn, type Job, type Run, evaluate, ghWithToken, newestRuns, parseJobs, parseRuns, parseStatuses, readChecks, rerunFailedJobs, verdictOf } from './github.ts';

const TOKEN = ['github', '_pat_', 'secret_value'].join('');
const REPO = 'Owner/repo';
const SHA = 'abc1234';

test('gh gets the token in its own environment only', () => {
  const spawn = mock.fn<GhSpawn>(() => ({ status: 0, stdout: '{}', stderr: '' }));
  const gh = ghWithToken(TOKEN, spawn);
  assert.equal(gh(['api', 'user']), '{}');
  const call = spawn.mock.calls[0];
  assert.deepEqual(call?.arguments[0], ['api', 'user']);
  assert.equal(call?.arguments[1]['GH_TOKEN'], TOKEN);
  assert.equal(call?.arguments[1]['GH_PROMPT_DISABLED'], '1');
  assert.notEqual(process.env['GH_TOKEN'], TOKEN);
});

test('a failed gh call throws its first error line and never the token', () => {
  const gh = ghWithToken(TOKEN, () => ({ status: 1, stdout: '', stderr: '\nHTTP 403: Resource not accessible by personal access token\n' }));
  assert.throws(() => gh(['api', 'repos/x/y/check-runs']), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'gh api repos/x/y/check-runs: HTTP 403: Resource not accessible by personal access token');
    assert.doesNotMatch(error.message, /secret_value/);
    return true;
  });
  assert.throws(() => ghWithToken(TOKEN, () => ({ status: null, stdout: '', stderr: '' }))(['pr', 'list']), /gh pr list: exit by a signal/);
});

test('parses runs, jobs and statuses, and refuses a body of the wrong shape', () => {
  assert.deepEqual(parseRuns('{"workflow_runs":[{"id":7,"workflow_id":1,"event":"push","run_number":3,"run_attempt":2}]}'), [
    { id: 7, workflowId: 1, event: 'push', runNumber: 3, runAttempt: 2 },
  ]);
  assert.deepEqual(parseJobs('{"jobs":[{"name":"a","status":"completed","conclusion":"success","steps":[{"name":"x"}]},{"name":"b","status":"queued","conclusion":null}]}', { id: 9, runAttempt: 2 }), [
    { name: 'a', status: 'completed', conclusion: 'success', runId: 9, runAttempt: 2, started: true },
    { name: 'b', status: 'queued', conclusion: null, runId: 9, runAttempt: 2, started: false },
  ]);
  assert.deepEqual(parseStatuses('{"state":"success","statuses":[{"context":"ext/ci","state":"success"}]}'), [{ context: 'ext/ci', state: 'success' }]);
  assert.throws(() => parseRuns('{"message":"Not Found"}'), /actions runs: expected a "workflow_runs" list/);
  assert.throws(() => parseRuns('{"workflow_runs":[{"id":"7"}]}'), /run: "id" is not a number/);
  assert.throws(() => parseJobs('{"jobs":[{"status":"completed"}]}', { id: 9, runAttempt: 1 }), /job: "name" is not a string/);
});

test('keeps the newest run of each workflow and event, so an older cancelled run does not count', () => {
  const run = (id: number, workflowId: number, event: string, runNumber: number, runAttempt = 1): Run => ({ id, workflowId, event, runNumber, runAttempt });
  const kept = newestRuns([run(1, 1, 'push', 4), run(2, 1, 'push', 5), run(3, 1, 'pull_request', 6), run(4, 1, 'pull_request', 6, 2), run(5, 2, 'push', 1)]);
  assert.deepEqual(kept.map(({ id }) => id).sort(), [2, 4, 5]);
});

const job = (name: string, conclusion: string | null, status = 'completed'): Job => ({ name, status, conclusion, runId: 1, runAttempt: 1, started: true });
/** A job GitHub cancelled while it waited for a runner: no step ran (PR 937's macOS job). */
const unstarted = (name: string, runId: number, runAttempt = 1): Job => ({ name, status: 'completed', conclusion: 'cancelled', runId, runAttempt, started: false });

test('a check passes only when every run of it succeeded', () => {
  const outcomes = evaluate(
    ['gates', 'test (ubuntu-latest, node 22)', 'test (macos-latest, node 24)', 'lint', 'ext/ci', 'skipped one', 'absent'],
    [job('gates', 'success'), job('test (ubuntu-latest, node 22)', 'success'), job('test (ubuntu-latest, node 22)', 'failure'), job('test (macos-latest, node 24)', null, 'in_progress'), job('lint', 'success'), job('skipped one', 'skipped')],
    [{ context: 'ext/ci', state: 'pending' }],
  );
  assert.deepEqual(
    outcomes.map(({ name, state }) => `${name}: ${state}`),
    ['gates: passed', 'test (ubuntu-latest, node 22): failed', 'test (macos-latest, node 24): pending', 'lint: passed', 'ext/ci: pending', 'skipped one: failed', 'absent: missing'],
  );
  assert.equal(outcomes[1]?.detail, 'success, failure');
});

test('the verdict fails on any failure, passes only when all passed, and waits otherwise', () => {
  assert.equal(verdictOf(evaluate(['a'], [job('a', 'success')], [])), 'passed');
  assert.equal(verdictOf(evaluate(['a', 'b'], [job('a', 'success')], [])), 'waiting');
  assert.equal(verdictOf(evaluate(['a', 'b'], [job('a', 'timed_out'), job('b', null, 'queued')], [])), 'failed');
  assert.equal(verdictOf(evaluate(['a'], [], [{ context: 'a', state: 'success' }])), 'passed');
  assert.equal(verdictOf(evaluate(['a'], [], [{ context: 'a', state: 'error' }])), 'failed');
});

test('a check short only by jobs cancelled before any step ran, in a first attempt, is unstarted and names its runs', () => {
  const [outcome] = evaluate(['mac'], [unstarted('mac', 7), unstarted('mac', 7), job('mac', 'success'), unstarted('mac', 8)], []);
  assert.deepEqual(outcome, { name: 'mac', state: 'unstarted', detail: 'cancelled before any step ran, cancelled before any step ran, success, cancelled before any step ran', reruns: [7, 8] });
  assert.equal(verdictOf(evaluate(['a', 'mac'], [job('a', 'success'), unstarted('mac', 7)], [])), 'rerun');
});

test('an unstarted cancel fails once it comes back on a later attempt, or when any other run of the check failed', () => {
  const [again] = evaluate(['mac'], [unstarted('mac', 7, 2)], []);
  assert.deepEqual(again, { name: 'mac', state: 'failed', detail: 'cancelled before any step ran, again on attempt 2', reruns: [] });
  assert.equal(evaluate(['mac'], [unstarted('mac', 7), job('mac', 'failure')], [])[0]?.state, 'failed');
  assert.equal(evaluate(['mac'], [unstarted('mac', 7)], [{ context: 'mac', state: 'error' }])[0]?.state, 'failed');
  assert.equal(evaluate(['mac'], [{ ...unstarted('mac', 7), started: true }], [])[0]?.state, 'failed', 'a job cancelled after a step began is a fail');
});

test('the verdict fails over a rerun, and waits over one while any check runs or is missing', () => {
  assert.equal(verdictOf(evaluate(['a', 'mac'], [job('a', 'failure'), unstarted('mac', 7)], [])), 'failed');
  assert.equal(verdictOf(evaluate(['a', 'mac'], [job('a', null, 'in_progress'), unstarted('mac', 7)], [])), 'waiting');
  assert.equal(verdictOf(evaluate(['absent', 'mac'], [unstarted('mac', 7)], [])), 'waiting');
});

test('the summary job failing only beside unstarted legs of its run is their echo, re-run with them', () => {
  const legs = [job('a', 'success'), unstarted('mac', 1)];
  const [, mac, all] = evaluate(['a', 'mac', 'all'], [...legs, job('all', 'failure')], [], 'all');
  assert.deepEqual(all, { name: 'all', state: 'unstarted', detail: 'failure, an echo of legs cancelled before any step ran', reruns: [1] });
  assert.equal(mac?.state, 'unstarted');
});

test('the summary job fails when any other leg of its run failed, on a later attempt, alone, in another run, or with no summary named', () => {
  const stateOfAll = (jobs: readonly Job[], summary: string | null = 'all'): string | undefined => evaluate(['all'], jobs, [], summary)[0]?.state;
  assert.equal(stateOfAll([unstarted('mac', 1), job('lint', 'failure'), job('all', 'failure')]), 'failed', 'a leg the merge does not wait for still fails it');
  assert.equal(stateOfAll([unstarted('mac', 1), job('lint', 'skipped'), job('all', 'failure')]), 'failed', 'a skipped leg is no echo');
  assert.equal(stateOfAll([unstarted('mac', 1, 2), { ...job('all', 'failure'), runAttempt: 2 }]), 'failed');
  assert.equal(stateOfAll([job('all', 'failure')]), 'failed');
  assert.equal(stateOfAll([unstarted('mac', 2), job('all', 'failure')]), 'failed');
  assert.equal(stateOfAll([unstarted('mac', 1), job('all', 'failure')], null), 'failed');
  assert.equal(stateOfAll([unstarted('mac', 1), job('all', 'cancelled')]), 'failed', 'only a summary failure echoes');
});

test('a re-run posts rerun-failed-jobs for the run', () => {
  const gh = mock.fn<Gh>(() => '');
  rerunFailedJobs(gh, REPO, 7);
  assert.deepEqual(gh.mock.calls[0]?.arguments[0], ['api', `repos/${REPO}/actions/runs/7/rerun-failed-jobs`, '-X', 'POST']);
});

test('reads the newest runs\' latest jobs and the commit statuses of the sha', () => {
  const gh = mock.fn<Gh>(args => {
    const path = args[1] ?? '';
    if (path.startsWith(`repos/${REPO}/actions/runs?head_sha=${SHA}`)) {
      return JSON.stringify({ workflow_runs: [{ id: 10, workflow_id: 1, event: 'push', run_number: 1, run_attempt: 1 }, { id: 11, workflow_id: 1, event: 'push', run_number: 2, run_attempt: 1 }] });
    }
    if (path === `repos/${REPO}/actions/runs/11/jobs?filter=latest&per_page=100`) return JSON.stringify({ jobs: [{ name: 'gates', status: 'completed', conclusion: 'success' }] });
    if (path === `repos/${REPO}/commits/${SHA}/status`) return JSON.stringify({ statuses: [{ context: 'ext/ci', state: 'success' }] });
    throw new Error(`unexpected ${path}`);
  });
  assert.deepEqual(readChecks(gh, REPO, SHA, { names: ['gates', 'ext/ci'], summary: null }).map(({ state }) => state), ['passed', 'passed']);
  assert.equal(gh.mock.callCount(), 3);
});
