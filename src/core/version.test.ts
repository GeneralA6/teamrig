import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord } from './guards.ts';
import { KIT_NAME } from './home.ts';
import { KIT_VERSION } from './version.ts';

describe('plugin manifest', () => {
  it('declares the same name and version as the code', async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL('../../plugins/teamrig/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    );
    assert.ok(isRecord(manifest));
    assert.equal(manifest['name'], KIT_NAME);
    assert.equal(manifest['version'], KIT_VERSION);
  });

  // An install copies the plugin folder alone, so its license terms travel only as copies of the root files (T1555).
  for (const name of ['LICENSE', 'NOTICE']) {
    it(`carries the repository's ${name} unchanged`, async () => {
      const root = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
      const copy = await readFile(new URL(`../../plugins/teamrig/${name}`, import.meta.url), 'utf8');
      assert.equal(copy, root);
    });
  }
});
