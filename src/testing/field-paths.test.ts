import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from './field-paths.ts';

describe('fieldPaths', () => {
  it('lists nested fields once each, sorted, with array entries as []', () => {
    const value = { v: 1, b: { y: 2, x: null }, a: [{ id: 'p' }, { id: 'q', kind: 'r' }], tags: ['s', 't'] };
    assert.deepEqual(fieldPaths(value), ['a[].id', 'a[].kind', 'b.x', 'b.y', 'tags[]', 'v']);
  });

  it("reads a map's keys as *, merging its entries' fields", () => {
    const value = { byDay: { '2030-01-07': { w: 1 }, '2030-01-08': { w: 2, calls: 3 } }, cursors: { '/t/a.jsonl': { day: { size: 4 } } } };
    assert.deepEqual(fieldPaths(value, new Set(['byDay', 'cursors'])), ['byDay.*.calls', 'byDay.*.w', 'cursors.*.day.size']);
  });

  it("reads a root map's keys as * when the maps hold ''", () => {
    assert.deepEqual(fieldPaths({ alpha: 1, bravo: 2 }, new Set([''])), ['*']);
  });

  it('reads a bare value as the empty path', () => {
    assert.deepEqual(fieldPaths(7), ['']);
  });
});
