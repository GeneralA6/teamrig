import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsupported, unsupported, type HostDeps, type ProgramRunner } from '../plugin-api/index.ts';
import { hostDeclarationData } from '../testing/manifests.ts';
import { DEFAULT_HOST } from './adapters.ts';
import { loadHostPorts } from './host-ports.ts';
import type { ModuleImporter } from './loader.ts';

const run: ProgramRunner = () => Promise.reject(new Error('no program runs here'));

describe('loadHostPorts', () => {
  it('gives the shipped host adapter a filled transcript reader, usage meter and status line', async () => {
    const ports = (await loadHostPorts(run))({ env: {}, platform: 'linux' });
    assert.deepEqual(Object.keys(ports), ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine']);
    assert.equal(isUnsupported(ports.transcripts), false);
    assert.equal(isUnsupported(ports.usage), false);
    assert.equal(isUnsupported(ports.statusLine), false);
  });

  it('hands the adapter what each run sees, with the one runner of the process', async () => {
    const built: HostDeps[] = [];
    const entry = {
      declaration: hostDeclarationData({ id: DEFAULT_HOST }),
      create: (deps: HostDeps) => {
        built.push(deps);
        return { transcripts: unsupported('this host keeps no transcript'), usage: unsupported('this host prices no call') };
      },
    };
    const importer: ModuleImporter = () => Promise.resolve({ default: entry });
    const source = await loadHostPorts(run, importer);
    assert.deepEqual(built, [], 'loading builds no port');
    const ports = source({ env: { RUN: 'one' }, platform: 'darwin' });
    source({ env: { RUN: 'two' }, platform: 'win32' });
    assert.deepEqual(ports, { transcripts: { kind: 'unsupported', notice: 'this host keeps no transcript' }, usage: { kind: 'unsupported', notice: 'this host prices no call' } });
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
});
