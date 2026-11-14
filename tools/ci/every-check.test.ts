import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { checkEveryJob, GH_MAX_BUFFER, ghCli, jobsPageOf, listJobs, RELIST, runFromEnv, unpassedJobs, type Relist, type RunFile, type RunGh, type RunJob, type RunRef } from './every-check.ts';

const SELF = 'every check passed';
const RUN: RunRef = { repo: 'acme/web', runId: '43' };

function job(name: string, conclusion: string | null, status = 'completed'): RunJob {
  return { name, status, conclusion };
}

/** The jobs API's page shape for these jobs. */
function page(total: number, jobs: readonly RunJob[]): string {
  return JSON.stringify({ total_count: total, jobs: jobs.map((one) => ({ id: 1, ...one })) });
}

/** A gh that answers each call with the next page, recording the arguments. */
function ghServing(pages: readonly string[]): { gh: RunGh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: RunGh = (args) => {
    calls.push([...args]);
    const next = pages[calls.length - 1];
    return next === undefined ? Promise.reject(new Error('no more pages')) : Promise.resolve(next);
  };
  return { gh, calls };
}

describe('ghCli', () => {
  it('runs gh by argv with no window and a large buffer, and resolves with what it printed', async () => {
    const calls: { file: string; args: readonly string[]; options: { windowsHide: boolean; maxBuffer: number } }[] = [];
    const run: RunFile = (file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve({ stdout: '{"total_count":0,"jobs":[]}' });
    };
    assert.equal(await ghCli(run)(['api', 'repos/acme/web/actions/runs/43/jobs']), '{"total_count":0,"jobs":[]}');
    assert.deepEqual(calls, [{ file: 'gh', args: ['api', 'repos/acme/web/actions/runs/43/jobs'], options: { windowsHide: true, maxBuffer: GH_MAX_BUFFER } }]);
  });

  it('rejects with the run failure, so a check never passes on a gh that failed', async () => {
    const run: RunFile = () => Promise.reject(new Error('spawn gh ENOENT'));
    await assert.rejects(ghCli(run)(['api', 'x']), /ENOENT/);
  });
});

describe('jobsPageOf', () => {
  it('reads the count and each job, a running job with no conclusion', () => {
    assert.deepEqual(jobsPageOf(JSON.parse(page(2, [job('gates', 'success'), job(SELF, null, 'in_progress')]))), {
      total: 2,
      jobs: [job('gates', 'success'), job(SELF, null, 'in_progress')],
    });
  });

  it('refuses a page or a job in a shape GitHub never sends', () => {
    assert.throws(() => jobsPageOf([]), /no total_count and jobs list/);
    assert.throws(() => jobsPageOf({ total_count: 1 }), /no total_count and jobs list/);
    assert.throws(() => jobsPageOf({ total_count: 1, jobs: [{ name: 'gates' }] }), /no name and status/);
    assert.throws(() => jobsPageOf({ total_count: 1, jobs: ['gates'] }), /no name and status/);
  });
});

describe('listJobs', () => {
  it('reads page after page until the listed count, each job at its newest attempt, so a re-run keeps what attempt 1 passed', async () => {
    const { gh, calls } = ghServing([page(3, [job('a', 'success'), job('b', 'success')]), page(3, [job('c', 'success')])]);
    assert.deepEqual((await listJobs(gh, RUN)).map((one) => one.name), ['a', 'b', 'c']);
    assert.deepEqual(calls, [
      ['api', 'repos/acme/web/actions/runs/43/jobs?filter=latest&per_page=100&page=1'],
      ['api', 'repos/acme/web/actions/runs/43/jobs?filter=latest&per_page=100&page=2'],
    ]);
  });

  it('stops at an empty page even when the count promised more', async () => {
    const { gh, calls } = ghServing([page(5, [job('a', 'success')]), page(5, [])]);
    assert.deepEqual((await listJobs(gh, RUN)).map((one) => one.name), ['a']);
    assert.equal(calls.length, 2);
  });
});

describe('unpassedJobs', () => {
  it('keeps each job but the summary that did not complete with success, a matrix leg alone', () => {
    const jobs = [
      job('gates', 'success'),
      job('test (macos-latest, node 22)', 'cancelled'),
      job('test (macos-latest, node 24)', 'success'),
      job('coverage', 'skipped'),
      job('size-rule', 'failure'),
      job('plugin-version', null, 'queued'),
      job('scrub', 'success', 'in_progress'),
      job('lint', 'failure', 'in_progress'),
      job(SELF, null, 'in_progress'),
    ];
    assert.deepEqual(unpassedJobs(jobs, SELF).map((one) => one.name), ['test (macos-latest, node 22)', 'coverage', 'size-rule', 'plugin-version', 'lint']);
  });
});

