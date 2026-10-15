import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandHelp, FULL_HELP_POINTER } from './help.ts';

const USAGE = [
  'tool <command> ...   (the caller: --session <id>)',
  '      a deep line before any block belongs to none',
  '  add --title "<one line>" [--due <date>]',
  '      [--goals a,b]',
  '  add --team <child> --title ..   hands a child team a task',
  '  set <id> --status open|done',
  '  inbox read [--session <area>]   prints the unread lines',
  '  inbox add --to <id> --text "<one line>"',
  '  config validate | config migrate',
  'Dates: YYYY-MM-DD.',
  '',
].join('\n');

const COMMANDS = ['add', 'set', 'inbox read', 'inbox add', 'config validate', 'config migrate', 'commits check'];

describe('CommandHelp', () => {
  const help = new CommandHelp(USAGE, COMMANDS);

  it("gives a command every block that names it, with the lines under each, and a group word every command's", () => {
    assert.deepEqual(help.linesOf('add'), [
      '  add --title "<one line>" [--due <date>]',
      '      [--goals a,b]',
      '  add --team <child> --title ..   hands a child team a task',
    ]);
    assert.deepEqual(help.linesOf('inbox read'), ['  inbox read [--session <area>]   prints the unread lines']);
    assert.deepEqual(help.linesOf('inbox'), ['  inbox read [--session <area>]   prints the unread lines', '  inbox add --to <id> --text "<one line>"']);
    assert.deepEqual(help.linesOf('config migrate'), ['  config validate | config migrate']);
    assert.deepEqual(help.linesOf('se'), [], 'a prefix of a command names nothing');
  });

  it('names the commands no block covers', () => {
    assert.deepEqual(help.undocumented(), ['commits check']);
  });

  it('prints the shape of a line, the command lines and where the full help is', () => {
    assert.equal(help.forCommand('set'), ['tool <command> ...   (the caller: --session <id>)', '  set <id> --status open|done', FULL_HELP_POINTER].join('\n'));
  });

  it('lists the command words for an unknown command or none', () => {
    const listing = ['tool <command> ...   (the caller: --session <id>)', 'Commands: add, set, inbox, config, commits', FULL_HELP_POINTER].join('\n');
    assert.equal(help.forCommand('frob'), listing);
    assert.equal(help.forCommand(undefined), listing);
  });

  it('puts the reason first in a usage error', () => {
    assert.equal(help.usageError('unexpected "done"', 'set'), `unexpected "done"\n\n${help.forCommand('set')}`);
    assert.equal(help.usageError('no command given', undefined), `no command given\n\n${help.forCommand(undefined)}`);
  });
});
