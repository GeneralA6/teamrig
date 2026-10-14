import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../core/jsonl.ts';
import { parseRename } from './rename.ts';

function kindsOf(lines: readonly object[]): string[] {
  return parseJsonl(lines.map((line) => JSON.stringify(line)).join('\n')).records.map((record) => parseRename(record).kind);
}

const VALID = { v: 1, id: 'alpha', from: 'app-alpha', to: 'scout', at: '2030-01-08T09:00:00.000Z', by: 'alpha' };

describe('parseRename', () => {
  it('reads a whole record, and one written by hand without a version', () => {
    const { v: _version, ...unversioned } = VALID;
    const [first, second] = parseJsonl(`${JSON.stringify(VALID)}\n${JSON.stringify(unversioned)}`).records.map(parseRename);
    assert.deepEqual(first, { kind: 'rename', rename: VALID });
    assert.deepEqual(second, { kind: 'rename', rename: { ...VALID, v: 0 } });
  });

  it('skips a record from a newer release', () => {
    assert.deepEqual(kindsOf([{ ...VALID, v: 2 }]), ['newer']);
  });

  it('counts a record with a missing or malformed field as unreadable', () => {
    const broken = [
      { ...VALID, id: 'Alpha' },
      { ...VALID, from: 'App Alpha' },
      { ...VALID, to: 7 },
      { ...VALID, to: 'app-alpha' },
      { ...VALID, at: 'yesterday' },
      { ...VALID, by: '' },
      { v: 1 },
    ];
    assert.deepEqual(kindsOf(broken), broken.map(() => 'unreadable'));
  });
});
