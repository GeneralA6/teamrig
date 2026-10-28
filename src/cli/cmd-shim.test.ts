import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cutLineMessage, shimArgs, windowsArgs } from './cmd-shim.ts';

const SHIM = 'C:\\kit\\bin\\teamrig.cmd';

describe('shimArgs', () => {
  it('rebuilds the arguments of the command line PowerShell 5.1 hands cmd, line breaks and later flags kept', () => {
    // The line a live probe read: PowerShell 5.1 drops the inner quotes, so `"quoted"` closes and reopens the quotes.
    const line = `C:\\WINDOWS\\system32\\cmd.exe /c ""${SHIM}" add --title "a b" --description "line one "quoted" & pipe | 100% bang!\nline two\nline three" --priority p3"`;
    const given = ['add', '--title', 'a b', '--description', 'line one quoted & pipe | 100% bang!'];
    assert.deepEqual(shimArgs(given, line), ['add', '--title', 'a b', '--description', 'line one quoted & pipe | 100% bang!\nline two\nline three', '--priority', 'p3']);
  });

  it("rebuilds the line Node's cmd.exe start gives, with /d /s before the /C switch", () => {
    const line = `C:\\WINDOWS\\system32\\cmd.exe /d /s /C ""${SHIM}" "no\nsuch""`;
    assert.deepEqual(shimArgs(['no'], line), ['no\nsuch']);
  });

  it('keeps a CRLF line break, of which cmd cut the CR too', () => {
    const line = `cmd.exe /c ""${SHIM}" add --description "one\r\ntwo" --priority p3"`;
    assert.deepEqual(shimArgs(['add', '--description', 'one'], line), ['add', '--description', 'one\r\ntwo', '--priority', 'p3']);
  });

  it('takes the given arguments when the line holds no line break, or there is none', () => {
    const given = ['list', '--session', 'a b'];
    assert.equal(shimArgs(given, `cmd.exe /c ""${SHIM}" list --session "a b""`), given);
    // An interactive cmd's own command line, which runs a typed teamrig.
    assert.equal(shimArgs(given, '"C:\\WINDOWS\\system32\\cmd.exe" '), given);
    assert.equal(shimArgs(given, undefined), given);
  });

  it("refuses a line that is not this run's: its cut gives other arguments", () => {
    const line = `cmd.exe /c ""${SHIM}" add --description "one\ntwo""`;
    assert.equal(shimArgs(['list'], line), undefined);
    assert.equal(shimArgs(['add', '--description', 'one', 'two'], line), undefined);
  });

  it('refuses a line with a line break and no /c or /k switch', () => {
    assert.equal(shimArgs(['add'], `cmd.exe ""${SHIM}" add --description "one\ntwo""`), undefined);
    assert.equal(shimArgs(['add'], `cmd.exe /cx ""${SHIM}" add --description "one\ntwo""`), undefined);
  });

  it('reads the command after /k, and a command cmd ran without outer quotes', () => {
    assert.deepEqual(shimArgs(['a'], `cmd.exe /k ""${SHIM}" "a\nb""`), ['a\nb']);
    assert.deepEqual(shimArgs(['a'], 'cmd.exe /c teamrig "a\nb"'), ['a\nb']);
  });
});

describe('windowsArgs', () => {
  it('reads the program name with its quotes as grouping only, a backslash before one literal', () => {
    assert.deepEqual(windowsArgs('"C:\\a b\\x.cmd" y'), ['C:\\a b\\x.cmd', 'y']);
    assert.deepEqual(windowsArgs('"C:\\dir\\"x y'), ['C:\\dir\\x', 'y']);
    assert.deepEqual(windowsArgs('prog'), ['prog']);
  });

  it('follows the C runtime backslash and quote rules', () => {
    // The examples of Microsoft's "Parsing C++ command-line arguments".
    assert.deepEqual(windowsArgs('p "a b c" d e'), ['p', 'a b c', 'd', 'e']);
    assert.deepEqual(windowsArgs('p "ab\\"c" "\\\\" d'), ['p', 'ab"c', '\\', 'd']);
    assert.deepEqual(windowsArgs('p a\\\\\\b d"e f"g h'), ['p', 'a\\\\\\b', 'de fg', 'h']);
    assert.deepEqual(windowsArgs('p a\\\\\\"b c d'), ['p', 'a\\"b', 'c', 'd']);
    assert.deepEqual(windowsArgs('p a\\\\\\\\"b c" d e'), ['p', 'a\\\\b c', 'd', 'e']);
    assert.deepEqual(windowsArgs('p a"b"" c d'), ['p', 'ab" c d']);
  });

  it('parts arguments at spaces and tabs only, keeps an empty quoted one and ignores trailing blanks', () => {
    assert.deepEqual(windowsArgs('p a\nb\tc  "" d \t'), ['p', 'a\nb', 'c', '', 'd']);
    assert.deepEqual(windowsArgs('p "open\nquote'), ['p', 'open\nquote']);
  });
});

describe('cutLineMessage', () => {
  it('says nothing was done and names the ways to run the command whole', () => {
    const message = cutLineMessage('C:\\kit\\dist\\cli\\main.js');
    assert.match(message, /line break.*cmd\.exe.*dropped everything after it, so nothing was done/);
    assert.match(message, /from Bash, keep each argument on one line, or run node "C:\\kit\\dist\\cli\\main\.js" with the same arguments\.$/);
  });
});
