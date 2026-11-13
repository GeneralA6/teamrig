import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostKindOf, parseIssueTarget, targetText } from './host.ts';

describe('parseIssueTarget', () => {
  it('reads owner/name#number, the repository in lowercase', () => {
    assert.deepEqual(parseIssueTarget(' Acme/Web.site_2#612 '), { repo: 'acme/web.site_2', number: 612 });
    assert.equal(targetText({ repo: 'acme/web', number: 7 }), 'acme/web#7');
  });

  it('refuses a number that is no issue, a path that steps elsewhere, or anything around it', () => {
    for (const text of ['acme/web', 'acme/web#', 'acme/web#0', 'acme/web#07', 'acme/web#12345678901', 'acme/web#7/comments', 'acme#7', 'acme/web/x#7', 'acme/../x#7', 'acme/web#7 x', '#7', 'acme/web#-1']) {
      assert.equal(parseIssueTarget(text), undefined, text);
    }
  });

  it('refuses a name of only dots', () => {
    assert.equal(parseIssueTarget('acme/..#7'), undefined);
  });
});

describe('hostKindOf', () => {
  it('chooses GitHub for a repository github.repos lists, and no host for any other', () => {
    const lists = { github: { repos: ['acme/web'] } };
    assert.equal(hostKindOf('acme/web', lists), 'github');
    assert.equal(hostKindOf('acme/api', lists), undefined);
  });
});
