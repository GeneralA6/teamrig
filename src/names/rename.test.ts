import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../core/jsonl.ts';
import { parseRename, readRenames } from './rename.ts';

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

describe('readRenames', () => {
  it('reads the renames in file order, and counts the lines it skips', () => {
    const later = { ...VALID, from: 'scout', to: 'ranger', at: '2030-01-09T09:00:00.000Z' };
    const text = [JSON.stringify(VALID), '{torn', JSON.stringify({ ...VALID, v: 2 }), JSON.stringify({ ...VALID, to: 'Not A Name' }), JSON.stringify(later), ''].join('\r\n');
    assert.deepEqual(readRenames(text), { renames: [VALID, later], unreadable: 2, newer: 1 });
    assert.deepEqual(readRenames(''), { renames: [], unreadable: 0, newer: 0 });
  });
});
