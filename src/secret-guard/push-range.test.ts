import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pushRanges, rangeArgs } from './push-range.ts';

const TIP = '74d7d9a1aa2ee96b68d514b1a3ab793902af21e3';
const BASE = '292903d346c154fc625af8012059a8c59c6913b0';
const FETCHED_NEVER = '1a3f45714a243c07aeef1966157752fbfaec1b23';
const ZERO = '0'.repeat(40);
const SHA256_TIP = `${TIP}${'5e'.repeat(12)}`;

const held = (sha: string): boolean => sha === BASE;

describe('pushRanges', () => {
  it('bounds a ref by the remote commit this repo holds, and sends every unpushed commit of a new ref', () => {
    const stdin = [`refs/heads/feat ${TIP} refs/heads/feat ${BASE}`, `refs/heads/new ${TIP} refs/heads/new ${ZERO}`, ''].join('\n');
    assert.deepEqual(pushRanges(stdin, 'origin', held), [
      { kind: 'after', base: BASE, tip: TIP },
      { kind: 'unpushed', tip: TIP, remote: 'origin' },
    ]);
  });

  it('sends every unpushed commit when the remote commit was never fetched, as after a push from another clone', () => {
    assert.deepEqual(pushRanges(`refs/heads/main ${TIP} refs/heads/main ${FETCHED_NEVER}\n`, 'upstream', held), [{ kind: 'unpushed', tip: TIP, remote: 'upstream' }]);
  });

  it('sends nothing for a deleted ref or an empty stdin, and reads CRLF lines and SHA-256 ids', () => {
    assert.deepEqual(pushRanges(`(delete) ${ZERO} refs/heads/old ${BASE}\n`, 'origin', held), []);
    assert.deepEqual(pushRanges('', 'origin', held), []);
    assert.deepEqual(pushRanges(`HEAD ${SHA256_TIP} refs/heads/main ${'0'.repeat(64)}\r\n`, 'origin', held), [{ kind: 'unpushed', tip: SHA256_TIP, remote: 'origin' }]);
  });

  it('refuses a line git would not write, naming its number and never trusting what it holds', () => {
    const cases = [
      `refs/heads/feat ${TIP} refs/heads/feat`,
      `refs/heads/feat ${TIP} refs/heads/feat ${BASE} extra`,
      `refs/heads/feat --all refs/heads/feat ${BASE}`,
      `refs/heads/feat ${TIP} refs/heads/feat ${BASE.slice(0, 7)}`,
      `refs/heads/feat ${TIP.toUpperCase()} refs/heads/feat ${BASE}`,
    ] as const;
    for (const line of cases) {
      assert.throws(() => pushRanges(`\n${line}\n`, 'origin', held), { message: /^pre-push line 2 is not/ }, line);
    }
  });
});

describe('rangeArgs', () => {
  it('reads a bounded range as base..tip, and an unpushed one as the tip without what the remote holds', () => {
    assert.deepEqual(rangeArgs({ kind: 'after', base: BASE, tip: TIP }), [`${BASE}..${TIP}`]);
    assert.deepEqual(rangeArgs({ kind: 'unpushed', tip: TIP, remote: 'origin' }), [TIP, '--not', '--remotes=origin']);
  });
});
