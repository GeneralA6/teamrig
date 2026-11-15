import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './parse.ts';
import { autoRestartOf } from './refresh.ts';

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
