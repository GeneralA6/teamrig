import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWords, splitLine, wordOfUnits, type CRuntime, type LineUnit } from './native-line.ts';
import type { ShellWord } from './tokenizer.ts';

const text = (value: string): ShellWord => ({ text: value, dynamic: false });
const dynamic = (value: string): ShellWord => ({ text: value, dynamic: true });

/** The texts a program gets for plain values. */
function reached(values: readonly string[], runtime: CRuntime = 'ucrt'): string[] {
  return nativeWords(values.map((value) => [text(value)]), [], runtime).map((word) => word.text);
}

/** The texts a runtime splits a line into. */
function split(line: string, runtime: CRuntime): string[] {
  return splitLine([...line], runtime).map((units) => wordOfUnits(units).text);
}

describe('nativeWords: what Windows PowerShell 5.1 hands a native program', () => {
  it('leaves a plain value and a value with a blank as they are', () => {
    assert.deepEqual(reached(['commit', '-m', 'a b', 'tail']), ['commit', '-m', 'a b', 'tail']);
  });

  it('drops an empty value, so the next one takes its place', () => {
    assert.deepEqual(reached(['-m', '', '--no-verify']), ['-m', '--no-verify']);
  });

  it('adds no quotes to a value whose blank sits after an odd count of quotes', () => {
    assert.deepEqual(reached(['a"b c"d', 'e']), ['ab cd', 'e']);
    assert.deepEqual(reached(['a\\" b', 'c']), ['a"', 'b', 'c']);
  });

  it('adds quotes to a value with a blank before its first quote', () => {
    assert.deepEqual(reached(['a b"c', 'd']), ['a bc d']);
  });

  it('lets a lone quote swallow the words after it', () => {
    assert.deepEqual(reached(['a"', '--verify']), ['a --verify']);
  });

  it('reads a value ending in a backslash as a quote, so the next word joins it', () => {
    assert.deepEqual(reached(['a b\\', 'c']), ['a b" c']);
    assert.deepEqual(reached(['a b\\\\', 'c']), ['a b\\', 'c']);
  });

  it('lets one value come apart into an option', () => {
    assert.deepEqual(reached(['a\\" --no-verify']), ['a"', '--no-verify']);
  });

  it('quotes on .NET white space but splits only on a space or a tab', () => {
    assert.deepEqual(reached(['a\u00a0b', 'c']), ['a\u00a0b', 'c']);
    assert.deepEqual(reached(['a\u00a0"', 'c']), ['a\u00a0" c']);
    assert.deepEqual(reached(['a\u200b"', 'c']), ['a\u200b c']);
  });

  it('joins an array of no blanks by a comma, each element quoted alone', () => {
    const words = nativeWords([[text('a b'), text('c')], [text('d')]], [], 'ucrt');
    assert.deepEqual(words, [text('a b,c'), text('d')]);
  });

  it('leaves out an empty element and its comma', () => {
    assert.deepEqual(nativeWords([[text(''), text('b')], [text('c')]], [], 'ucrt'), [text('b'), text('c')]);
    assert.deepEqual(nativeWords([[text('b'), text('')], [text('c')]], [], 'ucrt'), [text('b'), text('c')]);
    assert.deepEqual(nativeWords([[text(''), text('')], [text('c')]], [], 'ucrt'), [text('c')]);
  });

  it('keeps a dynamic value whole, its quotes unread', () => {
    assert.deepEqual(nativeWords([[dynamic('$(echo "a b")')], [text('c')]], [], 'ucrt'), [dynamic('$(echo "a b")'), text('c')]);
  });

  it('marks a word dynamic when a quote swallows a dynamic value', () => {
    assert.deepEqual(nativeWords([[text('a"')], [dynamic('$v')], [text('c')]], [], 'ucrt'), [dynamic('a $v c')]);
  });

  it('joins a dynamic element by the comma', () => {
    assert.deepEqual(nativeWords([[dynamic('$v.Length'), text('b')], [text('c')]], [], 'ucrt'), [dynamic('$v.Length,b'), text('c')]);
  });

  it('reads the text after a --% with the words before it', () => {
    assert.deepEqual(nativeWords([[text('a"')]], [...' " --no-verify'], 'ucrt'), [text('a '), text('--no-verify')]);
  });
});

describe('splitLine: the C runtimes on a real line', () => {
  it('keeps backslashes before anything but a quote', () => {
    assert.deepEqual(split('a\\b\\\\ c', 'ucrt'), ['a\\b\\\\', 'c']);
  });

  it('halves backslashes before a quote, an odd one making the quote plain', () => {
    assert.deepEqual(split('a\\\\"b c"', 'ucrt'), ['a\\b c']);
    assert.deepEqual(split('a\\"b c', 'ucrt'), ['a"b', 'c']);
    assert.deepEqual(split('a\\\\\\"b c', 'ucrt'), ['a\\"b', 'c']);
  });

  it('gives an empty word for an empty pair of quotes', () => {
    assert.deepEqual(split('"" a', 'ucrt'), ['', 'a']);
  });

  it('runs to the end of the line in quotes that never close', () => {
    assert.deepEqual(split('a "b c', 'msvcrt'), ['a', 'b c']);
  });

  it('skips the blanks around the words', () => {
    assert.deepEqual(split(' \ta  b\t', 'ucrt'), ['a', 'b']);
    assert.deepEqual(split('   ', 'ucrt'), []);
  });

  it('stays in the quotes after a doubled quote under ucrt, leaves them under msvcrt', () => {
    assert.deepEqual(split('" "" tail', 'ucrt'), [' " tail']);
    assert.deepEqual(split('" "" tail', 'msvcrt'), [' "', 'tail']);
  });

  it('reads a doubled quote outside quotes alike under both', () => {
    assert.deepEqual(split('a""b c', 'ucrt'), ['ab', 'c']);
    assert.deepEqual(split('a""b c', 'msvcrt'), ['ab', 'c']);
  });

  it('takes no blank or quote from inside a piece', () => {
    const line: readonly LineUnit[] = ['a', { text: ' " ', dynamic: true }, ' ', 'b'];
    assert.deepEqual(splitLine(line, 'ucrt').map(wordOfUnits), [dynamic('a " '), text('b')]);
  });
});
