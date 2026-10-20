import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { type Gh, type GhSpawn, type Job, type Run, evaluate, ghWithToken, newestRuns, parseJobs, parseRuns, parseStatuses, readChecks, verdictOf } from './github.ts';

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
  assert.deepEqual(parseJobs('{"jobs":[{"name":"a","status":"completed","conclusion":"success"},{"name":"b","status":"queued","conclusion":null}]}'), [
    { name: 'a', status: 'completed', conclusion: 'success' },
    { name: 'b', status: 'queued', conclusion: null },
  ]);
  assert.deepEqual(parseStatuses('{"state":"success","statuses":[{"context":"ext/ci","state":"success"}]}'), [{ context: 'ext/ci', state: 'success' }]);
  assert.throws(() => parseRuns('{"message":"Not Found"}'), /actions runs: expected a "workflow_runs" list/);
  assert.throws(() => parseRuns('{"workflow_runs":[{"id":"7"}]}'), /run: "id" is not a number/);
  assert.throws(() => parseJobs('{"jobs":[{"status":"completed"}]}'), /job: "name" is not a string/);
});

test('keeps the newest run of each workflow and event, so an older cancelled run does not count', () => {
  const run = (id: number, workflowId: number, event: string, runNumber: number, runAttempt = 1): Run => ({ id, workflowId, event, runNumber, runAttempt });
  const kept = newestRuns([run(1, 1, 'push', 4), run(2, 1, 'push', 5), run(3, 1, 'pull_request', 6), run(4, 1, 'pull_request', 6, 2), run(5, 2, 'push', 1)]);
  assert.deepEqual(kept.map(({ id }) => id).sort(), [2, 4, 5]);
});

const job = (name: string, conclusion: string | null, status = 'completed'): Job => ({ name, status, conclusion });

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
  assert.deepEqual(readChecks(gh, REPO, SHA, ['gates', 'ext/ci']).map(({ state }) => state), ['passed', 'passed']);
  assert.equal(gh.mock.callCount(), 3);
});
