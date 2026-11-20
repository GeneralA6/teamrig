import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, featuresOf, terminalAdapterProblems, terminalDeclarationProblems } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the x-terminal-emulator adapter', () => {
  it('declares a terminal built for the plugin API of this teamrig', () => {
    assert.deepEqual(terminalDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'x-terminal-emulator');
    assert.equal(declaration.name, 'x-terminal-emulator');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('opens a pane, and claims nothing else', () => {
    const claimed = featuresOf('terminal')
      .filter((row) => declaration.manifest[row.id].kind !== 'unsupported')
      .map((row) => [row.id, declaration.manifest[row.id].kind]);
    assert.deepEqual(claimed, [['pane.open', 'supported']]);
  });

  it('enters through defineTerminal with that declaration, and builds no port yet', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(terminalAdapterProblems(adapter), []);
    assert.deepEqual(adapter.create({ env: {}, platform: 'linux' }), {});
  });
});
