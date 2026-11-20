import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasUnprintable, plainLine, printable } from './printable.ts';

describe('plainLine', () => {
  it('turns control and format characters into spaces, so outside text stays one plain line', () => {
    assert.equal(plainLine('  Fix\u001b[2J the‮ login\r\nnow\t '), 'Fix [2J the login now');
  });
});

describe('printable', () => {
  it('leaves text with no control character as it is, non-ASCII letters included', () => {
    assert.equal(printable('src/a b/naïve-файл.ts'), 'src/a b/naïve-файл.ts');
  });

  it('writes a newline, a carriage return and a tab as their short escapes', () => {
    assert.equal(printable('a\nCLEAN acme/web#7\r\tb'), 'a\\nCLEAN acme/web#7\\r\\tb');
  });

  it('writes ESC, NUL, DEL and a C1 control as \\xNN, so no escape sequence reaches the terminal', () => {
    assert.equal(printable('\u001b[31mred\u0000\u007f\u009b2J'), '\\x1b[31mred\\x00\\x7f\\x9b2J');
  });
});

describe('printable: bidi marks', () => {
  it('writes each bidi format mark as \\uNNNN, so a line draws in the order it holds (T3016)', () => {
    assert.equal(printable('a\u202eb\u2066c\u2069d\u200e\u200f\u061c'), 'a\\u202eb\\u2066c\\u2069d\\u200e\\u200f\\u061c');
  });

  it('leaves right-to-left letters, which are text and not marks', () => {
    assert.equal(printable('שלום مرحبا'), 'שלום مرحبا');
  });
});

describe('hasUnprintable', () => {
  it('is true for a control or a bidi mark and false for plain text', () => {
    assert.equal(hasUnprintable('ok \u001b[2J'), true);
    assert.equal(hasUnprintable('ok \u202e'), true);
    assert.equal(hasUnprintable('the release plan · naïve'), false);
  });
});
