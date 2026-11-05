import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bareLine, expandedUnits, nativeWords, PARSER_MARKER, splitLine, verbatimLine, wordOfUnits, type CRuntime, type LineUnit } from './native-line.ts';
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

  it('ends the line at a NUL, in a value, in the verbatim text or inside a piece', () => {
    assert.deepEqual(nativeWords([[text('a\0b')], [text('c')]], [], 'ucrt'), [text('a')]);
    assert.deepEqual(nativeWords([[text('a')]], [...' b\0 c'], 'ucrt'), [text('a'), text('b')]);
    assert.deepEqual(nativeWords([[text('a')]], [' ', { text: '%b\0c%' }, ' ', 'd'], 'ucrt'), [text('a'), dynamic('%b')]);
  });
});

describe('verbatimLine: what a --% adds to the line', () => {
  it('is two blanks, then the text with its leading spaces cut and its trailing ones kept', () => {
    assert.deepEqual(verbatimLine([...'   a b  ']), [...'  a b  ']);
  });

  it('is two blanks for no text or spaces alone', () => {
    assert.deepEqual(verbatimLine([]), [...'  ']);
    assert.deepEqual(verbatimLine([...'   ']), [...'  ']);
  });

  it('keeps a piece at the start of the text', () => {
    assert.deepEqual(verbatimLine([' ', { text: '%A%' }]), [' ', ' ', { text: '%A%' }]);
  });
});

describe('expandedUnits: the text 5.1 expands', () => {
  it('makes each %NAME% a piece, the text around it characters', () => {
    assert.deepEqual(expandedUnits('q%W%r'), ['q', { text: '%W%' }, 'r']);
    assert.deepEqual(expandedUnits('%W%%W%'), [{ text: '%W%' }, { text: '%W%' }]);
  });

  it('takes a name from the last percent that can open it', () => {
    assert.deepEqual(expandedUnits('%%W%'), ['%', { text: '%W%' }]);
    assert.deepEqual(expandedUnits('%W%%'), [{ text: '%W%' }, '%']);
  });

  it('leaves every form only cmd reads as text', () => {
    ['%%', '%1', '%*', '%~dp0', '!W!', '%W', 'W%'].forEach((value) => assert.deepEqual(expandedUnits(value), [...value]));
  });

  it('takes no name holding a blank or a quote, so a word inside it stays a word', () => {
    ['%a b%', '%a\tb%', '%a"b%'].forEach((value) => assert.deepEqual(expandedUnits(value), [...value]));
  });
});

describe("bareLine: what arguments add behind the binder's --%", () => {
  it('writes each value behind one blank, with no quotes, so it comes apart on the line', () => {
    assert.deepEqual(bareLine([[text('a b')], [text('c')]]), [...' a b c']);
    assert.deepEqual(nativeWords([], bareLine([[text('a b')], [text('c')]]), 'ucrt'), [text('a'), text('b'), text('c')]);
  });

  it('keeps the blank of an empty value', () => {
    assert.deepEqual(bareLine([[text('')], [text('a')]]), [...'  a']);
  });

  it('joins an array by the comma, leaving out an empty element', () => {
    assert.deepEqual(bareLine([[text('a b'), text(''), text('c d')]]), [...' a b,c d']);
  });

  it('keeps a dynamic value a piece', () => {
    assert.deepEqual(bareLine([[dynamic('$v')], [text('c')]]), [' ', { text: '$v' }, ' ', 'c']);
  });

  it('keeps a %NAME% a piece, as its value decides how many words it is', () => {
    assert.deepEqual(bareLine([[text('q%W%r')], [text('c')]]), [' ', 'q', { text: '%W%' }, 'r', ' ', 'c']);
    assert.deepEqual(nativeWords([], bareLine([[text('%W%')], [text('c')]]), 'ucrt'), [dynamic('%W%'), text('c')]);
  });

  it('leaves a %NAME% text ahead of the marker, where the binder expands nothing', () => {
    assert.deepEqual(nativeWords([[text('%W%')]], [], 'ucrt'), [text('%W%')]);
  });

  it('reads on through a quote the words before it opened', () => {
    const written = bareLine([[text('')], [text('')], [text('b c')]]);
    assert.deepEqual(nativeWords([[text('a"')]], written, 'ucrt'), [text('a   b c')]);
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

  it('keeps the parser marker a word between words, and ends the word before it', () => {
    const line: readonly LineUnit[] = [...' a', PARSER_MARKER, ...'  b'];
    assert.deepEqual(splitLine(line, 'ucrt').map(wordOfUnits), [text('a'), text('--%'), text('b')]);
    assert.deepEqual(splitLine([PARSER_MARKER, ...'  '], 'ucrt').map(wordOfUnits), [text('--%')]);
  });

  it('drops the parser marker inside quotes, which go on past it', () => {
    const line: readonly LineUnit[] = [...' "a b', PARSER_MARKER, ...'  c" d'];
    assert.deepEqual(splitLine(line, 'ucrt').map(wordOfUnits), [text('a b  c'), text('d')]);
  });

  it('takes no blank or quote from inside a piece', () => {
    const line: readonly LineUnit[] = ['a', { text: ' " ' }, ' ', 'b'];
    assert.deepEqual(splitLine(line, 'ucrt').map(wordOfUnits), [dynamic('a " '), text('b')]);
  });
});
