import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testHostIssue } from '../testing/host-issue.ts';
import { CLAIM_DAYS, CLAIMS_PER_DAY, claimCandidates, claimKey, formatClaims, isClaim, parseClaims, planClaims } from './claim.ts';
import type { Claim, ClaimPass, ClaimPlan } from './claim.ts';
import type { HostIssue, ReadComment } from './issue.ts';

const REPO = 'acme/web';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SINCE = NOW - 60_000;
const ACCEPT = 'accepted';
const TIMES = { now: NOW, since: SINCE, acceptLabel: ACCEPT };

function claimComment(overrides: Partial<ReadComment> = {}): ReadComment {
  return { at: new Date(NOW - 1_000).toISOString(), login: 'ada', authorAssociation: 'NONE', authorKind: 'User', claims: true, ...overrides };
}

function issue(number: number, overrides: Partial<HostIssue> = {}): HostIssue {
  return testHostIssue(number, overrides);
}

/** An issue whose list shows `comments`, and the comments its read gives, with their claim match. */
interface Commented {
  readonly issue: HostIssue;
  readonly comments: readonly ReadComment[];
}

function commented(number: number, comments: readonly ReadComment[], overrides: Partial<HostIssue> = {}): Commented {
  return { issue: issue(number, { ...overrides, comments }), comments };
}

