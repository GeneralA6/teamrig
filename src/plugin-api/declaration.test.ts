import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostDeclarationData } from '../testing/manifests.ts';
import { ADAPTER_ID, adapterEntry, declarationProblems } from './declaration.ts';

describe('an adapter declaration', () => {
  it('holds an API version, an id, a name and a manifest of its side', () => {
    assert.deepEqual(declarationProblems('host', hostDeclarationData()), []);
  });

  it('names its adapter by lower-case words joined by -', () => {
    for (const id of ['github', 'claude-code', 'codex-cli', 'tool2']) assert.match(id, ADAPTER_ID);
    for (const id of ['GitHub', 'claude code', '-jira', 'jira-', '2tool', '']) assert.doesNotMatch(id, ADAPTER_ID);
  });

  it('lists every field that is wrong, then what is wrong with the manifest', () => {
    assert.deepEqual(declarationProblems('host', hostDeclarationData({ apiVersion: '1', id: 'Some CLI', name: ' ', manifest: null })), [
      'its apiVersion must be a version like 1.0.0',
      'its id must be lower-case words joined by -',
      'it needs a name',
      'its manifest is not an object',
    ]);
    assert.deepEqual(declarationProblems('connector', {}), [
      'its apiVersion must be a version like 1.0.0',
      'its id must be lower-case words joined by -',
      'it needs a name',
      'its manifest is not an object',
    ]);
  });

  it('is checked against the side asked for', () => {
    assert.equal(declarationProblems('connector', hostDeclarationData()).length > 0, true);
  });

  it('is refused when it is no object', () => {
    assert.deepEqual(declarationProblems('host', 'claude-code'), ['its declaration is not an object']);
  });
});

describe('an adapter entry', () => {
  it('is a declaration beside a create function', () => {
    const declaration = hostDeclarationData();
    assert.deepEqual(adapterEntry({ declaration, create: () => ({}) }), { declaration });
    assert.deepEqual(adapterEntry({ create: () => ({}) }), { declaration: undefined });
  });

  it('is nothing else', () => {
    assert.equal(adapterEntry({ declaration: hostDeclarationData() }), undefined);
    assert.equal(adapterEntry({ declaration: hostDeclarationData(), create: 'later' }), undefined);
    assert.equal(adapterEntry(undefined), undefined);
  });
});
