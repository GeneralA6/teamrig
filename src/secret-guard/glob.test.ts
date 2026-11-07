import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globRegExp, hasWildcard } from './glob.ts';

const ANY = { ignoreCase: false, dotfiles: true };
const BASH = { ignoreCase: false, dotfiles: false };

describe('globRegExp', () => {
  it('spans folders with **, none too, and keeps * and ? inside one name', () => {
    const env = globRegExp('**/.env', ANY);
    assert.equal(env.test('/a/b/.env'), true);
    assert.equal(env.test('.env'), true);
    assert.equal(env.test('/a/.env.bak'), false);
    const pem = globRegExp('/a/*.pem', ANY);
    assert.equal(pem.test('/a/k.pem'), true);
    assert.equal(pem.test('/a/b/k.pem'), false);
    assert.equal(globRegExp('/a/?.key', ANY).test('/a/kk.key'), false);
  });

  it('takes a folder and all inside it for a trailing /**, and ** between names', () => {
    const tree = globRegExp('/h/.ssh/**', ANY);
    assert.deepEqual(['/h/.ssh', '/h/.ssh/id_rsa', '/h/.ssh/a/b', '/h/.sshx'].map((path) => tree.test(path)), [true, true, true, false]);
    assert.equal(globRegExp('/a/**/s.yaml', ANY).test('/a/s.yaml'), true);
    assert.equal(globRegExp('/a/**/s.yaml', ANY).test('/a/x/y/s.yaml'), true);
  });

  it('reads a [...] set, negated with ! or ^, and keeps every other character literal', () => {
    assert.equal(globRegExp('/a/[ab].txt', ANY).test('/a/b.txt'), true);
    assert.equal(globRegExp('/a/[!ab].txt', ANY).test('/a/b.txt'), false);
    assert.equal(globRegExp('/a/[^ab].txt', ANY).test('/a/c.txt'), true);
    assert.equal(globRegExp('/a/(x)+.txt', ANY).test('/a/(x)+.txt'), true);
    assert.equal(globRegExp('/a/[x', ANY).test('/a/[x'), true);
  });

  it('reads a reversed range as bash does: it fits nothing, the members around it still fit (T1960)', () => {
    const line = globRegExp('/a/near[near.length-1]', ANY);
    assert.deepEqual(['/a/neare', '/a/nearh', '/a/near1'].map((path) => line.test(path)), [true, false, false]);
    const hidden = globRegExp('/a/.en[z-av]', ANY);
    assert.deepEqual(['/a/.env', '/a/.enw'].map((path) => hidden.test(path)), [true, false]);
    assert.equal(globRegExp('/a/[!z-a]env', ANY).test('/a/benv'), true);
    assert.equal(globRegExp('/a/[^z-ab]env', ANY).test('/a/benv'), false);
  });

  it('never lets a dropped range join the members beside it into a new range (T1960)', () => {
    const set = globRegExp('/a/[bz-a-d]env', ANY);
    assert.deepEqual(['b', '-', 'd', 'c'].map((name) => set.test(`/a/${name}env`)), [true, true, true, false]);
  });

  it('never lets a dropped range turn a ^ behind it into a negation (T1960)', () => {
    const set = globRegExp('/a/[z-a^b]env', ANY);
    assert.deepEqual(['^', 'b', 'c'].map((name) => set.test(`/a/${name}env`)), [true, true, false]);
  });

  it('reads a range, one of a single character, a - at either end and a leading ] (T1960)', () => {
    const fits = (glob: string, names: readonly string[]): readonly boolean[] => names.map((name) => globRegExp(`/a/${glob}env`, ANY).test(`/a/${name}env`));
    assert.deepEqual(fits('[a-c]', ['a', 'b', 'c', 'd', '-']), [true, true, true, false, false]);
    assert.deepEqual(fits('[a-a]', ['a', 'b']), [true, false]);
    assert.deepEqual(fits('[a-]', ['a', '-', 'b']), [true, true, false]);
    assert.deepEqual(fits('[-a]', ['a', '-', 'b']), [true, true, false]);
    assert.deepEqual(fits('[]b]', [']', 'b', 'c']), [true, true, false]);
  });

  it('keeps a set inside one name: a negated one fits no slash, and a slash ends it (T1960)', () => {
    assert.equal(globRegExp('/a/x[!b]y', ANY).test('/a/x/y'), false);
    const slashed = globRegExp('/a/[b/c]', ANY);
    assert.deepEqual(['/a/[b/c]', '/a/b'].map((path) => slashed.test(path)), [true, false]);
  });

  it('keeps a set no character fits as literal text (T1960)', () => {
    const empty = globRegExp('/a/[z-a]env', ANY);
    assert.deepEqual(['/a/[z-a]env', '/a/benv'].map((path) => empty.test(path)), [true, false]);
  });

  it('compiles a range of any two printable characters, in either order (T1960)', () => {
    const printable = Array.from({ length: 95 }, (_, code) => String.fromCharCode(code + 32));
    for (const first of printable) {
      for (const last of printable) {
        assert.doesNotThrow(() => globRegExp(`/a/[${first}-${last}]`, ANY), `[${first}-${last}]`);
      }
    }
  });

  it('never matches a leading dot with a bash wildcard', () => {
    assert.equal(globRegExp('/a/*', BASH).test('/a/.env'), false);
    assert.equal(globRegExp('/a/.env*', BASH).test('/a/.env'), true);
    assert.equal(globRegExp('/a/?env', BASH).test('/a/.env'), false);
    assert.equal(globRegExp('/a/*', ANY).test('/a/.env'), true);
  });

  it('ignores case when told', () => {
    assert.equal(globRegExp('C:/Users/*/.npmrc', { ignoreCase: true, dotfiles: true }).test('c:/users/u/.NPMRC'), true);
    assert.equal(globRegExp('/a/.npmrc', ANY).test('/a/.NPMRC'), false);
  });
});

describe('hasWildcard', () => {
  it('finds *, ? and a [...] set, not a lone bracket', () => {
    assert.deepEqual(['.env*', 'a?b', 'x[12]', 'a[', 'plain/.env'].map(hasWildcard), [true, true, true, false, false]);
  });

  it('finds none in a word with a set no character fits, as bash keeps that word as typed (T1960)', () => {
    assert.deepEqual(['[z-a]', '.env[z-a]', '[z-a]*', 'a?[z-a]', '[z-a][12]'].map(hasWildcard), [false, false, false, false, false]);
  });

  it('finds a set that keeps a member beside a reversed range, or is negated (T1960)', () => {
    assert.deepEqual(['[z-av]', '[!z-a]', '[^z-a]'].map(hasWildcard), [true, true, true]);
  });
});
