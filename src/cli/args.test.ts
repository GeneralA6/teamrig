import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  noPositionals,
  onePositional,
  parseArgs,
  requiredFlag,
  UsageError,
  type CommandFlags,
  type CommandSwitches,
  type RenamedFlags,
} from './args.ts';

const COMMANDS: CommandFlags = {
  add: ['title', 'priority'],
  show: [],
  'inbox read': ['session'],
  'inbox add': ['to', 'text'],
};

function usageMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof UsageError, 'expected a UsageError');
    return error.message;
  }
  assert.fail('expected a UsageError');
}

describe('parseArgs', () => {
  it('splits a command, its words and its flags', () => {
    const args = parseArgs(['add', 'extra', '--title', 'Ship it', '--priority', 'p2'], COMMANDS);
    assert.equal(args.command, 'add');
    assert.deepEqual(args.positionals, ['extra']);
    assert.deepEqual([...args.flags], [['title', 'Ship it'], ['priority', 'p2']]);
  });

  it('reads a two-word command', () => {
    const args = parseArgs(['inbox', 'read', '--session', 'alpha'], COMMANDS);
    assert.equal(args.command, 'inbox read');
    assert.equal(args.flags.get('session'), 'alpha');
  });

  it('lists the actions of a group named without one, or with an unknown one', () => {
    assert.equal(usageMessage(() => parseArgs(['inbox'], COMMANDS)), 'inbox read|add');
    assert.equal(usageMessage(() => parseArgs(['inbox', 'drop'], COMMANDS)), 'inbox read|add');
  });

  it('refuses an unknown command and an empty line', () => {
    assert.equal(usageMessage(() => parseArgs(['launch'], COMMANDS)), 'unknown command "launch"');
    assert.equal(usageMessage(() => parseArgs([], COMMANDS)), 'no command given');
  });

  it('refuses a flag the command does not take, so a typo never means nothing', () => {
    assert.equal(usageMessage(() => parseArgs(['add', '--titel', 'x'], COMMANDS)), 'add takes no --titel');
    assert.equal(usageMessage(() => parseArgs(['show', 'T1', '--priority', 'p2'], COMMANDS)), 'show takes no --priority');
  });

  it('refuses a renamed flag on every command with its new name, never reading it as an alias', () => {
    const renamed: RenamedFlags = { tier: 'priority' };
    assert.equal(usageMessage(() => parseArgs(['add', '--title', 'x', '--tier', '2'], COMMANDS, {}, renamed)), '--tier was renamed: use --priority');
    assert.equal(usageMessage(() => parseArgs(['show', 'T1', '--tier', '2'], COMMANDS, {}, renamed)), '--tier was renamed: use --priority');
    assert.equal(usageMessage(() => parseArgs(['add', '--tier', '2'], COMMANDS)), 'add takes no --tier', 'with no rename given it is just unknown');
  });

  it('refuses a flag without a value or given twice', () => {
    assert.equal(usageMessage(() => parseArgs(['add', '--title'], COMMANDS)), '--title needs a value');
    assert.equal(usageMessage(() => parseArgs(['add', '--title', '--priority', 'p2'], COMMANDS)), '--title needs a value');
    assert.equal(usageMessage(() => parseArgs(['add', '--priority', 'p1', '--priority', 'p2'], COMMANDS)), '--priority is given twice');
  });

  it('reads a switch without a value, only on the command that takes it', () => {
    const switches: CommandSwitches = { 'inbox read': ['all'] };
    const args = parseArgs(['inbox', 'read', '--all', 'extra', '--session', 'alpha'], COMMANDS, switches);
    assert.deepEqual([...args.switches], ['all']);
    assert.deepEqual(args.positionals, ['extra']);
    assert.equal(args.flags.get('session'), 'alpha');
    assert.deepEqual([...parseArgs(['inbox', 'read'], COMMANDS, switches).switches], []);
    assert.deepEqual([...parseArgs(['show', 'T1'], COMMANDS).switches], []);
    assert.equal(usageMessage(() => parseArgs(['inbox', 'add', '--all'], COMMANDS, switches)), 'inbox add takes no --all');
    assert.equal(usageMessage(() => parseArgs(['inbox', 'read', '--all', '--all'], COMMANDS, switches)), '--all is given twice');
  });
});

describe('positionals and required flags', () => {
  it('takes exactly one positional when a command needs one', () => {
    assert.equal(onePositional(parseArgs(['show', 'T7'], COMMANDS), 'id'), 'T7');
    assert.equal(usageMessage(() => onePositional(parseArgs(['show'], COMMANDS), 'id')), 'show needs <id>');
    assert.equal(usageMessage(() => onePositional(parseArgs(['show', 'T7', 'T8'], COMMANDS), 'id')), 'unexpected "T8"');
  });

  it('refuses words a command does not take', () => {
    assert.doesNotThrow(() => noPositionals(parseArgs(['inbox', 'read'], COMMANDS)));
    assert.equal(usageMessage(() => noPositionals(parseArgs(['inbox', 'read', 'now'], COMMANDS))), 'unexpected "now"');
  });

  it('names a missing required flag', () => {
    const { flags } = parseArgs(['add', '--priority', 'p2'], COMMANDS);
    assert.equal(requiredFlag(flags, 'priority'), 'p2');
    assert.equal(usageMessage(() => requiredFlag(flags, 'title')), '--title is required');
  });
});
