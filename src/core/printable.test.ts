import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { printable } from './printable.ts';

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
