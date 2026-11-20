import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, featuresOf, terminalAdapterProblems, terminalDeclarationProblems } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';

describe('the GNOME Terminal adapter', () => {
  it('declares a terminal built for the plugin API of this teamrig', () => {
    assert.deepEqual(terminalDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'gnome-terminal');
    assert.equal(declaration.name, 'GNOME Terminal');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('opens a pane it has no id of, and claims nothing else', () => {
    const claimed = featuresOf('terminal')
      .filter((row) => declaration.manifest[row.id].kind !== 'unsupported')
      .map((row) => [row.id, declaration.manifest[row.id].kind]);
    assert.deepEqual(claimed, [['pane.open', 'partial']]);
    const open = declaration.manifest['pane.open'];
    assert.equal(open.kind === 'partial' ? open.missing : '', 'an id of the pane it opened');
  });

  it('enters through defineTerminal with that declaration, and builds no port yet', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(terminalAdapterProblems(adapter), []);
    assert.deepEqual(adapter.create({ env: {}, platform: 'linux' }), {});
  });
});
