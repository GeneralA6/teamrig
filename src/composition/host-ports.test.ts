import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsupported, unsupported, type HostDeps, type ProgramRunner } from '../plugin-api/index.ts';
import { HOST_PORT_NAMES } from '../ports/host/index.ts';
import { hostDeclarationData } from '../testing/manifests.ts';
import { DEFAULT_HOST, HOST_ADAPTERS } from './adapters.ts';
import { loadHostPorts, loadShippedHosts } from './host-ports.ts';
import type { ModuleImporter } from './loader.ts';

const run: ProgramRunner = () => Promise.reject(new Error('no program runs here'));

/** Every host port named and none filled: the least an adapter may build. */
function everyPortUnsupported(): Record<string, unknown> {
  return Object.fromEntries(HOST_PORT_NAMES.map((name) => [name, unsupported(`this host has no ${name}`)]));
}

/** An importer serving a host entry whose `create` builds `ports`, whatever they are. */
function building(ports: unknown): ModuleImporter {
  return () => Promise.resolve({ default: { declaration: hostDeclarationData({ id: DEFAULT_HOST }), create: () => ports } });
}

describe('loadHostPorts', () => {
  it('gives the shipped host adapter a filled transcript reader, usage meter, status line, permissions and plugin store', async () => {
    const ports = (await loadHostPorts(run))({ env: {}, platform: 'linux' });
    assert.deepEqual(Object.keys(ports), ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine', 'paths', 'permissions', 'plugin', 'launcher']);
    assert.equal(isUnsupported(ports.plugin), false);
    assert.equal(isUnsupported(ports.transcripts), false);
    assert.equal(isUnsupported(ports.usage), false);
    assert.equal(isUnsupported(ports.statusLine), false);
    assert.equal(isUnsupported(ports.permissions), false);
  });

  it('hands the adapter what each run sees, with the one runner of the process', async () => {
    const built: HostDeps[] = [];
    const entry = {
      declaration: hostDeclarationData({ id: DEFAULT_HOST }),
      create: (deps: HostDeps) => {
        built.push(deps);
        return everyPortUnsupported();
      },
    };
    const importer: ModuleImporter = () => Promise.resolve({ default: entry });
    const source = await loadHostPorts(run, importer);
    assert.deepEqual(built, [], 'loading builds no port');
    const ports = source({ env: { RUN: 'one' }, platform: 'darwin' });
    source({ env: { RUN: 'two' }, platform: 'win32' });
    assert.deepEqual(ports, everyPortUnsupported());
    assert.deepEqual(built, [
      { env: { RUN: 'one' }, platform: 'darwin', run },
      { env: { RUN: 'two' }, platform: 'win32', run },
    ]);
  });

  it('throws every reason an adapter was refused for', async () => {
    const missing: ModuleImporter = (specifier) => Promise.reject(new Error(`Cannot find module ${specifier}`));
    await assert.rejects(loadHostPorts(run, missing), {
      message: `the host adapter ${DEFAULT_HOST} did not load: its index.ts did not load: Cannot find module ../adapters/hosts/${DEFAULT_HOST}/index.ts`,
    });
    const undefinedEntry: ModuleImporter = () => Promise.resolve({ default: {} });
    await assert.rejects(loadHostPorts(run, undefinedEntry), { message: /did not load: its entry is not made by defineHost/ });
  });

  it("loads no host that declares no mark of an agent's run, and says what to declare", async () => {
    const declaration = hostDeclarationData({ id: DEFAULT_HOST, sessionVariables: { marks: [], identity: [] } });
    const markless: ModuleImporter = () => Promise.resolve({ default: { declaration, create: () => everyPortUnsupported() } });
    const refusal = /^the host adapter claude-code did not load: it declares no mark of an agent's run: sessionVariables\.marks must name an environment variable /;
    await assert.rejects(loadHostPorts(run, markless), { message: refusal });
    await assert.rejects(loadShippedHosts(run, markless), { message: refusal });
  });

  it('refuses what an adapter built when a port is left unnamed, naming each one', async () => {
    const source = await loadHostPorts(run, building({}));
    assert.throws(() => source({ env: {}, platform: 'linux' }), {
      message: `the host adapter ${DEFAULT_HOST} cannot be used: ${HOST_PORT_NAMES.map((name) => `it builds no ${name} port: a port its tool cannot fill is an unsupported(reason)`).join('; ')}`,
    });
  });

  it('refuses a port that is not an object, and takes the others', async () => {
    const source = await loadHostPorts(run, building({ ...everyPortUnsupported(), hooks: 'yes' }));
    assert.throws(() => source({ env: {}, platform: 'linux' }), {
      message: `the host adapter ${DEFAULT_HOST} cannot be used: it builds no hooks port: a port its tool cannot fill is an unsupported(reason)`,
    });
  });

  it('refuses an adapter whose create builds nothing', async () => {
    const source = await loadHostPorts(run, building(undefined));
    assert.throws(() => source({ env: {}, platform: 'linux' }), { message: `the host adapter ${DEFAULT_HOST} cannot be used: its create function built no ports` });
  });
});

describe('loadShippedHosts', () => {
  it('gives the way to build the ports of every host adapter teamrig ships with, the one it runs in among them', async () => {
    const asked: string[] = [];
    const importer: ModuleImporter = (specifier) => {
      asked.push(specifier);
      const id = specifier.split('/').at(-2) ?? '';
      return Promise.resolve({ default: { declaration: hostDeclarationData({ id }), create: () => ({ ...everyPortUnsupported(), paths: unsupported(`${id} tells no folder`) }) } });
    };
    const sources = await loadShippedHosts(run, importer);
    const ids = Object.keys(HOST_ADAPTERS);
    assert.equal(ids.includes(DEFAULT_HOST), true);
    assert.deepEqual(asked, ids.map((id) => `../adapters/hosts/${id}/index.ts`));
    assert.deepEqual(
      sources.map((source) => source({ env: {}, platform: 'linux' }).paths),
      ids.map((id) => unsupported(`${id} tells no folder`)),
    );
  });

  it('loads the shipped adapters as they are, each with its paths', async () => {
    const sources = await loadShippedHosts(run);
    assert.equal(sources.length, Object.keys(HOST_ADAPTERS).length);
    assert.deepEqual(sources.map((source) => isUnsupported(source({ env: {}, platform: 'linux' }).paths)), sources.map(() => false));
  });

  it('throws when one of them does not load, as the running one does: none is left out in silence', async () => {
    const missing: ModuleImporter = (specifier) => Promise.reject(new Error(`Cannot find module ${specifier}`));
    await assert.rejects(loadShippedHosts(run, missing), { message: /^the host adapter [a-z-]+ did not load: its index\.ts did not load: Cannot find module / });
  });
});
