import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { refOf, ServedText, sourceOf } from '../interface/index.ts';
import { GITHUB_SOURCE } from '../register/model.ts';
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

  it('gives an imported task one connector for its source and its ref', () => {
    const served = new ServedText(new SecretScanner());
    const source = sourceOf(served, 'T1', GITHUB_SOURCE, { owner: 'owner', connectors: [GITHUB_CONNECTOR], nameOf: () => undefined });
    const ref = refOf(served, 'T1', 'gh:acme/app#12', [GITHUB_CONNECTOR]);
    assert.deepEqual(source, { kind: 'connector', id: 'github', name: 'GitHub' });
    assert.deepEqual(ref, {
      text: 'gh:acme/app#12',
      connector: { id: 'github', name: 'GitHub' },
      id: 'acme/app#12',
      label: { text: 'acme/app#12', source: 'outside' },
      url: 'https://github.com/acme/app/issues/12',
    });
  });
});