describe('runFromEnv', () => {
  it('reads the repository and the run', () => {
    assert.deepEqual(runFromEnv({ GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_ID: '43', GITHUB_RUN_ATTEMPT: '2' }), RUN);
  });

  it('refuses a missing or malformed value, which would go into an API path', () => {
    const good = { GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_ID: '43' };
    for (const env of [{}, { ...good, GITHUB_REPOSITORY: 'acme/web/../x' }, { ...good, GITHUB_RUN_ID: '43&page=9' }, { ...good, GITHUB_RUN_ID: '' }]) {
      assert.throws(() => runFromEnv(env), /needs GITHUB_REPOSITORY/);
    }
  });
});

describe('checkEveryJob', () => {
  /** A relist that records each pause instead of sleeping. */
  function relisting(tries: number): { relist: Relist; pauses: number[] } {
    const pauses: number[] = [];
    return { relist: { tries, pauseMs: 10_000, sleep: (ms) => { pauses.push(ms); return Promise.resolve(); } }, pauses };
  }

  /** Checks a run whose jobs API lists `listings` in turn, one page each. */
  async function checkListings(listings: readonly (readonly RunJob[])[], tries = 0): Promise<{ code: number; lines: string[]; listed: number; pauses: number[] }> {
    const lines: string[] = [];
    const served = ghServing(listings.map((jobs) => page(jobs.length, jobs)));
    const { relist, pauses } = relisting(tries);
    const code = await checkEveryJob(RUN, SELF, served.gh, (line) => lines.push(line), relist);
    return { code, lines, listed: served.calls.length, pauses };
  }

  async function check(jobs: readonly RunJob[]): Promise<{ code: number; lines: string[] }> {
    const { code, lines } = await checkListings([jobs]);
    return { code, lines };
  }

  it('passes on the run 43534894842 hit: a job the API still lists in_progress though it concluded with success', async () => {
    const result = await checkListings([[job('scrub and DCO gates', 'success', 'in_progress'), job('coverage gate', 'success'), job(SELF, null, 'in_progress')]], 6);
    assert.deepEqual(result, { code: EXIT_CLEAN, lines: ['every-check: all 2 jobs of run 43 passed'], listed: 1, pauses: [] });
  });

  it('lists the jobs again while one has no conclusion yet, and passes once it concludes with success', async () => {
    const lagging = [job('gates', null, 'in_progress'), job('coverage', 'success'), job(SELF, null, 'in_progress')];
    const concluded = [job('gates', 'success'), job('coverage', 'success'), job(SELF, null, 'in_progress')];
    const result = await checkListings([lagging, lagging, concluded], 6);
    assert.deepEqual(result, { code: EXIT_CLEAN, lines: ['every-check: all 2 jobs of run 43 passed'], listed: 3, pauses: [10_000, 10_000] });
  });

  it('gives up after its tries and names the job that never concluded', async () => {
    const lagging = [job('gates', null, 'in_progress'), job(SELF, null, 'in_progress')];
    const result = await checkListings([lagging, lagging, lagging], 2);
    assert.deepEqual(result, { code: EXIT_FINDINGS, lines: ['every-check: gates is still in_progress'], listed: 3, pauses: [10_000, 10_000] });
  });

  it('fails at once on a job that concluded otherwise, listing nothing again', async () => {
    const result = await checkListings([[job('lint', 'failure', 'in_progress'), job('coverage', 'success'), job(SELF, null, 'in_progress')]], 6);
    assert.deepEqual(result, { code: EXIT_FINDINGS, lines: ['every-check: lint ended failure'], listed: 1, pauses: [] });
  });

  it('waits 10 s between listings, 6 times at most, by default', () => {
    assert.equal(RELIST.tries, 6);
    assert.equal(RELIST.pauseMs, 10_000);
  });

  it('passes when every other job completed with success', async () => {
    assert.deepEqual(await check([job('gates', 'success'), job('test (ubuntu-latest, node 22)', 'success'), job(SELF, null, 'in_progress')]), {
      code: EXIT_CLEAN,
      lines: ['every-check: all 2 jobs of run 43 passed'],
    });
  });

  it('fails on the run #937 hit: one matrix leg cancelled with no runner while the others passed', async () => {
    const result = await check([job('test (ubuntu-latest, node 22)', 'success'), job('test (macos-latest, node 22)', 'cancelled'), job(SELF, null, 'in_progress')]);
    assert.deepEqual(result, { code: EXIT_FINDINGS, lines: ['every-check: test (macos-latest, node 22) ended cancelled'] });
  });

  it('names a job still running and one completed with no conclusion', async () => {
    const result = await check([job('gates', null, 'in_progress'), job('coverage', null), job(SELF, null, 'in_progress')]);
    assert.deepEqual(result, { code: EXIT_FINDINGS, lines: ['every-check: gates is still in_progress', 'every-check: coverage ended with no conclusion'] });
  });

  it('fails when the run lists no job but the summary, so a wrong run id never passes', async () => {
    assert.deepEqual(await check([job(SELF, null, 'in_progress')]), { code: EXIT_FINDINGS, lines: ['every-check: run 43 lists no job but every check passed'] });
  });
});
