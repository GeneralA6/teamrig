import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { characterClasses, GlobAutomaton, telltaleCharacters } from './glob-automaton.ts';
import { globNodes, type GlobOptions } from './glob.ts';
import { fitsSecret, type WalkedGlob } from './secret-walk.ts';

const OPTIONS: GlobOptions = { ignoreCase: false, dotfiles: true, sets: 'ripgrep' };
const automaton = (glob: string): GlobAutomaton => new GlobAutomaton(globNodes(glob, OPTIONS), false);

/** `fitsSecret` of `word` against `globs` (`!glob` keeps), every secret glob tried. */
function fits(word: string, globs: readonly string[], maxStates = 20_000): boolean {
  const walked = globs.map((glob): WalkedGlob => {
    const keep = glob.startsWith('!');
    return { keep, automaton: automaton(keep ? glob.slice(1) : glob), tried: !keep };
  });
  const wordAutomaton = automaton(word);
  const chars = characterClasses(telltaleCharacters([word, ...globs]), [wordAutomaton, ...walked.map((glob) => glob.automaton)]);
  return fitsSecret(wordAutomaton, walked, chars, maxStates);
}

describe('fitsSecret', () => {
  it('counts a word whose text the glob spells, or whose wildcard the glob’s wildcard covers', () => {
    assert.equal(fits('.env.l*', ['.env.*']), true);
    assert.equal(fits('b*.pem', ['*.pem']), true);
    assert.equal(fits('b[./]pem', ['*.pem']), true);
    assert.equal(fits('deploy/id_*', ['**/id_rsa']), true);
  });

  it('drops a word that meets the glob only where each one’s wildcard covers the other’s text', () => {
    assert.equal(fits('*.ts', ['.env.*']), false);
    assert.equal(fits('a*', ['*.pem']), false);
  });

  it('counts a crossing one way on one reading though another reading crosses both', () => {
    assert.equal(fits('*.pem', ['*.pem']), true, 'the * over the glob’s * crosses nothing');
  });

  it('lets the last glob that accepts decide: a later !glob keeps, a secret glob after it does not', () => {
    assert.equal(fits('.env.exampl[e]', ['.env.*', '!.env.example']), false);
    assert.equal(fits('.env.exampl[e]', ['.env.*', '!.env.example', '*.example']), true);
    assert.equal(fits('.env.exampl?', ['.env.*', '!.env.example']), true, '.env.examplz is no example');
  });

  it('finds nothing a glob never reaches', () => {
    assert.equal(fits('src/*.ts', ['*.pem', '.env']), false);
    assert.equal(fits('*.ts', []), false);
  });

  it('counts the word as a secret past its state bound: the safe side', () => {
    assert.equal(fits('*.ts', ['.env.*'], 1), true);
    assert.equal(fits('x.ts', ['.env.*'], 1), false, 'a walk that ends at once spends no bound');
  });
});
