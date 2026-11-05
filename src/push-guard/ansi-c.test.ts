import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ansiCValue } from './ansi-c.ts';

/** The text between the quotes, and the value it has. */
type Row = readonly [body: string, value: string];

function expectValues(rows: readonly Row[]): void {
  for (const [body, value] of rows) {
    assert.equal(ansiCValue(body), value, body);
  }
}

/**
 * Every row is what real bash 5.2 made of `f A$'<body>'B` under LC_ALL=C.UTF-8, read back from the argv it built
 * (T1994), so none of these values is a reading of bash's rules. A C locale writes a non-Latin `\u` as ASCII text, still
 * nothing a guard reads.
 */
describe('ansiCValue', () => {
  it('ends the value at a NUL, however it is written, and drops what follows it', () => {
    expectValues([
      ['\\0', ''],
      ['\\00', ''],
      ['\\000', ''],
      ['\\0000', ''],
      ['\\400', ''],
      ['\\x0', ''],
      ['\\x00', ''],
      ['\\x{}', ''],
      ['\\x{0}', ''],
      ['\\x{00}', ''],
      ['\\x{100}', ''],
      ['\\x{g}', ''],
      ['\\u0', ''],
      ['\\u00', ''],
      ['\\u000', ''],
      ['\\u0000', ''],
      ['\\U0', ''],
      ['\\U00000000', ''],
      ['\\U80000000', ''],
      ['\\UFFFFFFFF', ''],
      ['\\c@', ''],
      ['\\c ', ''],
      ['\\c`', ''],
      ['a\\0b', 'a'],
      ['\\0\\0', ''],
      ['\\0\\\'x', ''],
      ['a\\x00b', 'a'],
      ['a\\c@b', 'a'],
      ['ab\\0', 'ab'],
      ['\\c@\\c@', ''],
      ['\\0\\n', ''],
      ['\\0\\q', ''],
      ['a\\400b', 'a'],
      ['\\c\u{800}x', ''],
      ['\\x{', ''],
      ['\\x{}x', ''],
      ['\\x{0}x', ''],
      ['\\c@x', ''],
      ['\\c x', ''],
    ]);
  });

  it('reads up to three octal digits and keeps the low byte', () => {
    expectValues([
      ['\\01', '\x01'],
      ['\\1', '\x01'],
      ['\\12', '\n'],
      ['\\123', 'S'],
      ['\\1234', 'S4'],
      ['\\7', '\x07'],
      ['\\8', '\\8'],
      ['\\9', '\\9'],
      ['\\18', '\x018'],
      ['\\455', '-'],
      ['\\560', 'p'],
      ['\\100', '@'],
    ]);
  });

  it('reads \\xHH, and \\x{...} with every hex digit in it, keeping the low byte', () => {
    expectValues([
      ['\\x', '\\x'],
      ['\\xg', '\\xg'],
      ['\\x41', 'A'],
      ['\\x414', 'A4'],
      ['\\x7f', '\x7f'],
      ['\\x{41}', 'A'],
      ['\\x{2d}', '-'],
      ['\\x{12d}', '-'],
      ['\\x{41', 'A'],
      ['\\x{41g}', 'Ag}'],
      ['\\x{0041}', 'A'],
      ['\\xc3\\xa9', '\u{e9}'],
      ['\\xef\\xbb\\xbf-', '\u{feff}-'],
    ]);
  });

  it('writes \\u and \\U as UTF-8, and nothing past 0x7fffffff', () => {
    expectValues([
      ['\\u', '\\u'],
      ['\\ug', '\\ug'],
      ['\\u2d', '-'],
      ['\\u002d', '-'],
      ['\\u002dA', '-A'],
      ['\\u7f', '\x7f'],
      ['\\u80', '\u{80}'],
      ['\\u00e9', '\u{e9}'],
      ['\\u20ac', '\u{20ac}'],
      ['\\uFFFF', '\u{ffff}'],
      ['\\u{2d}', '\\u{2d}'],
      ['\\U', '\\U'],
      ['\\Ug', '\\Ug'],
      ['\\U2d', '-'],
      ['\\U0000002d', '-'],
      ['\\U0000002dA', '-A'],
      ['\\U000000e9', '\u{e9}'],
      ['\\U0001F600', '\u{1f600}'],
      ['\\U0010FFFF', '\u{10ffff}'],
      ['\\U80000000x', 'x'],
      ['\\UFFFFFFFFx', 'x'],
    ]);
  });

  it('turns the named escapes into their byte and keeps the backslash of any other', () => {
    expectValues([
      ['\\a', '\x07'],
      ['\\b', '\b'],
      ['\\e', '\x1b'],
      ['\\E', '\x1b'],
      ['\\f', '\f'],
      ['\\n', '\n'],
      ['\\r', '\r'],
      ['\\t', '\t'],
      ['\\v', '\v'],
      ['\\\\', '\\'],
      ['\\\'', '\''],
      ['\\"', '"'],
      ['\\?', '?'],
      ['\\q', '\\q'],
      ['\\-', '\\-'],
      ['\\ ', '\\ '],
      ['\\$', '\\$'],
      ['\\`', '\\`'],
      ['\\d', '\\d'],
      ['\\A', '\\A'],
      ['\\Z', '\\Z'],
      ['\\_', '\\_'],
      ['\\/', '\\/'],
      ['\\\\\\\\', '\\\\'],
      ['\\\\0', '\\0'],
      ['\\\\\\\'', '\\\''],
    ]);
  });

  it('reads \\cX as the low five bits of the byte after it', () => {
    expectValues([
      ['\\c', '\\c'],
      ['\\cA', '\x01'],
      ['\\ca', '\x01'],
      ['\\cZ', '\x1a'],
      ['\\cz', '\x1a'],
      ['\\c?', '\x7f'],
      ['\\c\\\\', '\x1c'],
      ['\\c\\\\x', '\x1cx'],
      ['\\c\\x', '\x1cx'],
      ['\\c\\\'x', '\x1c\'x'],
      ['\\c[', '\x1b'],
      ['\\c]', '\x1d'],
      ['\\c^', '\x1e'],
      ['\\c_', '\x1f'],
      ['\\c-', '\r'],
      ['\\cm', '\r'],
      ['\\c0', '\x10'],
      ['\\c1', '\x11'],
      ['\\c"', '\x02'],
      ['\\c$', '\x04'],
      ['\\c\\0', '\x1c0'],
      ['\\c\\n', '\x1cn'],
      ['\\c\\\\\\\\', '\x1c\\'],
      ['\\c\\\\\\\'', '\x1c\''],
    ]);
  });

  it('gives U+FFFD for bytes a string cannot hold, which no guard reads', () => {
    expectValues([
      ['\\777', '\u{fffd}'],
      ['\\377', '\u{fffd}'],
      ['\\200', '\u{fffd}'],
      ['\\x80', '\u{fffd}'],
      ['\\xff', '\u{fffd}'],
      ['\\uD800', '\u{fffd}'],
      ['\\U00110000', '\u{fffd}'],
      ['\\U7FFFFFFF', '\u{fffd}'],
      ['\\c\u{e9}', '\x03\u{fffd}'],
      ['\\U00110000x', '\u{fffd}x'],
    ]);
  });
});
