import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_ISSUES_QUERY, closedPageArgs, ISSUE_PAGE_SIZE, OPEN_ISSUES_QUERY, openPageArgs, QUERY_VARIABLES } from './queries.ts';

const PAGE = { owner: 'acme', name: 'web', after: undefined };

describe('openPageArgs', () => {
  it('sends the open query with the repository as raw fields, and the cursor only from the second page on', () => {
    assert.deepEqual(openPageArgs(PAGE), ['api', 'graphql', '-f', `query=${OPEN_ISSUES_QUERY}`, '-f', 'owner=acme', '-f', 'name=web']);
    assert.deepEqual(openPageArgs({ ...PAGE, after: 'Y3Vyc29y' }).slice(-2), ['-f', 'after=Y3Vyc29y']);
  });
});

describe('closedPageArgs', () => {
  it('sends the closed query with the time its issues changed since', () => {
    assert.deepEqual(closedPageArgs(PAGE, '2030-01-01T00:00:00Z'), [
      'api', 'graphql', '-f', `query=${CLOSED_ISSUES_QUERY}`, '-f', 'owner=acme', '-f', 'name=web', '-f', 'since=2030-01-01T00:00:00Z',
    ]);
  });
});

describe('the shipped queries', () => {
  it('only read, a full page each, with who wrote and labelled each issue', () => {
    for (const query of [OPEN_ISSUES_QUERY, CLOSED_ISSUES_QUERY]) {
      assert.match(query, /^query\(/);
      assert.doesNotMatch(query, /mutation/i);
      assert.ok(query.includes(`first: ${ISSUE_PAGE_SIZE}`));
      for (const field of ['body', 'authorAssociation', 'author { login }', 'lastEditedAt', 'closedAt', 'LabeledEvent', 'RenamedTitleEvent']) {
        assert.ok(query.includes(field), field);
      }
    }
  });

  it('declare exactly the variables gh.ts lets through', () => {
    for (const [query, variables] of QUERY_VARIABLES) {
      const declared = [...query.matchAll(/\$(\w+):/g)].map((match) => match[1]);
      assert.deepEqual(declared, [...variables]);
    }
  });
});
