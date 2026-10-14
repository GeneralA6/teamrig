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
});
