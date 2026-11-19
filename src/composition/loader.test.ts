import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION } from '../plugin-api/index.ts';
import { connectorDeclarationData, hostDeclarationData } from '../testing/manifests.ts';
import { importModule, loadConnector, loadHost, readDeclarations, type Load, type ModuleImporter } from './loader.ts';

const HOST_ENTRY = '../adapters/hosts/claude-code/index.ts';
const NOT_DEFINED = 'its entry is not made by defineHost: it needs a declaration and a create function';

/** An importer that serves the given modules by specifier, refuses any other as Node does, and keeps what it was asked for. */
function serving(modules: Readonly<Record<string, unknown>>): { readonly importer: ModuleImporter; readonly asked: string[] } {
  const asked: string[] = [];
  const importer: ModuleImporter = (specifier) => {
    asked.push(specifier);
    return Object.hasOwn(modules, specifier) ? Promise.resolve(modules[specifier]) : Promise.reject(new Error(`Cannot find module ${specifier}`));
  };
  return { importer, asked };
}

/** The host entry module of the table's one host, its declaration changed by `over`. */
function hostEntry(over: Readonly<Record<string, unknown>> = {}): ModuleImporter {
  return serving({ [HOST_ENTRY]: { default: { declaration: hostDeclarationData({ id: 'claude-code', ...over }), create: () => ({}) } } }).importer;
}

function noticesOf(load: Load<unknown>): readonly string[] | undefined {
  return load.kind === 'refused' ? load.notices : undefined;
}

describe('the adapter loader, on the adapters teamrig ships', () => {
  it('loads the Claude Code host through the real importer', async () => {
    const load = await loadHost('claude-code');
    assert.equal(load.kind, 'loaded');
    assert.equal(load.kind === 'loaded' && load.value.declaration.name, 'Claude Code');
    assert.deepEqual(load.kind === 'loaded' && load.value.create({ env: {}, platform: 'linux', run: () => Promise.reject(new Error('no program runs here')) }), {});
  });

  it('loads each connector through the real importer', async () => {
    const [github, local] = await Promise.all([loadConnector('github', importModule), loadConnector('local', importModule)]);
    assert.equal(github.kind === 'loaded' && github.value.declaration.refPrefix, 'gh:');
    assert.equal(local.kind === 'loaded' && local.value.declaration.refPrefix, 'local:');
  });

  it('reads every declaration in table order', async () => {
    const { hosts, connectors } = await readDeclarations();
    assert.deepEqual(
      hosts.map((load) => [load.id, load.kind]),
      [['claude-code', 'loaded']],
    );
    assert.deepEqual(
      connectors.map((load) => [load.id, load.kind, load.kind === 'loaded' && load.value.name]),
      [
        ['github', 'loaded', 'GitHub'],
        ['local', 'loaded', 'Local'],
      ],
    );
  });
});

describe('reading the declarations', () => {
  it('imports the declaration file of each adapter and none of its code', async () => {
    const { importer, asked } = serving({
      '../adapters/hosts/claude-code/declaration.ts': { declaration: hostDeclarationData({ id: 'claude-code' }) },
      '../adapters/connectors/github/declaration.ts': { declaration: connectorDeclarationData({ id: 'github' }) },
      '../adapters/connectors/local/declaration.ts': { declaration: connectorDeclarationData({ id: 'local' }) },
    });
    const { hosts, connectors } = await readDeclarations(importer);
    assert.deepEqual(
      [...hosts, ...connectors].map((load) => load.kind),
      ['loaded', 'loaded', 'loaded'],
    );
    assert.deepEqual(asked, ['../adapters/hosts/claude-code/declaration.ts', '../adapters/connectors/github/declaration.ts', '../adapters/connectors/local/declaration.ts']);
  });

  it('refuses the one adapter whose declaration is broken, and still reads the others', async () => {
    const { importer } = serving({
      '../adapters/hosts/claude-code/declaration.ts': { declaration: hostDeclarationData({ id: 'claude-code' }) },
      '../adapters/connectors/github/declaration.ts': { declaration: connectorDeclarationData({ id: 'github', refPrefix: 'gh' }) },
    });
    const { hosts, connectors } = await readDeclarations(importer);
    assert.deepEqual(hosts.map(noticesOf), [undefined]);
    assert.deepEqual(connectors.map(noticesOf), [
      ['its refPrefix must be a lower-case word ending in a colon'],
      ['its declaration.ts did not load: Cannot find module ../adapters/connectors/local/declaration.ts'],
    ]);
  });
});

describe('an adapter the loader refuses', () => {
  it('is one the table of its side does not name', async () => {
    const { importer, asked } = serving({});
    assert.deepEqual(await loadHost('codex', importer), { kind: 'refused', id: 'codex', notices: ['no host adapter is named codex: the host adapters are claude-code'] });
    assert.deepEqual(noticesOf(await loadHost('github', importer)), ['no host adapter is named github: the host adapters are claude-code']);
    assert.deepEqual(noticesOf(await loadConnector('claude-code', importer)), ['no connector adapter is named claude-code: the connector adapters are github, local']);
    assert.deepEqual(noticesOf(await loadConnector('constructor', importer)), ['no connector adapter is named constructor: the connector adapters are github, local']);
    assert.deepEqual(asked, []);
  });

  it('is one whose entry does not load', async () => {
    const { importer } = serving({});
    assert.deepEqual(noticesOf(await loadHost('claude-code', importer)), [`its index.ts did not load: Cannot find module ${HOST_ENTRY}`]);
  });

  it('is one whose entry is no adapter', async () => {
    for (const module of [undefined, 'text', {}, { default: { declaration: hostDeclarationData({ id: 'claude-code' }) } }]) {
      assert.deepEqual(noticesOf(await loadHost('claude-code', serving({ [HOST_ENTRY]: module }).importer)), [NOT_DEFINED]);
    }
  });

  it('is one whose declaration is broken', async () => {
    assert.deepEqual(noticesOf(await loadHost('claude-code', hostEntry({ name: '' }))), ['it needs a name']);
  });

  it('is one declaring another id than the table names it by', async () => {
    assert.deepEqual(noticesOf(await loadHost('claude-code', hostEntry({ id: 'some-cli' }))), ['it declares the id some-cli, and the adapter table names it claude-code']);
  });

  it('is one built for another major of the plugin API, while a later minor loads', async () => {
    const built = '9.0.0';
    assert.deepEqual(noticesOf(await loadHost('claude-code', hostEntry({ apiVersion: built }))), [
      `it is built for plugin API ${built} and this teamrig has ${API_VERSION}: their major versions differ`,
    ]);
    assert.equal((await loadHost('claude-code', hostEntry({ apiVersion: '0.9.4' }))).kind, 'loaded');
  });

  it('is told of its id and its version at once', async () => {
    assert.equal(noticesOf(await loadHost('claude-code', hostEntry({ id: 'some-cli', apiVersion: '9.0.0' })))?.length, 2);
  });
});
