import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, hostAdapterProblems, hostDeclarationProblems, isUnsupported } from '../../../plugin-api/index.ts';
import { hostDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the Antigravity adapter', () => {
  it('declares a valid host for the plugin API of this teamrig', () => {
    assert.deepEqual(hostDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'antigravity');
    assert.equal(declaration.name, 'Antigravity');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('enters through defineHost with filled hooks, toolCall, and paths ports', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(hostAdapterProblems(adapter), []);
    const ports = adapter.create(hostDeps());
    assert.deepEqual(Object.keys(ports), ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine', 'paths', 'permissions', 'plugin']);
    assert.equal(isUnsupported(ports.hooks), false);
    assert.equal(isUnsupported(ports.toolCall), false);
    assert.equal(isUnsupported(ports.paths), false);
    assert.equal(isUnsupported(ports.transcripts), true);
  });
});