/** planClaims over `cases`, the comments of each commented one read and none of a bare issue. */
function plan(cases: readonly (Commented | HostIssue)[], claims: readonly Claim[], times: ClaimPass = TIMES): ClaimPlan {
  const read = cases.map((item): Commented => ('issue' in item ? item : { issue: item, comments: [] }));
  return planClaims(
    read.map((item) => item.issue),
    claims,
    times,
    new Map(read.map((item) => [claimKey(item.issue.repo, item.issue.number), item.comments])),
  );
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

describe('claimCandidates', () => {
  it('picks the claimable issues with a new outside comment, oldest comment first, by what the list shows', () => {
    const at = (ms: number): string => new Date(NOW - ms).toISOString();
    const issues = [
      commented(1, [claimComment({ at: at(100) })]).issue,
      commented(2, [claimComment({ at: at(900), login: 'bob' }), claimComment({ at: at(50), login: 'cy' })]).issue,
      commented(3, [claimComment({ authorAssociation: 'MEMBER' })]).issue,
      commented(4, [claimComment({ login: 'helper[bot]', authorKind: 'Bot' })]).issue,
      commented(5, [claimComment({ at: new Date(SINCE - 1).toISOString() })]).issue,
      commented(6, [claimComment()], { assignees: ['bob'] }).issue,
      commented(7, [claimComment()], { labels: ['design'] }).issue,
      commented(8, [claimComment()], { authorAssociation: 'NONE', author: 'stranger' }).issue,
    ];
    assert.deepEqual(
      claimCandidates(issues, [], TIMES).map((candidate) => [candidate.issue.number, candidate.from]),
      [
        [2, NOW - 900],
        [1, NOW - 100],
      ],
    );
  });

  it(`picks none once the repository made its ${String(CLAIMS_PER_DAY)} claims for the day`, () => {
    const held = Array.from({ length: CLAIMS_PER_DAY }, (_, index) => claim(90 + index, `user${String(index)}`, 0));
    const issues = [...held.map((made) => issue(made.number, { assignees: [made.login] })), commented(1, [claimComment()]).issue];
    assert.deepEqual(claimCandidates(issues, held, TIMES), []);
    assert.equal(claimCandidates(issues, held.slice(1), TIMES).length, 1);
  });

  it('skips a commenter who already holds a claim in the repository', () => {
    const issues = [issue(3, { assignees: ['ada'] }), commented(1, [claimComment()]).issue];
    assert.deepEqual(claimCandidates(issues, [claim(3, 'ada', 1)], TIMES), []);
  });
});

describe('planClaims', () => {
  it('claims an open unassigned issue for an outside commenter', () => {
    const made = plan([commented(1, [claimComment()])], []);
    assert.deepEqual(made.made, [{ repo: REPO, number: 1, login: 'ada', at: NOW }]);
    assert.deepEqual(made.expired, []);
  });

  it('makes no claim on an issue whose comments the pass did not read', () => {
    const listed = commented(1, [claimComment()]).issue;
    assert.deepEqual(planClaims([listed], [], TIMES, new Map()).made, []);
  });

  it(`counts claims made from a backlog of old comments toward today's ${String(CLAIMS_PER_DAY)}`, () => {
    const old = new Date(NOW - 3 * DAY).toISOString();
    const cases = Array.from({ length: CLAIMS_PER_DAY + 2 }, (_, index) => commented(index + 1, [claimComment({ login: `user${String(index)}`, at: old })]));
    const made = plan(cases, [], { ...TIMES, since: NOW - 7 * DAY });
    assert.equal(made.made.length, CLAIMS_PER_DAY);
    assert.ok(made.made.every((each) => each.at === NOW));
  });

  it('makes no claim for an insider, a bot, a deleted account, an old or plain comment, an assigned, closed or design issue', () => {
    const cases = [
      commented(1, [claimComment({ authorAssociation: 'MEMBER' })]),
      commented(2, [claimComment({ login: 'helper[bot]', authorKind: 'Bot' })]),
      commented(3, [claimComment({ login: '', authorKind: '' })]),
      commented(4, [claimComment({ at: new Date(SINCE - 1).toISOString() })]),
      commented(5, [claimComment({ claims: false })]),
      commented(6, [claimComment()], { assignees: ['bob'] }),
      commented(7, [claimComment()], { state: 'closed' }),
      commented(8, [claimComment()], { labels: ['design'] }),
      commented(9, [claimComment()], { labels: ['Security'] }),
      commented(10, [claimComment({ login: 'not a login' })]),
    ];
    assert.deepEqual(plan(cases, []).made, []);
  });

  it('claims an outsider issue only once someone else accepted it', () => {
    const outsider = { authorAssociation: 'NONE', author: 'stranger' };
    const acceptedBy = (actor: string): Partial<HostIssue> => ({
      ...outsider,
      labels: [ACCEPT],
      labelEvents: [{ label: ACCEPT, at: new Date(NOW - DAY).toISOString(), actor, actorKind: 'User' }],
    });
    const cases = [commented(1, [claimComment()], outsider), commented(2, [claimComment()], acceptedBy('stranger')), commented(3, [claimComment()], acceptedBy('maintainer'))];
    assert.deepEqual(
      plan(cases, []).made.map((made) => made.number),
      [3],
    );
  });

  it('gives the issue to the oldest claim comment', () => {
    const comments = [claimComment({ login: 'bob', at: new Date(NOW - 100).toISOString() }), claimComment({ login: 'ada', at: new Date(NOW - 500).toISOString() })];
    assert.deepEqual(
      plan([commented(1, comments)], []).made.map((made) => made.login),
      ['ada'],
    );
  });

  it('holds one open claim per login per repository, a held one included', () => {
    const cases = [commented(1, [claimComment()]), commented(2, [claimComment()]), issue(3, { assignees: ['ada'] })];
    assert.deepEqual(
      plan(cases.slice(0, 2), []).made.map((made) => made.number),
      [1],
    );
    assert.deepEqual(plan(cases, [claim(3, 'ada', 1)]).made, []);
  });

  it(`makes at most ${String(CLAIMS_PER_DAY)} claims in a repository in a day, those of earlier runs counted`, () => {
    const cases = Array.from({ length: CLAIMS_PER_DAY + 2 }, (_, index) => commented(index + 1, [claimComment({ login: `user${String(index)}` })]));
    assert.equal(plan(cases, []).made.length, CLAIMS_PER_DAY);
    const earlier = [issue(90, { assignees: ['eve'] }), issue(91, { assignees: ['fay'] })];
    const held = [{ repo: REPO, number: 90, login: 'eve', at: NOW - DAY / 2 }, claim(91, 'fay', 1)];
    assert.equal(plan([...earlier, ...cases], held).made.length, CLAIMS_PER_DAY - 1);
  });

  it(`expires a claim after ${String(CLAIM_DAYS)} days with no linked pull request, and keeps a younger or worked one`, () => {
    const issues = [issue(1, { assignees: ['ada'] }), issue(2, { assignees: ['bob'] }), issue(3, { assignees: ['cy'], linkedPulls: 1 })];
    const made = plan(issues, [claim(1, 'ada', CLAIM_DAYS), claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)]);
    assert.deepEqual(made.expired, [claim(1, 'ada', CLAIM_DAYS)]);
    assert.deepEqual(made.kept, [claim(2, 'bob', CLAIM_DAYS - 1), claim(3, 'cy', 30)]);
  });

  it('drops with no write a claim whose issue closed, is gone, or no longer has its login assigned', () => {
    const issues = [issue(1, { assignees: ['ada'], state: 'closed' }), issue(2, { assignees: ['eve'] })];
    assert.deepEqual(plan(issues, [claim(1, 'ada', 30), claim(2, 'bob', 30), claim(9, 'cy', 30)]), { made: [], expired: [], kept: [] });
  });

  it('never expires an assignee it did not make', () => {
    assert.deepEqual(plan([issue(1, { assignees: ['ada'] })], []).expired, []);
  });
});

describe('the claims file', () => {
  it('reads back what it wrote', () => {
    const state = { claims: [claim(1, 'ada', 2), { repo: 'acme/api', number: 40, login: 'bob', at: NOW }], checked: new Map([[REPO, SINCE], ['acme/api', NOW]]) };
    assert.deepEqual(parseClaims(formatClaims(state)), state);
  });

  it('leaves out a damaged entry and reads a damaged file, another format or none as no claims and no times', () => {
    const good = { repo: REPO, number: 1, login: 'ada', at: NOW };
    const text = JSON.stringify({ v: 1, claims: [good, { ...good, number: 0 }, { ...good, login: '' }, { ...good, at: 'soon' }, 'x'], checked: { [REPO]: NOW, 'acme/api': 'today' } });
    assert.deepEqual(parseClaims(text), { claims: [good], checked: new Map([[REPO, NOW]]) });
    const none = { claims: [], checked: new Map() };
    for (const bad of ['', 'not json', JSON.stringify({ v: 2, claims: [good], checked: { [REPO]: NOW } }), JSON.stringify({ v: 1, claims: 'all', checked: [] })]) {
      assert.deepEqual(parseClaims(bad), none, bad);
    }
  });
});
