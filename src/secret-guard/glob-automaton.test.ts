import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { characterClasses, GlobAutomaton, telltaleCharacters } from './glob-automaton.ts';
import { globNodes, globRegExp, type GlobOptions } from './glob.ts';

const GLOBS = ['**/.env', '**/.env.*', '~/.ssh/**', '*.pem', 'b[!a]pem', 'b[./]pem', '*[/]e.pem', '.en[z-av]', 'a/**', '**/x/**/y', '?x*', 'k8s/**/s.yaml'];
const PATHS = ['.env', 'a/.env', '.env.local', 'a/b/.env.x', '~/.ssh/id', '~/.ssh/a/b', 'b.pem', 'B.PEM', 'sub/e.pem', 'b/pem', 'bapem', '.env', '.enz', 'a', 'a/', 'a/b/c', 'x/y', 'q/x/r/s/y', '.x', 'ax', 'k8s/s.yaml', 'k8s/a/b/s.yaml', ''];
const READINGS: readonly GlobOptions[] = [
  { ignoreCase: false, dotfiles: true, sets: 'bash' },
  { ignoreCase: true, dotfiles: false, sets: 'bash' },
  { ignoreCase: false, dotfiles: true, sets: 'ripgrep' },
];

/** True when `automaton` accepts `path`, walked a character at a time. */
function walks(automaton: GlobAutomaton, path: string): boolean {
  let states = automaton.start;
  for (const char of path) {
    states = automaton.step(states, char);
  }
  return automaton.accepts(states);
}

describe('GlobAutomaton', () => {
  it('accepts the same paths as globRegExp of the same glob, in every reading', () => {
    for (const options of READINGS) {
      for (const glob of GLOBS) {
        const automaton = new GlobAutomaton(globNodes(glob, options), options.ignoreCase);
        const pattern = globRegExp(glob, options);
        const differ = PATHS.filter((path) => walks(automaton, path) !== pattern.test(path));
        assert.deepEqual(differ, [], `${glob} ${JSON.stringify(options)}`);
      }
    }
  });

  it('names the part of the glob that reads each character', () => {
    const automaton = new GlobAutomaton(globNodes('**/b*.pem', { ignoreCase: false, dotfiles: true, sets: 'bash' }), false);
    assert.deepEqual(automaton.moves(automaton.first, 'x').map(({ role }) => role), ['folders']);
    const roles = automaton.moves(automaton.first, 'b').map(({ role }) => role).sort();
    assert.deepEqual(roles, ['folders', 'literal']);
    const afterB = automaton.moves(automaton.first, 'b').find(({ role }) => role === 'literal');
    assert.deepEqual(automaton.moves(afterB?.to ?? -1, 'z').map(({ role }) => role), ['star']);
    assert.equal(automaton.acceptsAt(automaton.first), false);
    assert.ok(automaton.size > 1);
  });

  it('keeps a bash wildcard off a leading dot, and lets it reach one in a dotfiles reading', () => {
    const bash = new GlobAutomaton(globNodes('*', { ignoreCase: false, dotfiles: false, sets: 'bash' }), false);
    assert.equal(walks(bash, '.env'), false);
    assert.equal(walks(bash, 'env'), true);
    const any = new GlobAutomaton(globNodes('*', { ignoreCase: false, dotfiles: true, sets: 'bash' }), false);
    assert.equal(walks(any, '.env'), true);
  });
});

describe('telltaleCharacters', () => {
  it('gives each character the texts name, the one after it, both cases, and the stand-ins for the rest', () => {
    const chars = telltaleCharacters(['[a-c]Z']);
    for (const char of ['a', 'b', 'c', 'd', 'C', 'D', 'Z', 'z', '[', '\u0000', '/', '0', '.']) {
      assert.ok(chars.includes(char), char);
    }
  });
});

describe('characterClasses', () => {
  it('keeps one character of each kind the automata tell apart', () => {
    const automaton = new GlobAutomaton(globNodes('*.pem', { ignoreCase: false, dotfiles: true, sets: 'bash' }), false);
    const classes = characterClasses(['a', 'b', '.', '/', 'p', 'e', 'm', 'q'], [automaton]);
    assert.deepEqual(classes, ['a', '.', '/', 'p', 'e', 'm']);
  });
});
