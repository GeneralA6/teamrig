import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostIssue } from '../issues/issue.ts';
import { testHostIssue } from '../testing/host-issue.ts';
import { pagedNumbers, securityIssues, securityLine, securityPageText, unpagedIssues, unpagedLine, type SecurityIssue } from './security-alert.ts';

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

describe('unpagedIssues and pagedNumbers', () => {
  it('names only the issues not paged before, and holds every open one as paged now, lowest first', () => {
    const now = new Map([['acme/web', [found(9), found(4)]], ['acme/api', []]]);
    assert.deepEqual(unpagedIssues(now, new Map([['acme/web', [4]]])), [found(9)]);
    assert.deepEqual(unpagedIssues(now, new Map([['acme/web', [4, 9]]])), []);
    assert.deepEqual(pagedNumbers(now), new Map([['acme/web', [4, 9]]]));
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
