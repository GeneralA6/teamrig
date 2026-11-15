import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVATE_SHAPES, privateShapeIn } from './private-shapes.ts';

// Fixtures are assembled at runtime so this file never holds a literal the scrub would flag.
const join = (...parts: string[]): string => parts.join('');
const BACKSLASH = '\\';
const idIn = (text: string): string | undefined => privateShapeIn(text)?.id;

describe('privateShapeIn', () => {
  it('finds a path inside a user home on Windows, macOS and Linux', () => {
    assert.equal(idIn(join('see C:', BACKSLASH, 'Users', BACKSLASH, 'dana', BACKSLASH, 'repo')), 'home-path');
    assert.equal(idIn(join('see /', 'Users/dana/repo')), 'home-path');
    assert.equal(idIn(join('see /', 'home/dana/repo')), 'home-path');
  });

  it('finds an e-mail address, an IPv4 address and an internal host', () => {
    assert.equal(idIn(join('write to dana', '@', 'acme.io')), 'email');
    assert.equal(idIn(['10', '1', '2', '3'].join('.')), 'ipv4');
    assert.equal(idIn(join('on db.', 'internal')), 'internal-host');
  });

  it('lets through placeholders, documentation addresses, mentions and versions', () => {
    const text = [
      join('/', 'home/user/x'),
      '~/repo',
      join('a', '@', 'example.com'),
      join('noreply', '@', 'github.com'),
      '@dana thanks',
      join('typescript', '@', '5.9.3'),
      ['127', '0', '0', '1'].join('.'),
      'Merged as #624 (plugin 0.353.2).',
    ].join(' ');
    assert.equal(privateShapeIn(text), undefined);
  });

  it('reports the first shape in list order, and reads past an allowed match', () => {
    assert.equal(idIn(join('dana', '@', 'acme.io on /', 'home/dana')), 'home-path');
    assert.equal(idIn(join('/', 'home/user/x then /', 'home/dana/y')), 'home-path');
  });

  it('gives each shape a global pattern and a distinct id', () => {
    assert.ok(PRIVATE_SHAPES.every(({ pattern }) => pattern.global));
    assert.equal(new Set(PRIVATE_SHAPES.map(({ id }) => id)).size, PRIVATE_SHAPES.length);
  });

  it('fails closed on a match without its captured part', () => {
    const bare = /x/.exec('x');
    assert.ok(bare !== null);
    for (const id of ['home-path', 'email']) {
      const isAllowed = PRIVATE_SHAPES.find((shape) => shape.id === id)?.isAllowed;
      assert.ok(isAllowed !== undefined, id);
      assert.equal(isAllowed(bare), false, id);
    }
  });
});
