import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl, toJsonlLine, type JsonlRecord } from '../core/jsonl.ts';
import { LAYOUT_VERSION, markerRecord, parseMarker, ROTATED_TYPE } from './marker.ts';

function line(record: Record<string, unknown>): JsonlRecord {
  const [parsed] = parseJsonl(JSON.stringify(record)).records;
  assert.ok(parsed !== undefined);
  return parsed;
}

describe('parseMarker', () => {
  it('reads the marker a rotation writes, naming the segment the log goes on from', () => {
    const [parsed] = parseJsonl(toJsonlLine(markerRecord(3, '2030-01-07T09:00:00.000Z'))).records;
    assert.ok(parsed !== undefined);
    assert.deepEqual(parseMarker(parsed), { kind: 'marker', after: 3 });
  });

  it('leaves every other line alone: events, and a rotated type below the layout version', () => {
    assert.deepEqual(parseMarker(line({ v: 2, type: 'create', id: 'T1' })), { kind: 'none' });
    assert.deepEqual(parseMarker(line({ v: LAYOUT_VERSION - 1, type: ROTATED_TYPE, after: 1 })), { kind: 'none' });
  });

  it('counts a marker from a newer layout as newer, and a damaged one as unreadable', () => {
    assert.deepEqual(parseMarker(line({ v: LAYOUT_VERSION + 1, type: ROTATED_TYPE, after: 1 })), { kind: 'newer' });
    for (const after of [-1, 1.5, '2', null]) {
      assert.deepEqual(parseMarker(line({ v: LAYOUT_VERSION, type: ROTATED_TYPE, after })), { kind: 'unreadable' }, String(after));
    }
  });

  it('sits above every event version a teamrig without rotation wrote, so such a teamrig never appends after it', () => {
    assert.ok(LAYOUT_VERSION > 2);
    assert.deepEqual(markerRecord(1, 'now'), { v: LAYOUT_VERSION, type: ROTATED_TYPE, after: 1, at: 'now' });
  });
});
