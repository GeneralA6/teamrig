import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shellBraceReads } from './js-shell-reads.ts';

describe('shellBraceReads', () => {
  it('reads ${NAME} in a quoted string and escaped in a template literal, never interpolated', () => {
    assert.deepEqual(shellBraceReads("run('echo ${A_KEY}'); run(\"echo ${B_KEY}\"); run(`echo \\${C_KEY} ${D_KEY}`);"), ['A_KEY', 'B_KEY', 'C_KEY']);
  });

  it("reads a template literal's quotes as its text, and a quoted string's backtick as its text", () => {
    assert.deepEqual(shellBraceReads("`it's ${A_KEY}` + 'a ` b ${B_KEY}' + `${C_KEY}`"), ['B_KEY']);
  });

  it('follows the code nested in a template: a string, a nested template, an object, then the template goes on', () => {
    assert.deepEqual(shellBraceReads("`a ${get('${A_KEY}')} b ${f(`\\${B_KEY} ${C_KEY}`)} c ${ { d: '1' }.d } ${E_KEY}` + '${F_KEY}'"), ['A_KEY', 'B_KEY', 'F_KEY']);
  });

  it('skips comments, whose quotes open no string', () => {
    assert.deepEqual(shellBraceReads("// don't '${A_KEY}'\n'${B_KEY}' /* it's '${C_KEY}' */ '${D_KEY}'"), ['B_KEY', 'D_KEY']);
    assert.deepEqual(shellBraceReads("/* an unclosed comment '${A_KEY}'"), []);
    assert.deepEqual(shellBraceReads("'${A_KEY}' // a last line with no end"), ['A_KEY']);
  });

  it("ends a quoted string at its line's end, steps over its escapes, and reads only upper-case names", () => {
    assert.deepEqual(shellBraceReads("'an unclosed ${A_KEY}\n`${B_KEY}`"), ['A_KEY']);
    assert.deepEqual(shellBraceReads("'a last string with no end ${A_KEY}"), ['A_KEY']);
    assert.deepEqual(shellBraceReads("'it\\'s ${A_KEY}' '${key} $B_KEY {C_KEY}' `\\n`"), ['A_KEY']);
  });

  it('reads nothing from code outside any string, nor from braces outside a template', () => {
    assert.deepEqual(shellBraceReads('const { A_KEY } = config; } ${B_KEY}'), []);
  });
});
