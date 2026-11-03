import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { MIN_REDACTED_LENGTH, redact, tailOf, TAIL_CHARS, TAIL_LINES } from './redact.ts';

const SCANNER = new SecretScanner();

describe('redact', () => {
  it('replaces each injected value with its name', () => {
    const out = redact('connected with s3cr3t-value, done', [{ name: 'DB_WRITE_URI', value: 's3cr3t-value' }], SCANNER);
    assert.equal(out, 'connected with [redacted DB_WRITE_URI], done');
  });

  it('redacts the longest value first, so a value that holds another goes whole', () => {
    const values = [
      { name: 'SHORT', value: 'abcd' },
      { name: 'LONG', value: 'abcd-efgh' },
    ];
    assert.equal(redact('x abcd-efgh y abcd', values, SCANNER), 'x [redacted LONG] y [redacted SHORT]');
  });

  it('redacts the percent-encoded form a URL carries', () => {
    const out = redact('GET /x?token=p%40ss%2Fword', [{ name: 'API_TOKEN', value: 'p@ss/word' }], SCANNER);
    assert.equal(out, 'GET /x?token=[redacted API_TOKEN]');
  });

  it('leaves values shorter than the minimum alone', () => {
    const value = 'a'.repeat(MIN_REDACTED_LENGTH - 1);
    assert.equal(redact(`count ${value}`, [{ name: 'FLAG', value }], SCANNER), `count ${value}`);
  });

  it("blanks a URL's user part and keeps its host", () => {
    assert.equal(redact(['to db://app:', 'pw1234', '@dbhost:5432/app'].join(''), [], SCANNER), 'to db://[redacted]@dbhost:5432/app');
    assert.equal(redact('clone https://tok123@githost/r', [], SCANNER), 'clone https://[redacted]@githost/r');
  });

  it("applies the scanner's secret shapes", () => {
    const token = `ghp_${'a1'.repeat(18)}`;
    assert.equal(redact(`auth ${token} ok`, [], SCANNER), 'auth [redacted GitHub token] ok');
  });
});

describe('tailOf', () => {
  it('keeps the last lines and drops a final newline', () => {
    const text = `${Array.from({ length: TAIL_LINES + 5 }, (_, index) => `line ${index + 1}`).join('\r\n')}\r\n`;
    const tail = tailOf(text).split('\n');
    assert.equal(tail.length, TAIL_LINES);
    assert.equal(tail[0], 'line 6');
    assert.equal(tail.at(-1), `line ${TAIL_LINES + 5}`);
  });

  it('cuts a long tail to its last characters', () => {
    const text = `${'x'.repeat(TAIL_CHARS)}end`;
    const tail = tailOf(text);
    assert.equal(tail.length, TAIL_CHARS);
    assert.ok(tail.endsWith('end'));
  });

  it('returns short output whole', () => {
    assert.equal(tailOf('inserted 3\nunchanged 9\n'), 'inserted 3\nunchanged 9');
  });
});
