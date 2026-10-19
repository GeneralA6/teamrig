import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseObject } from '../core/jsonl.ts';
import { cappedText, formatEntry, MAX_TEXT_CHARS, parseEntry, type TurnLogEntry } from './entry.ts';

const AT = '2030-01-08T10:00:00.000Z';
const CLAUDE = '0123abcd-0000-4000-8000-00000000000a';

function lineOf(entry: TurnLogEntry): string {
  return formatEntry(entry).trim();
}

describe('turn log entry', () => {
  it('reads back what it wrote, with its version and optional fields', () => {
    const entry: TurnLogEntry = { at: AT, kind: 'reply', text: 'Fixed.', claude: CLAUDE, truncated: true, upTo: 'a2' };
    const record = parseObject(lineOf(entry));
    assert.equal(record?.['v'], 1);
    assert.deepEqual(record === undefined ? undefined : parseEntry(record), entry);
    const plain: TurnLogEntry = { at: AT, kind: 'prompt', text: 'go', claude: CLAUDE };
    const plainRecord = parseObject(lineOf(plain));
    assert.deepEqual(plainRecord === undefined ? undefined : parseEntry(plainRecord), plain);
  });

  it('refuses a line of another version, an unknown kind or a missing field, and reads only truncated true', () => {
    const base = { v: 1, at: AT, kind: 'clear', text: 'context cleared (/clear)', claude: CLAUDE };
    assert.equal(parseEntry({ ...base, v: 2 }), undefined);
    assert.equal(parseEntry({ ...base, kind: 'thought' }), undefined);
    assert.equal(parseEntry({ v: 1, at: AT, kind: 'clear', claude: CLAUDE }), undefined);
    assert.deepEqual(parseEntry({ ...base, truncated: 'yes' }), { at: AT, kind: 'clear', text: 'context cleared (/clear)', claude: CLAUDE });
  });

  it('keeps the end of a text past the cap, where the answer is', () => {
    assert.deepEqual(cappedText('short'), { text: 'short', cut: false });
    const long = `${'a'.repeat(10)}${'b'.repeat(MAX_TEXT_CHARS)}`;
    assert.deepEqual(cappedText(long), { text: 'b'.repeat(MAX_TEXT_CHARS), cut: true });
  });
});
