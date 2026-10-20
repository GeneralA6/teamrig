import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertWritable, NewerDataError, parseJsonl, recordVersion, toJsonlLine, writableObject } from './jsonl.ts';

describe('parseJsonl', () => {
  it('reads objects with their line numbers and versions, skipping blank lines', () => {
    const parse = parseJsonl('{"a":1}\n\n{"v":1,"b":2}\r\n');
    assert.deepEqual(
      parse.records.map((record) => [record.lineNumber, record.version, record.raw]),
      [
        [1, 0, '{"a":1}'],
        [3, 1, '{"v":1,"b":2}'],
      ],
    );
    assert.equal(parse.unreadable, 0);
  });

  it('counts damaged lines, non-objects and invalid versions without throwing', () => {
    const parse = parseJsonl('{"a":1}\n{"torn\n[1,2]\n"text"\n{"v":-1}\n{"v":"2"}\n{"v":1.5}\n');
    assert.equal(parse.records.length, 1);
    assert.equal(parse.unreadable, 6);
  });

  it('reads an empty log', () => {
    assert.deepEqual(parseJsonl(''), { records: [], unreadable: 0 });
  });
});

describe('recordVersion', () => {
  it('treats a missing version as 0', () => {
    assert.equal(recordVersion({}), 0);
    assert.equal(recordVersion({ v: 3 }), 3);
    assert.equal(recordVersion({ v: null }), undefined);
  });
});

describe('toJsonlLine', () => {
  it('writes one line even when a value holds newlines', () => {
    const line = toJsonlLine({ note: 'one\ntwo' });
    assert.equal(line.split('\n').length, 2);
    assert.equal(parseJsonl(line).records[0]?.record['note'], 'one\ntwo');
  });
});

describe('assertWritable', () => {
  it('allows writing beside older and equal versions', () => {
    assert.doesNotThrow(() => assertWritable('log', parseJsonl('{"a":1}\n{"v":1}\n'), 1));
  });

  it('refuses writing beside a newer version', () => {
    assert.throws(
      () => assertWritable('log', parseJsonl('{"v":2}\n'), 1),
      (error: unknown) => error instanceof NewerDataError && error.found === 2 && error.known === 1,
    );
  });
});

describe('writableObject', () => {
  it('returns the record of an older or equal format, and nothing for a missing or damaged file', () => {
    assert.deepEqual(writableObject('file', '{"v":1,"a":2}\n', 1), { v: 1, a: 2 });
    assert.deepEqual(writableObject('file', '{"a":2}', 1), { a: 2 });
    assert.equal(writableObject('file', undefined, 1), undefined);
    assert.equal(writableObject('file', '{"torn', 1), undefined);
  });

  it('refuses a file in a newer format', () => {
    assert.throws(
      () => writableObject('file', '{"v":2}', 1),
      (error: unknown) => error instanceof NewerDataError && error.file === 'file' && error.found === 2 && error.known === 1,
    );
  });
});
