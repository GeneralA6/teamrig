import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DenylistError, parseDenylist } from './denylist.ts';
import { scanText } from './scan.ts';

describe('parseDenylist', () => {
  it('skips blank lines and comments and names each rule after its line', () => {
    const rules = parseDenylist('# private terms\n\nacme\n  # indented comment\n/Widget/\n');
    assert.deepEqual(
      rules.map((rule) => rule.id),
      ['denylist:3', 'denylist:5'],
    );
    assert.ok(rules.every((rule) => rule.revealMatch));
  });

  it('matches a bare line case-insensitively and a /literal/ as written', () => {
    const rules = parseDenylist('acme\n/Widget/\n');
    const found = scanText('f', 'ACME widget Widget', rules).map((finding) => finding.match);
    assert.deepEqual(found, ['ACME', 'Widget']);
  });

  it('honours flags on a /literal/', () => {
    const rules = parseDenylist('/widget/i');
    assert.equal(scanText('f', 'WIDGET', rules).length, 1);
  });

  it('reads CRLF files', () => {
    assert.equal(parseDenylist('one\r\ntwo\r\n').length, 2);
  });

  it('rejects an invalid regex with its line number', () => {
    assert.throws(
      () => parseDenylist('fine\n(unclosed\n'),
      (error: unknown) => error instanceof DenylistError && error.line === 2,
    );
  });

  it('rejects the sticky flag', () => {
    assert.throws(() => parseDenylist('/x/y'), DenylistError);
  });
});
