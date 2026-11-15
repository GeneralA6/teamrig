import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLAIM_DAYS, CLAIMS_PER_RUN, isClaim, planClaims } from './claim.ts';
import type { Claim, ClaimComment, ClaimIssue } from './claim.ts';

const REPO = 'acme/tool';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SINCE = NOW - 60_000;

function comment(body: string, overrides: Partial<ClaimComment> = {}): ClaimComment {
  return { login: 'ada', association: 'NONE', body, at: NOW - 1_000, ...overrides };
}

function issue(number: number, overrides: Partial<ClaimIssue> = {}): ClaimIssue {
  return { repo: REPO, number, open: true, labels: [], assignees: [], comments: [], linkedPull: false, ...overrides };
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
    const plan = planClaims([issue(1, { comments: [comment('/take')] })], [], { now: NOW, since: SINCE });
    assert.deepEqual(plan.made, [{ repo: REPO, number: 1, login: 'ada', at: NOW - 1_000 }]);
    assert.deepEqual(plan.expired, []);
  });

  it('makes no claim for an insider, a bot, an old comment, an assigned, closed or design issue', () => {
    const issues = [
      issue(1, { comments: [comment('/take', { association: 'MEMBER' })] }),
      issue(2, { comments: [comment('/take', { login: '' })] }),
      issue(3, { comments: [comment('/take', { at: SINCE - 1 })] }),
      issue(4, { comments: [comment('/take')], assignees: ['bob'] }),
      issue(5, { comments: [comment('/take')], open: false }),
      issue(6, { comments: [comment('/take')], labels: ['design'] }),
    ];
    assert.deepEqual(planClaims(issues, [], { now: NOW, since: SINCE }).made, []);
  });

  it('gives the issue to the oldest claim comment', () => {
    const comments = [comment('/take', { login: 'bob', at: NOW - 100 }), comment('/take', { login: 'ada', at: NOW - 500 })];
    assert.deepEqual(planClaims([issue(1, { comments })], [], { now: NOW, since: SINCE }).made.map((made) => made.login), ['ada']);
  });

  it('holds one open claim per login per repository, a held one included', () => {
    const issues = [issue(1, { comments: [comment('/take')] }), issue(2, { comments: [comment('/take')] }), issue(3, { assignees: ['ada'] })];
    assert.deepEqual(planClaims(issues.slice(0, 2), [], { now: NOW, since: SINCE }).made.map((made) => made.number), [1]);
    assert.deepEqual(planClaims(issues, [claim(3, 'ada', 1)], { now: NOW, since: SINCE }).made, []);
  });

  it(`makes at most ${String(CLAIMS_PER_RUN)} claims in a repository in one run`, () => {
    const issues = Array.from({ length: CLAIMS_PER_RUN + 2 }, (_, index) => issue(index + 1, { comments: [comment('/take', { login: `user${String(index)}` })] }));
    assert.equal(planClaims(issues, [], { now: NOW, since: SINCE }).made.length, CLAIMS_PER_RUN);
  });

  it(`expires a claim after ${String(CLAIM_DAYS)} days with no linked pull request, and keeps a younger or worked one`, () => {
    const issues = [issue(1, { assignees: ['ada'] }), issue(2, { assignees: ['bob'] }), issue(3, { assignees: ['cy'], linkedPull: true })];
    const plan = planClaims(issues, [claim(1, 'ada', CLAIM_DAYS), claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)], { now: NOW, since: SINCE });
    assert.deepEqual(plan.expired, [claim(1, 'ada', CLAIM_DAYS)]);
    assert.deepEqual(plan.kept, [claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)]);
  });

  it('drops with no write a claim whose issue closed, is gone, or no longer has its login assigned', () => {
    const issues = [issue(1, { assignees: ['ada'], open: false }), issue(2, { assignees: ['eve'] })];
    const plan = planClaims(issues, [claim(1, 'ada', 30), claim(2, 'bob', 30), claim(9, 'cy', 30)], { now: NOW, since: SINCE });
    assert.deepEqual(plan, { made: [], expired: [], kept: [] });
  });

  it('never expires an assignee it did not make', () => {
    assert.deepEqual(planClaims([issue(1, { assignees: ['ada'] })], [], { now: NOW, since: SINCE }).expired, []);
  });
});
