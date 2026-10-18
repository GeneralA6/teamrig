import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prefixWords, startsWithPrefix, type PrefixWord } from './rules.ts';

const fixed = (text: string): PrefixWord => ({ text, dynamic: false });
const command = (...texts: string[]): PrefixWord[] => texts.map(fixed);

describe('prefixWords', () => {
  it('splits a configured prefix into its words', () => {
    assert.deepEqual(prefixWords('npx tsc --noEmit'), ['npx', 'tsc', '--noEmit']);
    assert.deepEqual(prefixWords('make'), ['make']);
  });
});

describe('startsWithPrefix', () => {
  const prefixes = [prefixWords('npx tsc --noEmit'), prefixWords('npx jest')];

  it('matches a command whose first words are a prefix, whatever follows', () => {
    assert.equal(startsWithPrefix(command('npx', 'tsc', '--noEmit'), prefixes), true);
    assert.equal(startsWithPrefix(command('npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'), prefixes), true);
    assert.equal(startsWithPrefix(command('npx', 'jest', 'src/a.spec.ts'), prefixes), true);
  });

  it('refuses a command shorter than the prefix or differing in a word', () => {
    assert.equal(startsWithPrefix(command('npx', 'tsc'), prefixes), false);
    assert.equal(startsWithPrefix(command('npx', 'tsc', '-p', 'tsconfig.json'), prefixes), false);
    assert.equal(startsWithPrefix(command('npx', '-p', 'evil', 'jest'), prefixes), false);
  });

  it('refuses a prefix word that a variable decides', () => {
    assert.equal(startsWithPrefix([fixed('npx'), { text: '$tool', dynamic: true }], prefixes), false);
  });

  it('matches nothing when the team trusts no prefix', () => {
    assert.equal(startsWithPrefix(command('npx', 'jest'), []), false);
  });
});
