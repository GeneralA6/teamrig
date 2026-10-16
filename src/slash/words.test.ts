import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinWords, splitWords } from './words.ts';

/** The words of a line that must split cleanly. */
function wordsOf(text: string): readonly string[] {
  const split = splitWords(text);
  assert.ok(split.ok, `expected "${text}" to split`);
  return split.words;
}

describe('splitWords', () => {
  it('splits on any run of blanks and ignores blanks at either end', () => {
    assert.deepEqual(wordsOf('  inbox \t status   --session  alpha \n'), ['inbox', 'status', '--session', 'alpha']);
  });

  it('gives no words for an empty or blank line', () => {
    assert.deepEqual(wordsOf(''), []);
    assert.deepEqual(wordsOf('   '), []);
  });

  it('keeps blanks inside double or single quotes', () => {
    assert.deepEqual(wordsOf('inbox add --text "two words" --to \'b c\''), ['inbox', 'add', '--text', 'two words', '--to', 'b c']);
  });

  it('joins a quote with the text it touches', () => {
    assert.deepEqual(wordsOf('--text="a b"c \'d\'"e"'), ['--text=a bc', 'de']);
  });

  it('reads \\" and \\\\ inside double quotes and keeps any other backslash', () => {
    assert.deepEqual(wordsOf('"say \\"hi\\" \\\\ \\n"'), ['say "hi" \\ \\n']);
  });

  it('keeps everything inside single quotes as typed, backslashes and double quotes included', () => {
    assert.deepEqual(wordsOf('\'a \\" "b"\''), ['a \\" "b"']);
  });

  it('keeps a backslash outside quotes, so a Windows path needs no doubling', () => {
    assert.deepEqual(wordsOf('C:\\Users\\me\\x'), ['C:\\Users\\me\\x']);
  });

  it('gives an empty word for empty quotes', () => {
    assert.deepEqual(wordsOf('set --note "" \'\''), ['set', '--note', '', '']);
  });

  it('refuses a double or single quote that is never closed', () => {
    assert.deepEqual(splitWords('add --text "open'), { ok: false, problem: 'a double quote is never closed' });
    assert.deepEqual(splitWords("add --text 'open"), { ok: false, problem: 'a single quote is never closed' });
  });
});

describe('joinWords', () => {
  it('keeps plain words as they are, a Windows path included', () => {
    assert.equal(joinWords(['set', 'T5', '--note', 'C:\\x\\y']), 'set T5 --note C:\\x\\y');
  });

  it('quotes a word with a blank or a quote in it, or an empty one, escaping " and \\', () => {
    assert.equal(joinWords(['--text', 'two words', "it's", '', 'say "hi" \\']), '--text "two words" "it\'s" "" "say \\"hi\\" \\\\"');
  });

  it('gives a line that splits back into the same words', () => {
    const words = ['inbox', 'add', '--text', 'a "b" \\c\\ \'d\'', '', 'e\tf', 'C:\\p'];
    assert.deepEqual(wordsOf(joinWords(words)), words);
  });
});
