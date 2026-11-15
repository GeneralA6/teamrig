import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandFlags } from '../cli/args.ts';
import { COMMAND_EFFECTS, COMMAND_FLAGS, COMMAND_TABLE } from '../cli/run.ts';
import { planSlash, sessionReads, withSession, type CommandTable } from './plan.ts';

/** A small table with one command of each kind; `mystery` has no effect, as a command added without one would. */
const TABLE: CommandTable = {
  flags: { list: ['session', 'status'], add: ['session', 'title'], who: [], 'inbox read': ['session'], 'hook stop': [], mystery: ['session'], test: ['session'] },
  switches: { list: ['all'] },
  renamed: { flags: { tier: 'priority' } },
  rest: new Set(['test']),
  effects: { list: 'read', add: 'write', who: 'read', 'inbox read': 'write', 'hook stop': 'internal', test: 'write' },
};

describe('planSlash', () => {
  it('asks for the help when nothing is typed', () => {
    assert.deepEqual(planSlash([], TABLE), { kind: 'help' });
  });

  it('fills a read or a write that takes --session and was given none', () => {
    assert.deepEqual(planSlash(['list', '--status', 'open', '--all'], TABLE), { kind: 'fill', command: 'list', argv: ['list', '--status', 'open', '--all'], effect: 'read' });
    assert.deepEqual(planSlash(['add', '--title', 'x'], TABLE), { kind: 'fill', command: 'add', argv: ['add', '--title', 'x'], effect: 'write' });
    assert.deepEqual(planSlash(['inbox', 'read'], TABLE), { kind: 'fill', command: 'inbox read', argv: ['inbox', 'read'], effect: 'write' });
  });

  it('passes an explicit --session through as typed, on a read or a write', () => {
    assert.deepEqual(planSlash(['list', '--session', 'bravo'], TABLE), { kind: 'as-typed', argv: ['list', '--session', 'bravo'], effect: 'read' });
    assert.deepEqual(planSlash(['add', '--title', 'x', '--session', 'bravo'], TABLE), {
      kind: 'as-typed',
      argv: ['add', '--title', 'x', '--session', 'bravo'],
      effect: 'write',
    });
  });

  it('runs a command that takes no --session as typed', () => {
    assert.deepEqual(planSlash(['who'], TABLE), { kind: 'as-typed', argv: ['who'], effect: 'read' });
  });

  it('treats a command with no effect as a write', () => {
    assert.deepEqual(planSlash(['mystery'], TABLE), { kind: 'fill', command: 'mystery', argv: ['mystery'], effect: 'write' });
  });

  it('refuses a command Claude Code or teamrig runs itself', () => {
    assert.deepEqual(planSlash(['hook', 'stop'], TABLE), { kind: 'internal', command: 'hook stop' });
  });

  it('reads a command line after -- as the CLI does, so a test line is a write', () => {
    assert.deepEqual(planSlash(['test', '--', 'npm', 'test', '--session', 'x'], TABLE), {
      kind: 'fill',
      command: 'test',
      argv: ['test', '--', 'npm', 'test', '--session', 'x'],
      effect: 'write',
    });
  });

  it('leaves a line the CLI cannot read, or a help request, to the CLI as typed: it runs nothing', () => {
    for (const argv of [['nope'], ['list', '--colour', 'red'], ['list', '--tier', 'p1'], ['list', '--help'], ['inbox', '-h'], ['add', '--session'], ['who', '--', 'x']]) {
      assert.deepEqual(planSlash(argv, TABLE), { kind: 'as-typed', argv, effect: 'read' });
    }
  });

  it('does not take a fault reading the table for a usage error', () => {
    const flags: CommandFlags = {
      get list(): readonly string[] {
        throw new Error('table gone');
      },
    };
    assert.throws(() => planSlash(['list'], { ...TABLE, flags }), /table gone/);
  });
});

describe('withSession', () => {
  it('adds --session last', () => {
    assert.deepEqual(withSession({ command: 'inbox read', argv: ['inbox', 'read'] }, 'alpha', TABLE), ['inbox', 'read', '--session', 'alpha']);
  });

  it('adds it before the -- of a command that runs a command line, never inside that line', () => {
    assert.deepEqual(withSession({ command: 'test', argv: ['test', '--', 'npm', 'test'] }, 'alpha', TABLE), ['test', '--session', 'alpha', '--', 'npm', 'test']);
  });

  it('adds it last on a command that runs a command line but was given none', () => {
    assert.deepEqual(withSession({ command: 'test', argv: ['test'] }, 'alpha', TABLE), ['test', '--session', 'alpha']);
  });
});

describe("planSlash over the CLI's own table", () => {
  it('runs these reads as the tab session at once', () => {
    assert.deepEqual(sessionReads(COMMAND_TABLE), ['list', 'show', 'check', 'plan', 'verify', 'stats', 'report done', 'goal list', 'goal show', 'inbox status', 'rules', 'meeting list', 'decisions', 'schedule']);
    assert.deepEqual(sessionReads(TABLE), ['list']);
  });

  it('plans every command by its effect: filled when it takes --session, as typed when not, never run when internal', () => {
    for (const [command, effect] of Object.entries(COMMAND_EFFECTS)) {
      const argv = command.split(' ');
      const plan = planSlash(argv, COMMAND_TABLE);
      if (effect === 'internal') {
        assert.deepEqual(plan, { kind: 'internal', command }, command);
      } else if ((COMMAND_FLAGS[command] ?? []).includes('session')) {
        assert.deepEqual(plan, { kind: 'fill', command, argv, effect }, command);
      } else {
        assert.deepEqual(plan, { kind: 'as-typed', argv, effect }, command);
      }
    }
  });
});
