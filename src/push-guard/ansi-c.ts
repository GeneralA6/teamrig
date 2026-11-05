/**
 * The value of bash's `$'...'` quoting, worked out on UTF-8 bytes as bash's `ansicstr` does, so a guard judges the word
 * the program gets (T1994). Bash keeps the value as a C string: a NUL, however it is written, ends it, and the word
 * carries on after the closing quote. The word's text stays exact rather than dynamic, since a guard skips a dynamic
 * word as an option: only a byte that is not valid UTF-8 differs, and no guard reads one.
 */

const BACKSLASH = 0x5c;
const DELETE = 0x7f;
const NUL = 0;
/** What a control escape keeps of its character, and what an octal or hex escape keeps of its value. */
const CONTROL_BITS = 0x1f;
const BYTE_BITS = 0xff;
/** Bash adds these digits up in 32 bits; the wrap keeps a long `\x{...}` run exact here too. */
const WORD_SIZE = 2 ** 32;
const LAST_CODE_POINT = 0x10ffff;
/** The highest value bash's UTF-8 writer encodes; past it, it writes nothing and reading goes on. */
const LAST_ENCODED = 0x7fffffff;
const SURROGATES = { first: 0xd800, last: 0xdfff };
/** Stands in for what bash writes for a surrogate or a value past Unicode: non-ASCII bytes a string cannot hold. */
const REPLACEMENT = '�';

/** The escapes that are one byte. Any other letter but a numeric or control escape keeps its backslash. */
const ESCAPES: ReadonlyMap<string, number> = new Map([
  ['a', 0x07],
  ['b', 0x08],
  ['e', 0x1b],
  ['E', 0x1b],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['v', 0x0b],
  ['\\', BACKSLASH],
  ["'", 0x27],
  ['"', 0x22],
  ['?', 0x3f],
]);

/** The UTF-8 bytes of a `\u` or `\U` value. */
function utf8Of(code: number): readonly number[] {
  if (code > LAST_ENCODED) {
    return [];
  }
  const scalar = code <= LAST_CODE_POINT && (code < SURROGATES.first || code > SURROGATES.last);
  return [...Buffer.from(scalar ? String.fromCodePoint(code) : REPLACEMENT, 'utf8')];
}

/** One pass over the bytes between the quotes. */
class AnsiCBody {
  private index = 0;
  private readonly value: number[] = [];
  private readonly bytes: Buffer;

  constructor(body: string) {
    this.bytes = Buffer.from(body, 'utf8');
  }

  read(): string {
    while (this.index < this.bytes.length) {
      if (this.letter() === '\\' && this.index + 1 < this.bytes.length) {
        this.index += 1;
        this.readEscape();
      } else {
        this.value.push(this.letter().charCodeAt(0));
        this.index += 1;
      }
    }
    const end = this.value.indexOf(NUL);
    return Buffer.from(end === -1 ? this.value : this.value.slice(0, end)).toString('utf8');
  }

  /** The byte at the index as one character, or an empty string past the end. */
  private letter(): string {
    const byte = this.bytes[this.index];
    return byte === undefined ? '' : String.fromCharCode(byte);
  }

  /** At the letter after a backslash. */
  private readEscape(): void {
    const letter = this.letter();
    if (/[0-7]/.test(letter)) {
      this.value.push(this.digits(8, 3).value & BYTE_BITS);
      return;
    }
    this.index += 1;
    const simple = ESCAPES.get(letter);
    if (simple !== undefined) {
      this.value.push(simple);
    } else if (letter === 'x') {
      this.readHex();
    } else if (letter === 'u' || letter === 'U') {
      this.readUnicode(letter);
    } else if (letter === 'c' && this.index < this.bytes.length) {
      this.readControl();
    } else {
      this.keep(letter);
    }
  }

  /** `\xHH`, or `\x{H...}`, which takes every hex digit, none at all giving a NUL, and an optional closing brace. */
  private readHex(): void {
    if (this.letter() === '{') {
      this.index += 1;
      this.value.push(this.digits(16, Number.POSITIVE_INFINITY).value & BYTE_BITS);
      this.index += this.letter() === '}' ? 1 : 0;
      return;
    }
    const { value, count } = this.digits(16, 2);
    if (count === 0) {
      this.keep('x');
    } else {
      this.value.push(value);
    }
  }

  private readUnicode(letter: 'u' | 'U'): void {
    const { value, count } = this.digits(16, letter === 'u' ? 4 : 8);
    if (count === 0) {
      this.keep(letter);
    } else {
      this.value.push(...utf8Of(value));
    }
  }

  /** `\cX`, on the byte after it, so a character whose first byte is 0xE0 gives a NUL; `\c\\` takes both backslashes. */
  private readControl(): void {
    const letter = this.letter();
    this.index += 1;
    if (letter === '\\' && this.letter() === '\\') {
      this.index += 1;
    }
    this.value.push(letter === '?' ? DELETE : letter.charCodeAt(0) & CONTROL_BITS);
  }

  /** An escape bash has no meaning for stays as written, its backslash included. */
  private keep(letter: string): void {
    this.value.push(BACKSLASH, letter.charCodeAt(0));
  }

  /** Up to `most` digits of `radix` at the index: their value and how many there were. */
  private digits(radix: number, most: number): { readonly value: number; readonly count: number } {
    let value = 0;
    let count = 0;
    let digit = parseInt(this.letter(), radix);
    while (count < most && !Number.isNaN(digit)) {
      value = (value * radix + digit) % WORD_SIZE;
      count += 1;
      this.index += 1;
      digit = parseInt(this.letter(), radix);
    }
    return { value, count };
  }
}

/** The value of a `$'...'` string, given the text between its quotes as written. */
export function ansiCValue(body: string): string {
  return new AnsiCBody(body).read();
}
