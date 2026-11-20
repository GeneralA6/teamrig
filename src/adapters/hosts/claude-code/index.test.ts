import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, featuresOf, hostAdapterProblems, hostDeclarationProblems } from '../../../plugin-api/index.ts';
import { hostDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the Claude Code adapter', () => {
  it('declares a host built for the plugin API of this teamrig', () => {
    assert.deepEqual(hostDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'claude-code');
    assert.equal(declaration.name, 'Claude Code');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('supports every host feature', () => {
    for (const row of featuresOf('host')) {
      assert.equal(declaration.manifest[row.id].kind, 'supported', row.id);
    }
  });

  it('enters through defineHost with that declaration, and builds no port yet', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(hostAdapterProblems(adapter), []);
    assert.deepEqual(adapter.create(hostDeps()), {});
  });
});
