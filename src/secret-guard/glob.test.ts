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
});
