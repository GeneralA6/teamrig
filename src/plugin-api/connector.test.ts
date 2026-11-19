import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { SUPPORTED, UNSUPPORTED, connectorDeclarationData, manifestOf } from '../testing/manifests.ts';
import { connectorAdapterProblems, connectorDeclarationProblems, defineConnector, isConnectorAdapter, isConnectorDeclaration, type ConnectorDeps } from './connector.ts';

const NOT_DEFINED = 'its entry is not made by defineConnector: it needs a declaration and a create function';
const KINDS = 'its kinds must list tracker, codehost or both, each once';
const REF_PREFIX = 'its refPrefix must be a lower-case word ending in a colon';

describe('a connector declaration', () => {
  it('adds the kinds of connector it is and the prefix of its refs', () => {
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData()), []);
    assert.equal(isConnectorDeclaration(connectorDeclarationData()), true);
  });

  it('lists tracker, codehost or both, each once', () => {
    for (const kinds of [[], ['tracker', 'tracker'], ['tracker', 'wiki'], 'tracker', undefined]) {
      assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds })), [KINDS], JSON.stringify(kinds));
    }
  });

  it('starts its refs with a lower-case word and a colon', () => {
    for (const refPrefix of ['gh:', 'local:', 'jira-cloud:']) assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ refPrefix })), [], refPrefix);
    for (const refPrefix of ['gh', 'GH:', 'gh: ', ':', 7]) assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ refPrefix })), [REF_PREFIX], String(refPrefix));
  });

  it('claims no feature of a kind it does not list', () => {
    const trackerOnly = connectorDeclarationData({ kinds: ['tracker'] });
    assert.deepEqual(connectorDeclarationProblems(trackerOnly), [
      'codehost.pull-news is not unsupported, but its kinds do not list codehost',
      'codehost.ci-excerpt is not unsupported, but its kinds do not list codehost',
      'codehost.pr-conflicts is not unsupported, but its kinds do not list codehost',
      'codehost.review-posts is not unsupported, but its kinds do not list codehost',
      'codehost.linked-pulls is not unsupported, but its kinds do not list codehost',
    ]);
    const honest = manifestOf('connector', UNSUPPORTED, { 'tracker.comment': SUPPORTED });
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds: ['tracker'], manifest: honest })), []);
  });

  it('reports a broken manifest once, with no word on kinds it cannot read rows for', () => {
    assert.deepEqual(connectorDeclarationProblems(connectorDeclarationData({ kinds: ['tracker'], manifest: 'none' })), ['its manifest is not an object']);
    assert.deepEqual(connectorDeclarationProblems(7), ['its declaration is not an object']);
  });
});

describe('defineConnector', () => {
  it('hands back the adapter it is given, whose create builds its ports from the deps', () => {
    const data = connectorDeclarationData();
    assert.ok(isConnectorDeclaration(data));
    const adapter = defineConnector({ declaration: data, create: (deps: ConnectorDeps) => ({ tracker: { stamped: deps.stamp } }) });
    const deps: ConnectorDeps = { run: () => Promise.reject(new Error('no program runs here')), credentials: new FakeCredentials(), env: {}, scanner: new SecretScanner(), stamp: true };
    assert.equal(adapter.declaration, data);
    assert.deepEqual(adapter.create(deps), { tracker: { stamped: true } });
    assert.equal(isConnectorAdapter(adapter), true);
  });
});

describe('a connector adapter entry', () => {
  it('is refused when it is no declaration beside a create function', () => {
    assert.deepEqual(connectorAdapterProblems({ declaration: connectorDeclarationData() }), [NOT_DEFINED]);
    assert.equal(isConnectorAdapter(null), false);
  });

  it('is refused for what is wrong with its declaration', () => {
    assert.deepEqual(connectorAdapterProblems({ declaration: connectorDeclarationData({ refPrefix: 'gh' }), create: () => ({}) }), [REF_PREFIX]);
  });
});
