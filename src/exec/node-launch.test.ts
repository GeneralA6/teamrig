import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foreignNodeOptions, nodeLaunchRefusal, nodeOptionsWords, type ForeignOption } from './node-launch.ts';

/** The options `execArgv` holds outside the list, each as written. */
function foreignOnCommandLine(...execArgv: string[]): string[] {
  return foreignNodeOptions(execArgv, undefined).map(({ option }) => option);
}

describe('nodeOptionsWords: NODE_OPTIONS split as node splits it (T1036)', () => {
  it('splits on spaces, leaving out empty words', () => {
    assert.deepEqual(nodeOptionsWords(''), []);
    assert.deepEqual(nodeOptionsWords('a  b'), ['a', 'b']);
    assert.deepEqual(nodeOptionsWords(' --no-warnings '), ['--no-warnings']);
  });

  it('keeps spaces inside double quotes, and drops the quotes', () => {
    assert.deepEqual(nodeOptionsWords('"a b" c'), ['a b', 'c']);
    assert.deepEqual(nodeOptionsWords('--disable-warning="A B"'), ['--disable-warning=A B']);
    assert.deepEqual(nodeOptionsWords('""'), []);
  });

  it('takes the character after a backslash as it is inside quotes, and a backslash outside them as itself', () => {
    assert.deepEqual(nodeOptionsWords('"a\\"b"'), ['a"b']);
    assert.deepEqual(nodeOptionsWords('"a\\\\b"'), ['a\\b']);
    assert.deepEqual(nodeOptionsWords('a\\b'), ['a\\b']);
  });
});

describe('foreignNodeOptions: the options outside the list (T1036)', () => {
  it('finds none in the forms the listed options take', () => {
    assert.deepEqual(foreignNodeOptions([], undefined), []);
    assert.deepEqual(foreignOnCommandLine('--disable-warning=ExperimentalWarning'), []);
    assert.deepEqual(foreignOnCommandLine('--disable-warning', 'DEP0040'), []);
    assert.deepEqual(foreignOnCommandLine('--max_old_space_size=4096', '--max-old-space-size', '2048'), []);
    assert.deepEqual(foreignOnCommandLine('--enable-source-maps', '--no-warnings', '--no-deprecation'), []);
    assert.deepEqual(foreignNodeOptions([], '--max-old-space-size 4096 --no-warnings --disable-warning="A B"'), []);
  });

  it('names each option that loads code or opens a debugger, with the value word it takes', () => {
    assert.deepEqual(foreignOnCommandLine('-r', 'x.js'), ['-r x.js']);
    assert.deepEqual(foreignOnCommandLine('--require=x.js'), ['--require=x.js']);
    assert.deepEqual(foreignOnCommandLine('--import', 'y.mjs'), ['--import y.mjs']);
    assert.deepEqual(foreignOnCommandLine('--loader=z'), ['--loader=z']);
    assert.deepEqual(foreignOnCommandLine('--experimental-loader', 'z'), ['--experimental-loader z']);
    assert.deepEqual(foreignOnCommandLine('--inspect'), ['--inspect']);
    assert.deepEqual(foreignOnCommandLine('--inspect-brk=9229'), ['--inspect-brk=9229']);
    assert.deepEqual(foreignOnCommandLine('--env-file=.env'), ['--env-file=.env']);
    assert.deepEqual(foreignOnCommandLine('-C', 'dev'), ['-C dev']);
    assert.deepEqual(foreignOnCommandLine('--'), ['--']);
    assert.deepEqual(foreignOnCommandLine('--inspect', '--require', 'x.js'), ['--inspect', '--require x.js']);
  });

  it('refuses a listed option with a value it does not take', () => {
    assert.deepEqual(foreignOnCommandLine('--max-old-space-size=lots'), ['--max-old-space-size=lots']);
    assert.deepEqual(foreignOnCommandLine('--max-old-space-size', 'lots'), ['--max-old-space-size lots']);
    assert.deepEqual(foreignOnCommandLine('--disable-warning'), ['--disable-warning']);
    assert.deepEqual(foreignOnCommandLine('--disable-warning='), ['--disable-warning=']);
    assert.deepEqual(foreignOnCommandLine('--disable-warning=-r'), ['--disable-warning=-r']);
    assert.deepEqual(foreignOnCommandLine('--disable-warning', '--require', 'x.js'), ['--disable-warning', '--require x.js']);
    assert.deepEqual(foreignOnCommandLine('--no-warnings=1'), ['--no-warnings=1']);
    assert.deepEqual(foreignOnCommandLine('--no-warnings', 'x.js'), ['x.js']);
  });

  it("names where node took each option from, the command line's first", () => {
    const expected: ForeignOption[] = [
      { option: '--inspect', source: 'command line' },
      { option: '--require=x.js', source: 'NODE_OPTIONS' },
      { option: '--import=y z.mjs', source: 'NODE_OPTIONS' },
    ];
    assert.deepEqual(foreignNodeOptions(['--inspect'], '--require=x.js "--import=y z.mjs"'), expected);
  });

  it('reads a word that hides an option behind a tab as one unlisted option', () => {
    assert.deepEqual(foreignNodeOptions([], '--no-warnings\t--require=x.js'), [{ option: '--no-warnings\t--require=x.js', source: 'NODE_OPTIONS' }]);
  });
});

describe('nodeLaunchRefusal: why an exec command refuses this node (T1036)', () => {
  const HEAD = 'teamrig exec runs only on a node with no option that can run code beside the client, and this one has';

  it('is undefined on a node with listed options only', () => {
    assert.equal(nodeLaunchRefusal([], {}, 'linux'), undefined);
    assert.equal(nodeLaunchRefusal(['--no-warnings'], { NODE_OPTIONS: '--max-old-space-size=4096' }, 'linux'), undefined);
    assert.equal(nodeLaunchRefusal([], { NODE_OPTIONS: '' }, 'win32'), undefined);
  });

  it('names each option with its place, and the fix for each place', () => {
    assert.equal(nodeLaunchRefusal(['--inspect'], {}, 'linux'), `${HEAD} --inspect (on node's command line); drop them from node's command line, then run it again.`);
    assert.equal(nodeLaunchRefusal([], { NODE_OPTIONS: '--import=y.mjs' }, 'linux'), `${HEAD} --import=y.mjs (in NODE_OPTIONS); unset NODE_OPTIONS or take them out of it, then run it again.`);
    assert.equal(
      nodeLaunchRefusal(['-r', 'x.js'], { NODE_OPTIONS: '--import=y.mjs' }, 'linux'),
      `${HEAD} -r x.js (on node's command line), --import=y.mjs (in NODE_OPTIONS); drop them from node's command line and unset NODE_OPTIONS or take them out of it, then run it again.`,
    );
  });

  it("reads NODE_OPTIONS under any case of its name on Windows, and only under its own name elsewhere, as node does", () => {
    assert.match(nodeLaunchRefusal([], { node_options: '--require=x.js' }, 'win32') ?? '', /--require=x\.js \(in NODE_OPTIONS\)/);
    assert.equal(nodeLaunchRefusal([], { node_options: '--require=x.js' }, 'linux'), undefined);
  });
});
