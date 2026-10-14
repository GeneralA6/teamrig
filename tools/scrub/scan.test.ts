import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScrubRule } from './rules.ts';
import { formatFinding, scanText, type Finding } from './scan.ts';

function rule(id: string, pattern: RegExp, extra: Partial<Pick<ScrubRule, 'isAllowed' | 'revealMatch'>> = {}): ScrubRule {
  return { id, description: `${id} rule`, pattern, revealMatch: extra.revealMatch ?? false, ...extra };
}

const positions = (findings: readonly Finding[]): Array<[string, number, number]> =>
  findings.map((finding) => [finding.ruleId, finding.line, finding.column]);

describe('scanText', () => {
  it('reports 1-based lines and columns, sorted by position', () => {
    const findings = scanText('f.txt', 'one\ntwo beta\nalpha beta', [rule('b', /beta/g), rule('a', /alpha/g)]);
    assert.deepEqual(positions(findings), [
      ['b', 2, 5],
      ['a', 3, 1],
      ['b', 3, 7],
    ]);
  });

  it('finds every match even when the rule lacks the global flag', () => {
    assert.equal(scanText('f', 'alpha alpha', [rule('a', /alpha/)]).length, 2);
  });

  it('skips matches the rule allows', () => {
    const allowSecond = rule('n', /n\d/g, { isAllowed: (match) => match[0] === 'n2' });
    assert.deepEqual(positions(scanText('f', 'n1 n2 n3', [allowSecond])), [
      ['n', 1, 1],
      ['n', 1, 7],
    ]);
  });

  it('handles CRLF text and an empty input', () => {
    assert.deepEqual(positions(scanText('f', 'a\r\nb x', [rule('x', /x/g)])), [['x', 2, 3]]);
    assert.deepEqual(scanText('f', '', [rule('x', /x/g)]), []);
  });
});

describe('formatFinding', () => {
  const base: Finding = {
    ruleId: 'r',
    description: 'a rule',
    source: 'dir/f.txt',
    line: 3,
    column: 9,
    match: 'confidential',
    revealMatch: false,
  };

  it('masks the match of a generic rule', () => {
    assert.equal(formatFinding(base), 'dir/f.txt:3:9 r: a rule "con"... (12 chars)');
  });

  it('shows the match of a private rule', () => {
    assert.equal(formatFinding({ ...base, revealMatch: true }), 'dir/f.txt:3:9 r: a rule "confidential"');
  });
});
