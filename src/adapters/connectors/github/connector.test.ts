import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_CONNECTOR } from './connector.ts';

describe('the GitHub connector', () => {
  it('names an issue ref by its repository and number, with the page a person opens', () => {
    assert.deepEqual(GITHUB_CONNECTOR.itemOf('gh:Acme/App#12'), { id: 'acme/app#12', url: 'https://github.com/acme/app/issues/12' });
  });

  it('knows no ref without the issue prefix, and none that names no issue', () => {
    assert.deepEqual(
      ['acme/app#12', 'gh:acme/app', 'gh:acme/app#0', 'gh:#12', 'local: a note', 'src/cli/run.ts:136', ''].map((ref) => GITHUB_CONNECTOR.itemOf(ref)),
      Array.from({ length: 7 }, () => undefined),
    );
  });

  it('is named as the adapter declares itself', () => {
    assert.deepEqual({ id: GITHUB_CONNECTOR.id, name: GITHUB_CONNECTOR.name }, { id: 'github', name: 'GitHub' });
  });
});
