import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPull } from '../../issues/pull.ts';
import { SESSION_PUSH } from '../../issues/status-push.ts';
import { FakeIssueHost } from '../../testing/fake-issue-host.ts';
import { codeHostOnly, trackerOnly } from '../../testing/split-hosts.ts';
import { testTask } from '../../testing/task.ts';
import { pushRepos, type PushRun } from './issue-push.ts';

const REPO = 'acme/web';

/** Open pull request `number` of acme/web, green and mergeable. */
function openPull(number: number): HostPull {
  return {
    repo: REPO,
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: 'open',
    draft: false,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    mergedAt: undefined,
    closedAt: undefined,
    authorAssociation: 'MEMBER',
    author: 'dev',
    authorKind: 'User',
    posts: [],
    head: `t${number}-fix`,
    fork: false,
    mergeable: 'mergeable',
    checks: 'passing',
    review: 'none',
    failedJobs: [],
    closes: [],
  };
}

/** A preview push of acme/web through `tracker` and `code`, two hosts, against one in-progress task holding #9. */
function runOn(tracker: FakeIssueHost, code: FakeIssueHost): PushRun {
  return {
    host: trackerOnly(tracker),
    pulls: codeHostOnly(code),
    repos: [REPO],
    since: '2030-01-01',
    tasks: () => Promise.resolve([testTask({ id: 'T9', ref: 'gh:acme/web#9', status: 'in-progress' })]),
    send: false,
    limits: SESSION_PUSH,
    logins: new Map(),
    told: new Set(),
    fields: undefined,
  };
}

describe('pushRepos (T4619)', () => {
  it("reads the open pull requests from the code host, never the tracker, for a number the tracker's list left out", async () => {
    const tracker = new FakeIssueHost();
    const code = new FakeIssueHost().holdsPulls(REPO, [openPull(9)]);
    const lines: string[] = [];
    const totals = await pushRepos(runOn(tracker, code), (line) => lines.push(line));
    assert.deepEqual(totals, { sent: 0, writes: 0, failures: [] });
    assert.deepEqual([tracker.pullReads, code.pullReads], [[], [{ repo: REPO, since: undefined }]]);
    assert.ok(
      lines.some((line) => line.includes('1 on an open pull request')),
      lines.join('\n'),
    );
    assert.ok(!lines.some((line) => line.includes('not listed')), lines.join('\n'));
  });

  it("says the code host's failed read, and leaves the number as one the list left out", async () => {
    const tracker = new FakeIssueHost();
    const code = new FakeIssueHost().failsPulls('HTTP 502');
    const lines: string[] = [];
    await pushRepos(runOn(tracker, code), (line) => lines.push(line));
    assert.ok(lines.includes('NOTE acme/web: its pull requests could not be read (HTTP 502), so a number below may be one'), lines.join('\n'));
    assert.ok(
      lines.some((line) => line.includes('1 not listed')),
      lines.join('\n'),
    );
    assert.deepEqual(tracker.pullReads, []);
  });
});
