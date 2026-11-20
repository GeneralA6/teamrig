import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostIssue } from '../issues/issue.ts';
import { testHostIssue } from '../testing/host-issue.ts';
import {
  capAlerts,
  overCapLine,
  overCapPageText,
  pagedAfter,
  SECURITY_ALERTS_PER_RUN,
  securityIssues,
  securityLine,
  securityPageText,
  unpagedIssues,
  unpagedLine,
  type SecurityIssue,
} from './security-alert.ts';

function issue(number: number, overrides: Partial<HostIssue> = {}): HostIssue {
  return testHostIssue(number, {
    title: `Hole ${number}: the token leaks through /debug`,
    labels: ['security'],
    updatedAt: undefined,
    authorAssociation: 'NONE',
    author: 'someone',
    ...overrides,
  });
}

function found(number: number, to = 'bravo'): SecurityIssue {
  return { repo: 'acme/web', number, url: `https://github.com/acme/web/issues/${number}`, to };
}

describe('securityIssues', () => {
  it('keeps the open issues labelled security in any case, each routed by the function given', () => {
    const issues = [issue(1), issue(2, { labels: ['bug', 'Security'] }), issue(3, { labels: ['bug'] }), issue(4, { state: 'closed' })];
    assert.deepEqual(
      securityIssues(issues, (read) => (read.number === 1 ? 'alpha' : 'bravo')),
      [found(1, 'alpha'), found(2)],
    );
  });
});

describe('unpagedIssues and pagedAfter', () => {
  it('names only the issues not paged before', () => {
    const now = new Map([['acme/web', [found(9), found(4)]], ['acme/api', []]]);
    assert.deepEqual(unpagedIssues(now, new Map([['acme/web', [4]]])), [found(9)]);
    assert.deepEqual(unpagedIssues(now, new Map([['acme/web', [4, 9]]])), []);
  });

  it('adds every open one to the numbers paged before, lowest first, and never drops one closed or unlabelled since', () => {
    const now = new Map([['acme/web', [found(9), found(4)]], ['acme/api', []]]);
    const before = new Map([['acme/web', [6, 4]], ['acme/api', [2]], ['acme/old', [1]]]);
    assert.deepEqual(pagedAfter(before, now), new Map([['acme/web', [4, 6, 9]], ['acme/api', [2]], ['acme/old', [1]]]));
    assert.deepEqual(pagedAfter(new Map(), now), new Map([['acme/web', [4, 9]]]));
  });
});

describe('capAlerts', () => {
  it(`alerts for at most ${SECURITY_ALERTS_PER_RUN} issues each, in the order found, and keeps the rest apart`, () => {
    const issues = [1, 2, 3, 4, 5].map((number) => found(number));
    assert.deepEqual(capAlerts(issues), { each: issues.slice(0, SECURITY_ALERTS_PER_RUN), overCap: issues.slice(SECURITY_ALERTS_PER_RUN) });
    assert.deepEqual(capAlerts(issues.slice(0, 2)), { each: issues.slice(0, 2), overCap: [] });
  });
});

describe('the over-the-cap texts', () => {
  it('count the issues and name their refs and sessions, at most ten, never a title', () => {
    assert.equal(
      overCapLine([found(4), found(5, 'alpha')], undefined),
      '2 more GitHub security issues this run, past its cap of 3 pages and wakes; none of their sessions was told: read each and hand it on: gh:acme/web#4 (bravo), gh:acme/web#5 (alpha)',
    );
    assert.ok(overCapLine([found(4)], 'no webhook').endsWith('gh:acme/web#4 (bravo); the owner was not paged: no webhook'));
    const many = Array.from({ length: 13 }, (_, at) => found(at + 4));
    assert.equal(
      overCapPageText(many, 'app', 'lead', '10:00 UTC'),
      `teamrig: 13 more security issues on GitHub past this run's cap, told to app/lead at 10:00 UTC: ${many.slice(0, 10).map((one) => `gh:acme/web#${one.number} (bravo)`).join(', ')}, and 3 more`,
    );
  });
});

describe('the security texts', () => {
  it('name the issue by ref and URL, never its title, which may describe the hole', () => {
    const line = securityLine(found(7));
    assert.equal(
      line,
      'GitHub security issue gh:acme/web#7 is yours: read it now; if it shows how to exploit a hole, hide those details and move them to a private advisory (https://github.com/acme/web/issues/7)',
    );
    assert.equal(securityPageText(found(7), 'app', '10:00 UTC'), 'teamrig: security issue gh:acme/web#7 on GitHub, routed to app/bravo at 10:00 UTC: https://github.com/acme/web/issues/7');
    assert.equal(unpagedLine(found(7), 'no webhook'), 'GitHub security issue gh:acme/web#7 went to bravo, but the owner was not paged: no webhook');
  });
});
