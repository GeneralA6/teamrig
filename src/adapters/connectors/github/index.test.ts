import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, connectorAdapterProblems, connectorDeclarationProblems, featuresOf, type ProgramRequest, type ProgramRunner } from '../../../plugin-api/index.ts';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { FakeCredentials, ownerToken } from '../../../testing/fake-credentials.ts';
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

  it('enters through defineConnector with that declaration', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(connectorAdapterProblems(adapter), []);
  });

  it('builds one host that is both the tracker and the code host, so the two share one read of an owner key', async () => {
    const credentials = new FakeCredentials().savesTokensFor(['acme']);
    const ports = adapter.create(connectorDeps({ credentials }));
    assert.equal(ports.tracker, ports.codeHost);
    assert.equal(ports.tracker.name, 'GitHub');
    assert.equal((await ports.tracker.reach('acme/web', 'read')).kind, 'reached');
    assert.equal((await ports.codeHost.reach('acme/web', 'read')).kind, 'reached');
    assert.equal(credentials.reads.length, 1);
  });

  it('reaches GitHub only through the program runner it is handed, as gh with the key of the repository owner', async () => {
    const asked: ProgramRequest[] = [];
    const run: ProgramRunner = (request) => {
      asked.push(request);
      return Promise.resolve({ end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ login: 'octo' }), stderr: '' });
    };
    const ports = adapter.create(connectorDeps({ run, env: { HOME: '/own' }, credentials: new FakeCredentials().savesTokensFor(['acme']) }));
    assert.deepEqual(await ports.tracker.viewer('acme/web'), { kind: 'found', login: 'octo' });
    assert.deepEqual(
      asked.map((request) => [request.program, request.env]),
      [['gh', { HOME: '/own', GH_TOKEN: ownerToken('acme') }]],
    );
  });

  it('reaches nothing for an owner with no saved key', async () => {
    const ports = adapter.create(connectorDeps());
    assert.equal((await ports.tracker.reach('acme/web', 'read')).kind, 'unreachable');
  });
});
