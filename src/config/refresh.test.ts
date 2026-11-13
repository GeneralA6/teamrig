import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './parse.ts';
import { autoRestartOf, sessionRefreshOf } from './refresh.ts';

const ROSTER = { sessions: ['lead', 'web', 'api'], roles: { lead: 'lead' } };

describe('autoRestartOf', () => {
  it("turns the automatic restart on for the lead only by default and with 'lead'", () => {
    for (const refresh of [{}, { autoRestart: 'lead' }]) {
      const { config, issues } = parseConfig({ ...ROSTER, refresh });
      assert.deepEqual(issues, []);
      assert.equal(config.refresh.autoRestart, 'lead');
      assert.deepEqual(['lead', 'web', 'api'].map((id) => autoRestartOf(config, id)), [true, false, false]);
    }
  });

  it('keeps true and false for every session', () => {
    const on = parseConfig({ ...ROSTER, refresh: { autoRestart: true } }).config;
    assert.deepEqual(['lead', 'web'].map((id) => autoRestartOf(on, id)), [true, true]);
    const off = parseConfig({ ...ROSTER, refresh: { autoRestart: false } }).config;
    assert.deepEqual(['lead', 'web'].map((id) => autoRestartOf(off, id)), [false, false]);
  });

  it('refuses any other value, keeping the default', () => {
    const { config, issues } = parseConfig({ ...ROSTER, refresh: { autoRestart: 'members' } });
    assert.deepEqual(issues.map((issue) => issue.path), ['refresh.autoRestart']);
    assert.equal(config.refresh.autoRestart, 'lead');
  });
});

describe('sessionRefreshOf', () => {
  const on = (refresh: object, launch: object = { web: { model: 'opus[1m]' } }): ReturnType<typeof parseConfig>['config'] =>
    parseConfig({ ...ROSTER, launch, refresh }).config;

  it('raises the threshold of a session launched on a 1M window to largeWindowContextTokens, and no other', () => {
    const config = on({});
    assert.equal(sessionRefreshOf(config, 'web').contextTokens, 250_000);
    assert.equal(sessionRefreshOf(config, 'api').contextTokens, 120_000);
    assert.equal(sessionRefreshOf(config, 'lead').contextTokens, 120_000, "the lead's plain opus shows no suffix");
    assert.equal(sessionRefreshOf(config, 'lead').autoRestart, true);
    assert.equal(sessionRefreshOf(config, 'web').autoRestart, false);
  });

  it('keeps contextTokens on every window with 0, or when it is already the larger', () => {
    assert.equal(sessionRefreshOf(on({ largeWindowContextTokens: 0 }), 'web').contextTokens, 120_000);
    assert.equal(sessionRefreshOf(on({ contextTokens: 300_000 }), 'web').contextTokens, 300_000);
    assert.equal(sessionRefreshOf(on({ largeWindowContextTokens: 90_000 }), 'web').contextTokens, 120_000);
  });
});
