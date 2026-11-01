import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { OWN_NUMBERS } from '../register/numbering.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { isIssueQuery, type GhRequest, type GhResult, type GhRunner } from './gh.ts';
import { ISSUE_LIMIT, issuePageArgs } from './issues.ts';
import type { SyncStep } from './plan.ts';
import { CLOSED_ISSUES_QUERY } from './queries.ts';
import { applySteps, closedSince, readRepo } from './sync.ts';
import type { RepoAccess } from './tokens.ts';

/** Reading through the gh login, as when no token is saved for acme. */
const LOGIN: RepoAccess = { via: 'login', env: { HOME: '/u' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' };
const URL = 'https://github.com/acme/web/issues/7';

/** A gh whose closed read fails, as a rate limit hit between the two reads would; the open read is one page. */
class ClosedFails implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly open: readonly JsonRecord[];

  constructor(open: readonly JsonRecord[]) {
    this.open = open;
  }

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    const page = { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.open } } } };
    return request.args.includes(`query=${CLOSED_ISSUES_QUERY}`)
      ? { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 403: API rate limit exceeded\n' }
      : { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify(page), stderr: '' };
  }
}

function register(): Register {
  return new Register({
    log: new JsonlEventLog(new MemoryFiles(), 'register/events.jsonl'),
    mutex: new InlineMutex(),
    numbering: OWN_NUMBERS,
    elsewhere: NOTHING_ELSEWHERE,
    goals: NO_GOAL_RECORDS,
    clock: new FakeClock('2030-01-08T10:00:00.000Z'),
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(testConfig()),
    skills: { exists: async () => false },
    autoArchive: true,
  });
}

describe('closedSince', () => {
  it('is the UTC day closedDays before now', () => {
    assert.equal(closedSince(new Date('2030-01-08T10:00:00Z'), 14), '2029-12-25');
    assert.equal(closedSince(new Date('2030-01-01T00:30:00Z'), 1), '2029-12-31');
  });
});

describe('readRepo', () => {
  it('reads the open issues, then those closed since the day, a page of each shipped query when a page holds them', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7), ghIssue('acme/web', 8, { state: 'CLOSED', stateReason: 'COMPLETED' })]);
    const read = await readRepo(gh, LOGIN, 'acme/web', '2029-12-25');
    assert.equal(read.kind, 'read');
    assert.deepEqual(read.kind === 'read' && read.issues.map((issue) => [issue.number, issue.state]), [[7, 'open'], [8, 'closed']]);
    assert.deepEqual(read.kind === 'read' && read.notes, []);
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [
        issuePageArgs({ repo: 'acme/web', state: 'open', limit: ISSUE_LIMIT }, undefined),
        issuePageArgs({ repo: 'acme/web', state: 'closed', closedSince: '2029-12-25', limit: ISSUE_LIMIT }, undefined),
      ],
    );
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args)));
  });

  it('says when a list may be cut short, or held items it could not read', async () => {
    // One more open issue than the limit: the read stops at the limit with a page still on GitHub.
    const many = Array.from({ length: ISSUE_LIMIT + 1 }, (_, index) => ghIssue('acme/web', index + 1));
    const gh = new FakeGh().holds('acme/web', [...many, { ...ghIssue('acme/web', 900, { state: 'CLOSED' }), number: 'nine hundred' }]);
    const read = await readRepo(gh, LOGIN, 'acme/web', '2029-12-25');
    assert.deepEqual(read.kind === 'read' && read.notes, [
      'the open list reached 500 issues, so it may leave some out',
      '1 closed item(s) gh printed did not read as issues and were left out',
    ]);
  });

  it('leaves the repository out whole when either read fails', async () => {
    assert.deepEqual(await readRepo(new FakeGh(), LOGIN, 'acme/nope', '2029-12-25'), {
      kind: 'failed',
      repo: 'acme/nope',
      reason: 'acme/nope is not visible to the gh login: check github.repos, or save a read-only token for acme with: save teamrig-gh-acme',
    });
    const gh = new ClosedFails([ghIssue('acme/web', 7)]);
    assert.deepEqual(await readRepo(gh, LOGIN, 'acme/web', '2029-12-25'), {
      kind: 'failed',
      repo: 'acme/web',
      reason: 'gh api graphql for the issues of acme/web exited with code 1: HTTP 403: API rate limit exceeded',
    });
    assert.equal(gh.ran.length, 2);
  });
});

describe('applySteps', () => {
  it('writes each step through the register, reports a refused one and goes on', async () => {
    const steps: SyncStep[] = [
      { kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } },
      { kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } },
      { kind: 'update', ref: 'gh:acme/web#7', id: 'T1', changes: { title: 'Fix the login' }, note: 'title as on GitHub' },
      { kind: 'status', ref: 'gh:acme/web#7', id: 'T1', input: { status: 'done', note: 'closed on GitHub as completed', evidence: URL } },
    ];
    const writer = register();
    assert.deepEqual((await applySteps(writer, steps)).map((outcome) => outcome.result), [
      { ok: true, value: 'T1' },
      { ok: false, error: 'T1 already has ref gh:acme/web#7' },
      { ok: true, value: 'T1' },
      { ok: true, value: 'T1' },
    ]);
    const task = (await writer.snapshot()).state.tasks.get('T1');
    assert.deepEqual([task?.title, task?.status, task?.evidence, task?.updatedBy], ['Fix the login', 'done', URL, 'github']);
  });
});
