import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './parse.ts';
import { largeWindowOf, sessionRefreshOf } from './refresh.ts';

const ROSTER = { sessions: ['lead', 'web', 'api'], roles: { lead: 'lead' } };

describe('sessionRefreshOf', () => {
  const on = (refresh: object, launch: object = { web: { model: 'opus[1m]' } }): ReturnType<typeof parseConfig>['config'] =>
    parseConfig({ ...ROSTER, launch, refresh }).config;

  it('raises the threshold of a session launched on a 1M window to largeWindowContextTokens, and no other', () => {
    const config = on({});
    assert.equal(sessionRefreshOf(config, 'web').contextTokens, 250_000);
    assert.equal(sessionRefreshOf(config, 'api').contextTokens, 120_000);
    assert.equal(sessionRefreshOf(config, 'lead').contextTokens, 120_000, "the lead's plain opus shows no suffix");
    assert.deepEqual([largeWindowOf(config, 'web'), largeWindowOf(config, 'lead')], [true, false]);
  });

  it('keeps contextTokens on every window with 0, or when it is already the larger', () => {
    assert.equal(sessionRefreshOf(on({ largeWindowContextTokens: 0 }), 'web').contextTokens, 120_000);
    assert.equal(sessionRefreshOf(on({ contextTokens: 300_000 }), 'web').contextTokens, 300_000);
    assert.equal(sessionRefreshOf(on({ largeWindowContextTokens: 90_000 }), 'web').contextTokens, 120_000);
  });

  it('changes nothing else of refresh, the automatic restart included', () => {
    const config = on({ autoRestart: true });
    assert.deepEqual(sessionRefreshOf(config, 'web'), { ...config.refresh, contextTokens: 250_000 });
    assert.deepEqual(sessionRefreshOf(config, 'api'), config.refresh);
  });
});
