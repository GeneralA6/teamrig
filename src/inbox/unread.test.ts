import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InboxMark } from './marks.ts';
import { inboxLines, unreadOf, type LineHash } from './unread.ts';

const LINES = ['- 2030-01-07 09:00 lead: first', '- 2030-01-07 10:00 bravo: second', '- 2030-01-07 11:00 lead: third'];

/** A stand-in for the SHA-256 fingerprint: unreadOf only compares hashes, so any injective function will do. */
const fakeHash: LineHash = (line) => `hash:${line}`;

function mark(line: number, lastLineHash: string | null): InboxMark {
  return { v: 1, area: 'alpha', line, at: '2030-01-07T12:00:00.000Z', claudeSession: null, lastLineHash };
}

describe('unreadOf', () => {
  it('starts after the mark when the file only grew', () => {
    const unread = unreadOf('alpha', LINES, mark(2, fakeHash(LINES[1] ?? '')), fakeHash);
    assert.deepEqual([unread.resume, unread.lines, unread.total], ['grew', [LINES[2]], 3]);
  });

  it('finds its place again after old lines were trimmed from the top', () => {
    const trimmed = [LINES[1] ?? '', LINES[2] ?? '', '- 2030-01-08 08:00 lead: fourth'];
    const unread = unreadOf('alpha', trimmed, mark(2, fakeHash(LINES[1] ?? '')), fakeHash);
    assert.deepEqual([unread.resume, unread.lines], ['moved', trimmed.slice(1)]);
  });

  it('shows everything when the last line read is gone', () => {
    assert.equal(unreadOf('alpha', LINES, mark(2, fakeHash('- something else')), fakeHash).resume, 'rewritten');
    assert.equal(unreadOf('alpha', LINES, mark(3, fakeHash('x')), fakeHash).lines.length, 3);
  });

  it('compares with the hash it is given, so a reader hashing differently finds no line', () => {
    const otherHash: LineHash = (line) => `other:${line}`;
    assert.equal(unreadOf('alpha', LINES, mark(2, fakeHash(LINES[1] ?? '')), otherHash).resume, 'rewritten');
  });

  it('reads a mark at line 0 as nothing read yet, without hashing', () => {
    const neverCalled: LineHash = () => assert.fail('no line needs a hash');
    assert.deepEqual(unreadOf('alpha', LINES, mark(0, 'any'), neverCalled).lines, LINES);
  });

  it('trusts a v0 mark unless the file shrank below it', () => {
    assert.deepEqual(unreadOf('alpha', LINES, mark(1, null), fakeHash).lines, LINES.slice(1));
    assert.equal(unreadOf('alpha', LINES, mark(5, null), fakeHash).resume, 'rewritten');
    assert.equal(unreadOf('alpha', LINES, null, fakeHash).resume, 'never');
  });
});

describe('inboxLines', () => {
  it('keeps the non-empty lines without their CR line ends', () => {
    assert.deepEqual(inboxLines(`${LINES.join('\r\n')}\r\n\r\n  \n`), LINES);
    assert.deepEqual(inboxLines(''), []);
  });
});
