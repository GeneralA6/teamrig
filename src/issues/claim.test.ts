import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testHostIssue } from '../testing/host-issue.ts';
import { CLAIM_DAYS, CLAIMS_PER_RUN, isClaim, planClaims } from './claim.ts';
import type { Claim } from './claim.ts';
import type { HostIssue, IssueComment } from './issue.ts';

const REPO = 'acme/web';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SINCE = NOW - 60_000;
const TIMES = { now: NOW, since: SINCE };

function claimComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return { at: new Date(NOW - 1_000).toISOString(), login: 'ada', authorAssociation: 'NONE', authorKind: 'User', claims: true, ...overrides };
}

function issue(number: number, overrides: Partial<HostIssue> = {}): HostIssue {
  return testHostIssue(number, overrides);
}

function claim(number: number, login: string, ageDays: number): Claim {
  return { repo: REPO, number, login, at: NOW - ageDays * DAY };
}

describe('isClaim', () => {
  it('takes a line that is only /take', () => {
    assert.equal(isClaim('/take'), true);
    assert.equal(isClaim('  /take  '), true);
    assert.equal(isClaim('/take this one'), false);
  });

  it('takes a line starting with one of the fixed phrases, in any case and either apostrophe', () => {
    assert.equal(isClaim("I'll take this"), true);
    assert.equal(isClaim('i’m working on it now'), true);
    assert.equal(isClaim('I can take it.'), true);
    assert.equal(isClaim('Thanks!\n\nI can take it'), true);
  });

  it('refuses the phrase inside a line, a quoted line and a fenced block', () => {
    assert.equal(isClaim("Maybe I'll take this later"), false);
    assert.equal(isClaim("> I'll take this"), false);
    assert.equal(isClaim("```\nI'll take this\n```"), false);
    assert.equal(isClaim('I can takeover'), false);
  });
});

describe('planClaims', () => {
  it('claims an open unassigned issue for an outside commenter', () => {
    const plan = planClaims([issue(1, { comments: [claimComment()] })], [], TIMES);
    assert.deepEqual(plan.made, [{ repo: REPO, number: 1, login: 'ada', at: NOW - 1_000 }]);
    assert.deepEqual(plan.expired, []);
  });

  it('makes no claim for an insider, a bot, a deleted account, an old or plain comment, an assigned, closed or design issue', () => {
    const issues = [
      issue(1, { comments: [claimComment({ authorAssociation: 'MEMBER' })] }),
      issue(2, { comments: [claimComment({ login: 'helper[bot]', authorKind: 'Bot' })] }),
      issue(3, { comments: [claimComment({ login: '', authorKind: '' })] }),
      issue(4, { comments: [claimComment({ at: new Date(SINCE - 1).toISOString() })] }),
      issue(5, { comments: [claimComment({ claims: false })] }),
      issue(6, { comments: [claimComment()], assignees: ['bob'] }),
      issue(7, { comments: [claimComment()], state: 'closed' }),
      issue(8, { comments: [claimComment()], labels: ['design'] }),
    ];
    assert.deepEqual(planClaims(issues, [], TIMES).made, []);
  });

  it('gives the issue to the oldest claim comment', () => {
    const comments = [claimComment({ login: 'bob', at: new Date(NOW - 100).toISOString() }), claimComment({ login: 'ada', at: new Date(NOW - 500).toISOString() })];
    assert.deepEqual(planClaims([issue(1, { comments })], [], TIMES).made.map((made) => made.login), ['ada']);
  });

  it('holds one open claim per login per repository, a held one included', () => {
    const issues = [issue(1, { comments: [claimComment()] }), issue(2, { comments: [claimComment()] }), issue(3, { assignees: ['ada'] })];
    assert.deepEqual(planClaims(issues.slice(0, 2), [], TIMES).made.map((made) => made.number), [1]);
    assert.deepEqual(planClaims(issues, [claim(3, 'ada', 1)], TIMES).made, []);
  });

  it(`makes at most ${String(CLAIMS_PER_RUN)} claims in a repository in one run`, () => {
    const issues = Array.from({ length: CLAIMS_PER_RUN + 2 }, (_, index) => issue(index + 1, { comments: [claimComment({ login: `user${String(index)}` })] }));
    assert.equal(planClaims(issues, [], TIMES).made.length, CLAIMS_PER_RUN);
  });

  it(`expires a claim after ${String(CLAIM_DAYS)} days with no linked pull request, and keeps a younger or worked one`, () => {
    const issues = [issue(1, { assignees: ['ada'] }), issue(2, { assignees: ['bob'] }), issue(3, { assignees: ['cy'], linkedPulls: 1 })];
    const plan = planClaims(issues, [claim(1, 'ada', CLAIM_DAYS), claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)], TIMES);
    assert.deepEqual(plan.expired, [claim(1, 'ada', CLAIM_DAYS)]);
    assert.deepEqual(plan.kept, [claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)]);
  });

  it('drops with no write a claim whose issue closed, is gone, or no longer has its login assigned', () => {
    const issues = [issue(1, { assignees: ['ada'], state: 'closed' }), issue(2, { assignees: ['eve'] })];
    const plan = planClaims(issues, [claim(1, 'ada', 30), claim(2, 'bob', 30), claim(9, 'cy', 30)], TIMES);
    assert.deepEqual(plan, { made: [], expired: [], kept: [] });
  });

  it('never expires an assignee it did not make', () => {
    assert.deepEqual(planClaims([issue(1, { assignees: ['ada'] })], [], TIMES).expired, []);
  });
});
