import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, connectorAdapterProblems, connectorDeclarationProblems, featuresOf } from '../../../plugin-api/index.ts';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the GitHub adapter', () => {
  it('declares a tracker and a code host built for the plugin API of this teamrig', () => {
    assert.deepEqual(connectorDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'github');
    assert.equal(declaration.name, 'GitHub');
    assert.deepEqual(declaration.kinds, ['tracker', 'codehost']);
    assert.equal(declaration.refPrefix, 'gh:');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('supports every connector feature but the hidden mark, which GitHub has none of', () => {
    const others = featuresOf('connector').filter((row) => row.id !== 'tracker.hidden-mark');
    for (const row of others) {
      assert.equal(declaration.manifest[row.id].kind, 'supported', row.id);
    }
    assert.deepEqual(declaration.manifest['tracker.hidden-mark'], {
      kind: 'unsupported',
      notice: 'GitHub shows every mark on an issue to its readers: a mark there is a label or a comment',
    });
  });

  it('enters through defineConnector with that declaration, and builds no port yet', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(connectorAdapterProblems(adapter), []);
    assert.deepEqual(adapter.create(connectorDeps()), {});
  });
});
