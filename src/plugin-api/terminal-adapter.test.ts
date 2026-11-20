import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manifestOf, terminalDeclarationData } from '../testing/manifests.ts';
import { defineTerminal, isTerminalAdapter, isTerminalDeclaration, terminalAdapterProblems, terminalDeclarationProblems, type TerminalDeps } from './terminal-adapter.ts';

const NOT_DEFINED = 'its entry is not made by defineTerminal: it needs a declaration and a create function';

describe('a terminal declaration', () => {
  it('is a declaration whose manifest answers for every terminal feature', () => {
    assert.deepEqual(terminalDeclarationProblems(terminalDeclarationData()), []);
    assert.equal(isTerminalDeclaration(terminalDeclarationData()), true);
  });

  it('is refused with a host manifest', () => {
    const data = terminalDeclarationData({ manifest: manifestOf('host') });
    assert.equal(isTerminalDeclaration(data), false);
    assert.ok(terminalDeclarationProblems(data).includes('its manifest has no row for pane.open'));
    assert.ok(terminalDeclarationProblems(data).includes('its manifest names rules.session-start, which is no terminal feature'));
  });
});

describe('defineTerminal', () => {
  it('hands back the adapter it is given, whose create builds from the deps', () => {
    const data = terminalDeclarationData();
    assert.ok(isTerminalDeclaration(data));
    const seen: NodeJS.Platform[] = [];
    const adapter = defineTerminal({
      declaration: data,
      create: (deps: TerminalDeps) => {
        seen.push(deps.platform);
        return {};
      },
    });
    assert.equal(adapter.declaration, data);
    assert.deepEqual(adapter.create({ env: {}, platform: 'linux' }), {});
    assert.deepEqual(seen, ['linux']);
    assert.equal(isTerminalAdapter(adapter), true);
  });
});

describe('a terminal adapter entry', () => {
  it('is refused when it is no declaration beside a create function', () => {
    assert.deepEqual(terminalAdapterProblems({ declaration: terminalDeclarationData() }), [NOT_DEFINED]);
    assert.deepEqual(terminalAdapterProblems(undefined), [NOT_DEFINED]);
    assert.equal(isTerminalAdapter({ declaration: terminalDeclarationData() }), false);
  });

  it('is refused for what is wrong with its declaration', () => {
    assert.deepEqual(terminalAdapterProblems({ declaration: terminalDeclarationData({ name: '' }), create: () => ({}) }), ['it needs a name']);
    assert.deepEqual(terminalAdapterProblems({ create: () => ({}) }), ['its declaration is not an object']);
  });
});
