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
  type Renamed,
} from './args.ts';

const COMMANDS: CommandFlags = {
  add: ['title', 'priority'],
  show: [],
  'inbox read': ['session'],
  'inbox add': ['to', 'text'],
};

function usageError(run: () => unknown): UsageError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof UsageError, 'expected a UsageError');
    return error;
  }
  assert.fail('expected a UsageError');
}

function usageMessage(run: () => unknown): string {
  return usageError(run).message;
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
    const renamed: Renamed = { flags: { tier: 'priority' } };
    assert.equal(usageMessage(() => parseArgs(['add', '--title', 'x', '--tier', '2'], COMMANDS, {}, renamed)), '--tier was renamed: use --priority');
    assert.equal(usageMessage(() => parseArgs(['show', 'T1', '--tier', '2'], COMMANDS, {}, renamed)), '--tier was renamed: use --priority');
    assert.equal(usageMessage(() => parseArgs(['add', '--tier', '2'], COMMANDS)), 'add takes no --tier', 'with no rename given it is just unknown');
  });

  it('refuses a renamed command with its new name, its words after it included, never running it as an alias', () => {
    const renamed: Renamed = { commands: { post: 'inbox add' } };
    assert.equal(usageMessage(() => parseArgs(['post', '--to', 'alpha'], COMMANDS, {}, renamed)), 'post was renamed: use inbox add');
    assert.equal(usageMessage(() => parseArgs(['post', 'end'], COMMANDS, {}, renamed)), 'post was renamed: use inbox add');
    assert.equal(usageMessage(() => parseArgs(['post'], COMMANDS)), 'unknown command "post"', 'with no rename given it is just unknown');
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

describe('the command a usage error is for, and help requests', () => {
  it('names the command or group word a refused line was for, so only its usage is printed', () => {
    const commandOf = (run: () => unknown): string | undefined => usageError(run).command;
    const switches: CommandSwitches = { 'inbox read': ['all'] };
    assert.equal(commandOf(() => parseArgs(['add', '--titel', 'x'], COMMANDS)), 'add');
    assert.equal(commandOf(() => parseArgs(['add', '--title'], COMMANDS)), 'add');
    assert.equal(commandOf(() => parseArgs(['add', '--priority', 'p1', '--priority', 'p2'], COMMANDS)), 'add');
    assert.equal(commandOf(() => parseArgs(['show', '--tier', '2'], COMMANDS, {}, { flags: { tier: 'priority' } })), 'show');
    assert.equal(commandOf(() => parseArgs(['inbox', 'read', '--all', '--all'], COMMANDS, switches)), 'inbox read');
    assert.equal(commandOf(() => parseArgs(['inbox', 'drop'], COMMANDS)), 'inbox');
    assert.equal(commandOf(() => parseArgs(['launch'], COMMANDS)), undefined);
    assert.equal(commandOf(() => parseArgs([], COMMANDS)), undefined);
    assert.equal(commandOf(() => noPositionals(parseArgs(['inbox', 'read', 'now'], COMMANDS))), undefined, 'a check inside a command leaves it to the caller');
  });

  it('reads --help or -h after a command or a group word as a request for its help, and stops reading there', () => {
    const help = parseArgs(['add', 'extra', '--title', 'x', '--help', '--bogus'], COMMANDS);
    assert.deepEqual([help.command, help.help, help.positionals, [...help.flags], [...help.switches]], ['add', true, [], [], []]);
    assert.deepEqual([parseArgs(['show', '-h'], COMMANDS).help, parseArgs(['inbox', 'read', '--help'], COMMANDS).command], [true, 'inbox read']);
    const group = parseArgs(['inbox', '-h'], COMMANDS);
    assert.deepEqual([group.command, group.help], ['inbox', true]);
    assert.equal(parseArgs(['show', 'T1'], COMMANDS).help, false);
    assert.equal(usageMessage(() => parseArgs(['launch', '--help'], COMMANDS)), 'unknown command "launch"');
    const text = parseArgs(['inbox', 'add', '--text', '-h'], COMMANDS);
    assert.deepEqual([text.help, text.flags.get('text')], [false, '-h'], 'a flag value is never a help request');
  });
});

describe('the -- that ends a command line', () => {
  const rest: ReadonlySet<string> = new Set(['add']);

  it('passes every word after -- on untouched, flags, help and quotes included, on a command that takes it', () => {
    const args = parseArgs(['add', 'x', '--title', 'T', '--', 'node', '--test', '--help', '-h', '"src/**"', '--'], COMMANDS, {}, {}, rest);
    assert.deepEqual([args.positionals, [...args.flags], args.help], [['x'], [['title', 'T']], false]);
    assert.deepEqual(args.rest, ['node', '--test', '--help', '-h', '"src/**"', '--']);
    assert.deepEqual(parseArgs(['add', '--'], COMMANDS, {}, {}, rest).rest, [], 'nothing after it is an empty command line');
  });

  it('leaves rest empty without a --, and still reads --help before it as a help request', () => {
    assert.deepEqual(parseArgs(['add', '--title', 'T'], COMMANDS, {}, {}, rest).rest, []);
    const help = parseArgs(['add', '--help', '--', 'npm', 'test'], COMMANDS, {}, {}, rest);
    assert.deepEqual([help.help, help.rest], [true, []]);
  });

  it('refuses -- on every other command, as before', () => {
    assert.equal(usageMessage(() => parseArgs(['show', 'T1', '--', 'x'], COMMANDS, {}, {}, rest)), 'show takes no --');
    assert.equal(usageMessage(() => parseArgs(['add', '--', 'x'], COMMANDS)), 'add takes no --', 'with no command taking it, nothing changes');
    assert.equal(usageMessage(() => parseArgs(['add', '--title', '--', 'x'], COMMANDS, {}, {}, rest)), '--title needs a value', 'a flag still needs its value');
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
