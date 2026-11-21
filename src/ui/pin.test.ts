import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import { isArchivePath } from './archive.ts';
import { RELEASED_UI } from './pin.ts';

describe('RELEASED_UI', () => {
  it('is unset, or names a plain version, an https address and a lowercase sha256', () => {
    if (RELEASED_UI === undefined) return;
    assert.ok(isArchivePath(RELEASED_UI.version) && !RELEASED_UI.version.includes('/'), RELEASED_UI.version);
    assert.equal(new URL(RELEASED_UI.url).protocol, 'https:');
    assert.match(RELEASED_UI.sha256, /^[0-9a-f]{64}$/);
  });

  it('is never set or replaced by the team config', () => {
    const pin = { version: '9.9.9', url: 'https://example.com/teamrig-ui.json', sha256: 'ab'.repeat(32) };
    const raw = { sessions: ['alpha'], roles: { lead: 'alpha' }, ui: { pin, ...pin, released: pin } };
    assert.deepEqual(parseConfig(raw).config.ui, {});
  });
});
