import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newestNear, parentOf } from './plugin-store.ts';

const TEAMRIG_FOLDER = 'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig';

describe('newestNear', () => {
  it('takes the newest time less than the window from now either way', () => {
    const now = 1_000_000;
    const window = 10_000;
    assert.equal(newestNear([now - window, now - 1, now + 5, now + window], now, window), now + 5);
    assert.equal(newestNear([now - window + 1, now + 30 * window], now, window), now - window + 1, 'one far ahead of the clock left out');
    assert.equal(newestNear([now - window, now + window], now, window), undefined);
    assert.equal(newestNear([], now, window), undefined);
    assert.equal(newestNear([now - window], now, window + 1), now - window, 'a wider window takes it');
  });
});

describe('parentOf', () => {
  it('cuts the last part of a path at either slash, a trailing one first', () => {
    assert.equal(parentOf(`${TEAMRIG_FOLDER}\\0.42.0`), TEAMRIG_FOLDER);
    assert.equal(parentOf('/home/me/.claude/plugins/cache/m/p/1.0.0/'), '/home/me/.claude/plugins/cache/m/p');
    assert.equal(parentOf('C:/Users/me\\plugins'), 'C:/Users/me');
  });

  it('keeps a path with no folder above it as it is', () => {
    for (const path of ['plugins', '/plugins', '']) {
      assert.equal(parentOf(path), path, path);
    }
  });
});
