import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, connectorAdapterProblems, connectorDeclarationProblems, featuresOf } from '../../../plugin-api/index.ts';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the local adapter', () => {
  it('declares a tracker built for the plugin API of this teamrig', () => {
    assert.deepEqual(connectorDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'local');
    assert.equal(declaration.name, 'Local');
    assert.deepEqual(declaration.kinds, ['tracker']);
    assert.equal(declaration.refPrefix, 'local:');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('supports no connector feature, and says the tasks stay in the register', () => {
    for (const row of featuresOf('connector')) {
      assert.deepEqual(
        declaration.manifest[row.id],
        { kind: 'unsupported', notice: 'the local connector keeps tasks in the register: it has no outside tracker or code host' },
        row.id,
      );
    }
  });

  it('enters through defineConnector with that declaration, and builds no port', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(connectorAdapterProblems(adapter), []);
    assert.deepEqual(adapter.create(connectorDeps()), {});
  });
});
