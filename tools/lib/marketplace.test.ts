import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRecord } from './guards.ts';
import { MARKETPLACE, readCatalog } from './marketplace.ts';

describe('the marketplace catalog this repo ships', () => {
  const text = readFileSync(new URL(`../../${MARKETPLACE}`, import.meta.url), 'utf8');

  it('gives no version in an entry, which Claude Code would ignore for the one in plugin.json', () => {
    assert.deepEqual(readCatalog(text).problems, []);
  });

  it('installs teamrig from the release branch, where the release workflow publishes the built dist (T4355)', () => {
    const catalog: unknown = JSON.parse(text);
    const entries: unknown = isRecord(catalog) ? catalog['plugins'] : undefined;
    const teamrig = Array.isArray(entries) ? entries.filter(isRecord).find((entry) => entry['name'] === 'teamrig') : undefined;
    assert.deepEqual(teamrig?.['source'], { source: 'git-subdir', url: 'https://github.com/teamrig/teamrig.git', path: 'plugins/teamrig', ref: 'release' });
    assert.deepEqual(readCatalog(text).plugins, [{ name: 'teamrig', folder: 'plugins/teamrig' }]);
  });
});

describe('readCatalog', () => {
  it('lists the plugins whose source is a folder in the repo', () => {
    const text = JSON.stringify({
      plugins: [
        { name: 'local', source: './plugins/local/' },
        { name: 'remote', source: { source: 'github', repo: 'someone/else' } },
        { name: 'root', source: './' },
        { name: 'released', source: { source: 'git-subdir', url: 'https://example.com/a.git', path: './plugins/released/', ref: 'release' } },
        { name: 'no path', source: { source: 'git-subdir', url: 'https://example.com/a.git' } },
        'not an entry',
      ],
    });
    assert.deepEqual(readCatalog(text), {
      plugins: [
        { name: 'local', folder: 'plugins/local' },
        { name: 'root', folder: '' },
        { name: 'released', folder: 'plugins/released' },
      ],
      problems: [],
    });
  });

  it('flags an entry that gives a version, which Claude Code ignores', () => {
    const { problems } = readCatalog(JSON.stringify({ plugins: [{ name: 'demo', source: './p', version: '0.1.0' }, { version: '1.0.0' }] }));
    assert.deepEqual(problems, [
      `demo: drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`,
      `(unnamed): drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`,
    ]);
  });

  it('refuses a catalog without a plugins list', () => {
    assert.throws(() => readCatalog('{"name":"demo"}'), /has no "plugins" list/);
    assert.throws(() => readCatalog('[]'), /has no "plugins" list/);
  });
});
