import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyManifestChange, installTouches, needsInstall, packageFilesChange, type ManifestAt } from './manifest.ts';

function manifest(fields: Readonly<Record<string, unknown>> = {}, scripts: Readonly<Record<string, string>> = { test: 'node --test' }): string {
  return JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { zod: '3.23.8' }, ...fields, scripts });
}

describe('classifyManifestChange', () => {
  it('sees no change in two equal manifests or two missing ones', () => {
    assert.equal(classifyManifestChange(manifest(), manifest()), 'none');
    assert.equal(classifyManifestChange(undefined, undefined), 'none');
  });

  it('needs an install for a field an install reads', () => {
    assert.equal(classifyManifestChange(manifest(), manifest({ dependencies: { zod: '3.23.9' } })), 'install');
    assert.equal(classifyManifestChange(manifest(), manifest({ overrides: { zod: '3.23.8' } })), 'install');
    assert.equal(classifyManifestChange(manifest({ engines: { node: '>=22' } }), manifest()), 'install');
  });

  it('needs an install for a missing or unreadable side', () => {
    assert.equal(classifyManifestChange(undefined, manifest()), 'install');
    assert.equal(classifyManifestChange(manifest(), undefined), 'install');
    assert.equal(classifyManifestChange(manifest(), '{"name": '), 'install');
    assert.equal(classifyManifestChange('[]', manifest()), 'install');
  });

  it('needs no install for a change to scripts no install hook reaches', () => {
    const before = manifest({}, { test: 'node --test', prepare: 'husky' });
    assert.equal(classifyManifestChange(before, manifest({}, { test: 'node --test src', prepare: 'husky' })), 'no-install');
    assert.equal(classifyManifestChange(before, manifest({}, { test: 'node --test', prepare: 'husky', lint: 'eslint .' })), 'no-install');
    const noScripts = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { zod: '3.23.8' }, scripts: 'none' });
    assert.equal(classifyManifestChange(noScripts, manifest()), 'no-install');
  });

  it('needs no install for a change to a tool\'s settings or the package description, with such scripts too', () => {
    const jest = { preset: 'ts-jest' };
    assert.equal(classifyManifestChange(manifest({ jest }), manifest({ jest: { ...jest, transform: { '^.+\\.ts$': ['ts-jest', { useESM: true }] } } })), 'no-install');
    assert.equal(classifyManifestChange(manifest(), manifest({ 'lint-staged': { '*.ts': 'eslint' }, description: 'The app' })), 'no-install');
    assert.equal(classifyManifestChange(manifest({ prettier: { semi: true } }), manifest({}, { test: 'node --test src' })), 'no-install');
  });

  it('still needs an install when a tool setting changes beside a field an install reads, a hook, or a field it does not know', () => {
    assert.equal(classifyManifestChange(manifest(), manifest({ jest: { preset: 'ts-jest' }, dependencies: { zod: '3.23.9' } })), 'install');
    assert.equal(classifyManifestChange(manifest(), manifest({ jest: { preset: 'ts-jest' } }, { test: 'node --test', postinstall: 'node setup.js' })), 'install');
    assert.equal(classifyManifestChange(manifest(), manifest({ someTool: { on: true } })), 'install');
  });

  it('needs an install for a changed hook or a script a hook reaches, through other scripts too', () => {
    const before = manifest({}, { prepare: 'npm run build', build: 'npm run gen', gen: 'node gen.js', 'gen:docs': 'node docs.js' });
    assert.equal(classifyManifestChange(before, manifest({}, { prepare: 'husky', build: 'npm run gen', gen: 'node gen.js', 'gen:docs': 'node docs.js' })), 'install');
    assert.equal(classifyManifestChange(before, manifest({}, { prepare: 'npm run build', build: 'npm run gen', gen: 'node gen2.js', 'gen:docs': 'node docs.js' })), 'install');
    assert.equal(classifyManifestChange(before, manifest({}, { prepare: 'npm run build', build: 'npm run gen', gen: 'node gen.js', 'gen:docs': 'node docs2.js' })), 'no-install');
  });

  it('needs an install when a new hook appears', () => {
    assert.equal(classifyManifestChange(manifest(), manifest({}, { test: 'node --test', postinstall: 'node setup.js' })), 'install');
  });
});

describe('packageFilesChange', () => {
  const ends = (before: string | undefined, after: string | undefined): { at: ManifestAt; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      at: async (end) => {
        asked.push(end);
        return end === 'before' ? before : after;
      },
    };
  };

  it('reads the manifest at both ends only when the range touches it', async () => {
    const untouched = ends(manifest(), manifest({ version: '2.0.0' }));
    assert.deepEqual(await packageFilesChange(['src/app.ts', 'package-lock.json'], untouched.at), { lockfile: true, manifest: 'none' });
    assert.deepEqual(untouched.asked, []);
    const touched = ends(manifest(), manifest({ version: '2.0.0' }));
    assert.deepEqual(await packageFilesChange(['package.json'], touched.at), { lockfile: false, manifest: 'install' });
    assert.deepEqual(touched.asked, ['before', 'after']);
  });

  it('looks at the root package files only', async () => {
    assert.deepEqual(await packageFilesChange(['tools/package.json', 'tools/package-lock.json'], ends(undefined, manifest()).at), { lockfile: false, manifest: 'none' });
  });
});

describe('needsInstall and installTouches', () => {
  it('need the install for a lockfile change or a manifest change an install reads, and name each', () => {
    assert.equal(needsInstall({ lockfile: false, manifest: 'no-install' }), false);
    assert.deepEqual(installTouches({ lockfile: false, manifest: 'no-install' }), []);
    assert.equal(needsInstall({ lockfile: true, manifest: 'none' }), true);
    assert.equal(needsInstall({ lockfile: false, manifest: 'install' }), true);
    assert.deepEqual(installTouches({ lockfile: true, manifest: 'install' }), ['package-lock.json', 'package.json fields an install reads']);
  });
});
