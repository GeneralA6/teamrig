import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import type { ReviewPath } from '../config/types.ts';
import type { ApprovalAnswer } from '../register/fold.ts';
import { testConfig } from '../testing/config.ts';
import { fallbackOpen, holdApproved, holdClassOf, needsCheck, REVIEW_FALLBACK_MS, reviewRoute, type CheckOutcome, type Reviewer } from './review-gate.ts';
import type { ReviewHit } from './review-paths.ts';

function hit(path: string, mode: ReviewPath['mode'], cls: ReviewPath['class']): ReviewHit {
  return { path, entry: { glob: path, mode, class: cls } };
}

const LOCKFILE = hit('package-lock.json', 'always', 'security');
const AUTH = hit('src/auth.ts', 'always', 'leader');
const CHECKED = hit('src/api.ts', 'check', 'security');
const CLEAN: CheckOutcome = { kind: 'clean' };
const FLAGGED: CheckOutcome = { kind: 'flagged', findings: '[{"rule":"token"}]' };
const BROKEN: CheckOutcome = { kind: 'broken', detail: 'exited 1', exitCode: 1 };

describe('needsCheck', () => {
  it('runs the check for a check hit, unless an always security hit holds the change anyway', () => {
    assert.equal(needsCheck([]), false);
    assert.equal(needsCheck([AUTH]), false);
    assert.equal(needsCheck([CHECKED]), true);
    assert.equal(needsCheck([AUTH, CHECKED]), true, 'a leader hold may still grow to a security one');
    assert.equal(needsCheck([LOCKFILE, CHECKED]), false);
  });
});

describe('holdClassOf', () => {
  it('holds an always hit for its class, and nothing for no hit', () => {
    assert.equal(holdClassOf([], undefined), undefined);
    assert.equal(holdClassOf([LOCKFILE], undefined), 'security');
    assert.equal(holdClassOf([AUTH], undefined), 'leader');
  });

  it("holds a check hit for its class when flagged, broken or not run, and not when clean", () => {
    assert.equal(holdClassOf([CHECKED], CLEAN), undefined);
    assert.equal(holdClassOf([CHECKED], FLAGGED), 'security');
    assert.equal(holdClassOf([hit('src/api.ts', 'check', 'leader')], FLAGGED), 'leader');
    assert.equal(holdClassOf([CHECKED], BROKEN), 'security');
    assert.equal(holdClassOf([CHECKED], undefined), 'security');
    assert.equal(holdClassOf([hit('src/api.ts', 'check', 'leader')], BROKEN), 'leader');
  });

  it('holds a change of both classes for security', () => {
    assert.equal(holdClassOf([AUTH, LOCKFILE], undefined), 'security');
    assert.equal(holdClassOf([AUTH, CHECKED], FLAGGED), 'security');
    assert.equal(holdClassOf([AUTH, CHECKED], CLEAN), 'leader');
  });
});

describe('reviewRoute', () => {
  const tree = new LeadTree(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'security'], leads: { alpha: ['bravo'] } }));
  const roles = { securityReviewer: 'security' };

  it("routes a security hold to the reviewer, with the session's nearest leader as its fallback", () => {
    assert.deepEqual(reviewRoute('security', 'bravo', tree, roles), { kind: 'route', who: 'security', fallback: 'alpha' });
    assert.deepEqual(reviewRoute('security', 'alpha', tree, roles), { kind: 'route', who: 'security', fallback: 'lead' });
  });

  it("routes a leader hold to the session's nearest leader, without a fallback", () => {
    assert.deepEqual(reviewRoute('leader', 'bravo', tree, roles), { kind: 'route', who: 'alpha', fallback: undefined });
  });

  it("never routes a hold to its own session: the reviewer's change goes to its leader, the lead's to security", () => {
    assert.deepEqual(reviewRoute('security', 'security', tree, roles), { kind: 'route', who: 'lead', fallback: undefined });
    assert.deepEqual(reviewRoute('leader', 'lead', tree, roles), { kind: 'route', who: 'security', fallback: undefined });
    assert.deepEqual(reviewRoute('security', 'lead', tree, roles), { kind: 'route', who: 'security', fallback: undefined });
  });

  it('goes to a leader when the team has no security reviewer, and says so when no one else is left', () => {
    assert.deepEqual(reviewRoute('security', 'bravo', tree, {}), { kind: 'route', who: 'alpha', fallback: undefined });
    const none = reviewRoute('leader', 'lead', tree, {});
    assert.equal(none.kind, 'none');
    assert.match(none.kind === 'none' ? none.reason : '', /no one but lead could review its change: set roles\.securityReviewer/);
  });
});

describe('holdApproved and fallbackOpen', () => {
  const created = Date.parse('2030-01-08T10:00:00.000Z');
  const route: Reviewer = { who: 'security', fallback: 'alpha' };
  const answer = (by: string, minutes: number, verdict: ApprovalAnswer['verdict'] = 'approved'): ApprovalAnswer => ({
    verdict,
    by,
    at: new Date(created + minutes * 60_000).toISOString(),
    note: 'checked the diff',
  });

  it("takes the reviewer's approval made after the hold, never one before it or a decline", () => {
    assert.equal(holdApproved(route, created, answer('security', 1)), true);
    assert.equal(holdApproved(route, created, answer('security', -1)), false, 'it approved an earlier change');
    assert.equal(holdApproved(route, created, answer('security', 1, 'declined')), false);
    assert.equal(holdApproved(route, created, undefined), false);
    assert.equal(holdApproved(route, created, answer('bravo', 40)), false, 'neither the reviewer nor the fallback');
  });

  it("takes the fallback leader's approval only once the fallback time passed", () => {
    assert.equal(fallbackOpen(route, created, created + REVIEW_FALLBACK_MS - 1), false);
    assert.equal(fallbackOpen(route, created, created + REVIEW_FALLBACK_MS), true);
    assert.equal(holdApproved(route, created, answer('alpha', 29)), false);
    assert.equal(holdApproved(route, created, answer('alpha', 30)), true);
    assert.equal(fallbackOpen({ ...route, fallback: undefined }, created, created + 2 * REVIEW_FALLBACK_MS), false);
  });
});
