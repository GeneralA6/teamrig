import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bind, type BoundContract, type ContractOutline } from '../conformance/index.ts';
import { API_VERSION, isManifest, type Manifest, type Os } from '../plugin-api/index.ts';
import { describeContracts, suiteOf, type ContractsOf, type Suite } from './contracts.ts';
import { SUPPORTED, UNSUPPORTED, manifestOf } from './manifests.ts';
import { GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY, greeterContract, honestGreeter } from './sample-contract.ts';

function hostManifest(over: Readonly<Record<string, unknown>> = {}): Manifest<'host'> {
  const value = manifestOf('host', SUPPORTED, over);
  assert.ok(isManifest('host', value));
  return value;
}

function connectorManifest(): Manifest<'connector'> {
  const value = manifestOf('connector');
  assert.ok(isManifest('connector', value));
  return value;
}

function greeter(without?: Readonly<Record<string, string>>): BoundContract<'host'> {
  return bind({ contract: greeterContract(), make: () => honestGreeter(), ...(without === undefined ? {} : { without }) });
}

function host(bound: readonly BoundContract<'host'>[] = [greeter()], manifest: Manifest<'host'> = hostManifest()): ContractsOf {
  return { side: 'host', declaration: { apiVersion: API_VERSION, id: 'some-cli', name: 'Some CLI', manifest }, bound };
}

function suite(adapter: ContractsOf = host(), os: Os = 'linux', kit: readonly ContractOutline[] = []): Suite {
  return suiteOf(adapter, { os, kit });
}

function idsOf(made: Suite): readonly (readonly string[])[] {
  return made.groups.map((group) => [group.port, ...group.cases.map((one) => one.id)]);
}

describe('suiteOf', () => {
  it('names the suite after the adapter', () => {
    assert.equal(suite().name, 'Some CLI and the contracts of its ports');
  });

  it('groups the cases the manifest picks under their port', () => {
    const made = suite();
    assert.deepEqual(idsOf(made), [['greeter', GREETS_KNOWN.id, REFUSES_UNKNOWN.id]]);
    assert.deepEqual(made.problems, []);
  });

  it('runs a case of one operating system only there', () => {
    assert.deepEqual(idsOf(suite(host(), 'windows')), [['greeter', GREETS_KNOWN.id, REFUSES_UNKNOWN.id, WINDOWS_ONLY.id]]);
  });

  it('gives a port with no case to run no group', () => {
    const none = hostManifest({ 'rules.session-start': UNSUPPORTED, 'inbox.prompt-line': UNSUPPORTED, 'os.windows-sessions': UNSUPPORTED });
    const made = suite(host([greeter()], none));
    assert.deepEqual(made.groups, []);
    assert.deepEqual(made.problems, []);
  });

  it('leaves out the case a binding names, and says so when the manifest forbids it', () => {
    const made = suite(host([greeter({ [REFUSES_UNKNOWN.id]: 'the tool greets everyone' })]));
    assert.deepEqual(idsOf(made), [['greeter', GREETS_KNOWN.id]]);
    assert.deepEqual(made.problems, [
      `${REFUSES_UNKNOWN.id} cannot be left out: the manifest says rules.session-start is supported`,
      `${REFUSES_UNKNOWN.id} cannot be left out: the manifest says inbox.prompt-line is supported`,
    ]);
  });

  it('says which claimed feature has a contract of the kit the adapter did not bind', () => {
    const kit: readonly ContractOutline[] = [{ port: 'greeter', side: 'host', features: ['rules.session-start'] }];
    assert.deepEqual(suite(host([]), 'linux', kit).problems, ['the manifest says rules.session-start is supported, and its contract greeter is not bound']);
  });

  it('runs nothing and says so on an operating system no case runs on', () => {
    const made = suiteOf(host(), { os: undefined, kit: [] });
    assert.deepEqual(made.groups, []);
    assert.deepEqual(made.problems, ['this operating system is none a case runs on: no contract holds the adapter here']);
  });

  it('reads a connector by its own manifest', () => {
    const connector: ContractsOf = { side: 'connector', declaration: { apiVersion: API_VERSION, id: 'some-tool', name: 'Some Tool', manifest: connectorManifest() }, bound: [] };
    const kit: readonly ContractOutline[] = [{ port: 'greeter', side: 'host', features: ['rules.session-start'] }];
    assert.deepEqual(suite(connector, 'linux', kit), { name: 'Some Tool and the contracts of its ports', groups: [], problems: [] });
  });

  it('reads a terminal by its own manifest, and holds it to the contracts of its side only', () => {
    const manifest = manifestOf('terminal');
    assert.ok(isManifest('terminal', manifest));
    const terminal: ContractsOf = { side: 'terminal', declaration: { apiVersion: API_VERSION, id: 'some-terminal', name: 'Some Terminal', manifest }, bound: [] };
    const kit: readonly ContractOutline[] = [
      { port: 'greeter', side: 'host', features: ['rules.session-start'] },
      { port: 'terminal', side: 'terminal', features: ['pane.deliver'] },
    ];
    assert.deepEqual(suite(terminal, 'linux', kit), {
      name: 'Some Terminal and the contracts of its ports',
      groups: [],
      problems: ['the manifest says pane.deliver is supported, and its contract terminal is not bound'],
    });
  });
});

// The sample host is no adapter of the kit: it is held to no contract of the kit's own, only to what it binds.
describeContracts(host(), { kit: [] });
