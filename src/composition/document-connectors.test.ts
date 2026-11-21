import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { refOf, ServedText, sourceOf } from '../interface/index.ts';
import { GITHUB_SOURCE } from '../register/model.ts';
import { DOCUMENT_CONNECTORS } from './document-connectors.ts';

describe('the document connectors', () => {
  it('give an imported task one connector for its source and its ref', () => {
    const served = new ServedText(new SecretScanner());
    const source = sourceOf(served, 'T1', GITHUB_SOURCE, { owner: 'owner', connectors: DOCUMENT_CONNECTORS, nameOf: () => undefined });
    const ref = refOf(served, 'T1', 'gh:acme/app#12', DOCUMENT_CONNECTORS);
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
