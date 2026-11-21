import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addFollow, dropFollow, followersOf, FOLLOWS_FORMAT, followTarget, formatFollows, parseFollows } from './follows.ts';

describe('followTarget', () => {
  it('reads owner/name#n and its gh: ref, the repository in lowercase', () => {
    assert.deepEqual(followTarget('Acme/Web#7'), { repo: 'acme/web', number: 7 });
    assert.deepEqual(followTarget(' gh:acme/web#12 '), { repo: 'acme/web', number: 12 });
  });

  it('reads nothing else', () => {
    for (const text of ['acme/web', 'acme/web#0', 'acme#7', 'gh:acme/..#7', 'https://example.test/acme/web/issues/7', '']) {
      assert.equal(followTarget(text), undefined, text);
    }
  });
});

describe('parseFollows and formatFollows', () => {
  it('round-trips the follows, sessions in name order and a session that follows nothing left out', () => {
    const follows = new Map([
      ['bravo', ['gh:acme/web#7']],
      ['alpha', ['gh:acme/web#3', 'gh:other/lib#1']],
      ['charlie', []],
    ]);
    const text = formatFollows(follows);
    assert.equal(text, `{"v":${FOLLOWS_FORMAT},"follows":{"alpha":["gh:acme/web#3","gh:other/lib#1"],"bravo":["gh:acme/web#7"]}}\n`);
    assert.deepEqual(parseFollows(text), new Map([
      ['alpha', ['gh:acme/web#3', 'gh:other/lib#1']],
      ['bravo', ['gh:acme/web#7']],
    ]));
  });

  it('leaves out what names no item, a repeat and a session left with nothing', () => {
    const text = JSON.stringify({ v: FOLLOWS_FORMAT, follows: { alpha: ['gh:Acme/Web#3', 'acme/web#3', 'nonsense', 7], bravo: 'gh:acme/web#1', charlie: [] } });
    assert.deepEqual(parseFollows(text), new Map([['alpha', ['gh:acme/web#3']]]));
  });

  it('reads a missing, damaged or other-format file as following nothing', () => {
    for (const text of ['', '{', JSON.stringify({ v: FOLLOWS_FORMAT + 1, follows: { alpha: ['gh:acme/web#3'] } }), JSON.stringify({ v: FOLLOWS_FORMAT, follows: [] })]) {
      assert.deepEqual(parseFollows(text), new Map(), text);
    }
  });
});

describe('addFollow and dropFollow', () => {
  const follows = new Map([['alpha', ['gh:acme/web#3']]]);

  it('adds a follow after the others of the session, leaving the input as it was', () => {
    const change = addFollow(follows, 'alpha', 'gh:acme/web#4', 2);
    assert.deepEqual(change, { kind: 'followed', follows: new Map([['alpha', ['gh:acme/web#3', 'gh:acme/web#4']]]) });
    assert.deepEqual(addFollow(follows, 'bravo', 'gh:acme/web#3', 1), { kind: 'followed', follows: new Map([...follows, ['bravo', ['gh:acme/web#3']]]) });
    assert.deepEqual(follows, new Map([['alpha', ['gh:acme/web#3']]]));
  });

  it('refuses a repeat, and a follow past the most a session follows', () => {
    assert.deepEqual(addFollow(follows, 'alpha', 'gh:acme/web#3', 2), { kind: 'already' });
    assert.deepEqual(addFollow(follows, 'alpha', 'gh:acme/web#4', 1), { kind: 'full', max: 1 });
    assert.deepEqual(addFollow(follows, 'bravo', 'gh:acme/web#4', 0), { kind: 'full', max: 0 });
  });

  it('drops a follow, and drops nothing the session does not follow', () => {
    assert.deepEqual(dropFollow(follows, 'alpha', 'gh:acme/web#3'), new Map([['alpha', []]]));
    assert.equal(dropFollow(follows, 'alpha', 'gh:acme/web#4'), undefined);
    assert.equal(dropFollow(follows, 'bravo', 'gh:acme/web#3'), undefined);
  });
});

describe('followersOf', () => {
  it('lists the followers of each ref in session order', () => {
    const follows = new Map([
      ['bravo', ['gh:acme/web#3']],
      ['alpha', ['gh:acme/web#3', 'gh:acme/web#9']],
    ]);
    assert.deepEqual(followersOf(follows), new Map([
      ['gh:acme/web#3', ['alpha', 'bravo']],
      ['gh:acme/web#9', ['alpha']],
    ]));
  });
});
