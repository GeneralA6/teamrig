/** What `/teamrig` was given, as the words a terminal would pass the CLI, or why it cannot be read. */
export type Words = { readonly ok: true; readonly words: readonly string[] } | { readonly ok: false; readonly problem: string };

type Quote = '"' | "'";

/**
 * Splits the text typed after `/teamrig` into words the way a shell would, so a line copied from a
 * terminal means the same in a tab: blanks separate words; `"..."` keeps blanks, and inside it `\"` is a
 * quote and `\\` a backslash; `'...'` keeps everything as typed. A quote joins with the text it touches
 * (`--text="a b"` is one word). A backslash outside quotes is kept as typed, so a Windows path needs no
 * doubling. A quote left open is refused, never guessed at.
 */
export function splitWords(text: string): Words {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: Quote | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        word += char;
      }
    } else if (quote === '"') {
      const next = text.charAt(index + 1);
      if (char === '\\' && (next === '"' || next === '\\')) {
        word += next;
        index += 1;
      } else if (char === '"') {
        quote = undefined;
      } else {
        word += char;
      }
    } else if (/\s/.test(char)) {
      if (inWord) {
        words.push(word);
        word = '';
        inWord = false;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== undefined) {
    return { ok: false, problem: `a ${quote === '"' ? 'double' : 'single'} quote is never closed` };
  }
  if (inWord) {
    words.push(word);
  }
  return { ok: true, words };
}

/** A word that reads back as itself unquoted: not empty, and no blank or quote in it. */
const PLAIN_WORD = /^[^\s"']+$/;

/**
 * The words as one line that `splitWords` reads back into the same words, for showing a person the exact
 * command before it runs: a plain word as it is, any other in double quotes, its `"` and `\` escaped.
 */
export function joinWords(words: readonly string[]): string {
  return words.map((word) => (PLAIN_WORD.test(word) ? word : `"${word.replace(/["\\]/g, (char) => `\\${char}`)}"`)).join(' ');
}
