import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUse } from './line.ts';
import { NO_TURN, parseOpenTurn, TASKS_PER_TURN, tasksNamedBy, TurnTasks } from './tasks.ts';

function bash(command: string): ToolUse {
  return { id: 'toolu_1', name: 'Bash', command };
}

function edit(path: string): ToolUse {
  return { id: 'toolu_2', name: 'Edit', command: undefined, path };
}

/** A turn whose released W is recorded as `day task w` lines. */
function recordedTurn(turn = NO_TURN): { readonly turn: TurnTasks; readonly charges: string[] } {
  const charges: string[] = [];
  return { turn: new TurnTasks(turn, (day, task, w) => charges.push(`${day} ${task} ${w}`)), charges };
}

describe('tasksNamedBy', () => {
  it('reads T<n> in a command and t<n>- in a command or a path, in order and once each', () => {
    const tools = [bash('teamrig set T734 --status done && git commit -m "x (T649)"'), bash('git -C .worktrees/t740-kinds log'), edit('C:/p/.worktrees/t734-task-meter/src/a.ts')];
    assert.deepEqual(tasksNamedBy(tools), ['T734', 'T649', 'T740']);
  });

  it('names no task in a time, a variable, a word or a T without digits', () => {
    const tools = [bash('date -d 2026-10-20T12:00Z; T=bin/teamrig; $T list; echo T0 AT1 tests-T7x'), edit('/p/src/budget/t1x-not.ts')];
    assert.deepEqual(tasksNamedBy(tools), []);
  });

  it('reads no T<n> in a path, where a file like T5.md is no task', () => {
    assert.deepEqual(tasksNamedBy([edit('/notes/T5.md')]), []);
  });
});

describe('TurnTasks', () => {
  it('holds the W per day until the next prompt, then splits all of it equally over the tasks the turn named', () => {
    const { turn, charges } = recordedTurn();
    turn.charged('2026-10-20', 30);
    turn.named([bash('teamrig show T1'), bash('teamrig show T2 T1')]);
    turn.charged('2026-10-21', 10);
    assert.deepEqual(charges, []);
    assert.deepEqual(turn.state(), { tasks: ['T1', 'T2'], held: { '2026-10-20': 30, '2026-10-21': 10 } });
    turn.prompt();
    assert.deepEqual(charges, ['2026-10-20 T1 15', '2026-10-20 T2 15', '2026-10-21 T1 5', '2026-10-21 T2 5']);
    assert.deepEqual(turn.state(), NO_TURN);
  });

  it('leaves the W of a turn that named no task unattributed', () => {
    const { turn, charges } = recordedTurn();
    turn.charged('2026-10-20', 30);
    turn.prompt();
    assert.deepEqual(charges, []);
    assert.deepEqual(turn.state(), NO_TURN);
  });

  it('goes on with a stored open turn', () => {
    const { turn, charges } = recordedTurn({ tasks: ['T3'], held: { '2026-10-20': 8 } });
    turn.charged('2026-10-20', 4);
    turn.prompt();
    assert.deepEqual(charges, ['2026-10-20 T3 12']);
  });

  it('keeps the first TASKS_PER_TURN tasks a turn names', () => {
    const { turn } = recordedTurn();
    turn.named([bash(Array.from({ length: TASKS_PER_TURN + 3 }, (_, index) => `T${index + 1}`).join(' '))]);
    assert.equal(turn.state().tasks.length, TASKS_PER_TURN);
    assert.equal(turn.state().tasks.at(-1), `T${TASKS_PER_TURN}`);
  });
});

describe('parseOpenTurn', () => {
  it('round-trips a turn', () => {
    const turn = { tasks: ['T1', 'T22'], held: { '2026-10-20': 1.5 } };
    assert.deepEqual(parseOpenTurn(JSON.parse(JSON.stringify(turn))), turn);
  });

  it('refuses a damaged turn', () => {
    const damaged: readonly unknown[] = [
      null,
      { tasks: 'T1', held: {} },
      { tasks: ['t1'], held: {} },
      { tasks: ['T1', 'T1'], held: {} },
      { tasks: Array.from({ length: TASKS_PER_TURN + 1 }, (_, index) => `T${index + 1}`), held: {} },
      { tasks: [], held: [] },
      { tasks: [], held: { today: 1 } },
      { tasks: [], held: { '2026-10-20': -1 } },
    ];
    for (const value of damaged) {
      assert.equal(parseOpenTurn(value), undefined, JSON.stringify(value));
    }
  });
});
