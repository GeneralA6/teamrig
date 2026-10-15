import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from './defaults.ts';
import { parseConfigText } from './text.ts';
import { CONFIG_VERSION } from './types.ts';

const ROSTER = { sessions: ['alpha'], roles: { lead: 'alpha' } };

describe('parseConfigText', () => {
  it('reads the priority names of a version 1 file, migrated in memory', () => {
    const tiers = [{ id: 1, name: 'now' }, { id: 7, name: 'someday' }];
    const read = parseConfigText(JSON.stringify({ ...ROSTER, configVersion: 1, register: { tiers } }));
    assert.equal(read.status, 'loaded');
    if (read.status === 'loaded') {
      assert.deepEqual(read.config.register.priorities, tiers);
      assert.equal(read.pending?.fromVersion, 1);
      assert.deepEqual(read.issues, []);
    }
  });

  it('falls back to the default priorities when the file names none', () => {
    const read = parseConfigText(JSON.stringify({ ...ROSTER, configVersion: CONFIG_VERSION }));
    assert.equal(read.status === 'loaded' && read.config.register.priorities, DEFAULT_REGISTER.priorities);
  });

  it('reports text it cannot read, with the reason', () => {
    assert.deepEqual(parseConfigText('{ not json').status, 'unreadable');
    assert.deepEqual(parseConfigText('[1]'), { status: 'unreadable', issue: { path: '', message: 'expected a JSON object at the top level' } });
    const read = parseConfigText(JSON.stringify({ configVersion: 'one' }));
    assert.equal(read.status === 'unreadable' && read.issue.path, 'configVersion');
  });
});
