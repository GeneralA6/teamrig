import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../register/fold.ts';
import { TaskTree, type TreeRanking } from '../register/tree.ts';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { blockStartLines, COMPACT_SOURCE, LIVE_TASK_ROWS, LIVE_TITLE_CHARS, LIVE_WAITING_ROWS, liveTasksNote, liveTasksPointer, showsLiveTasks } from './live-tasks.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = new Date('2030-01-08T10:00:00.000Z');
const HEAD = 'LIVE TASKS of alpha, read from the register at this start';
const WINS = 'where your handover or a compaction summary says otherwise, the register wins';

/** The block for alpha over `tasks`, judged at NOW against those same tasks, ranked by `ranking` when given. */
function noteOf(tasks: readonly Task[], ranking?: TreeRanking): string {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const tree = new TaskTree(byId, NOW, TimeZone.UTC, undefined, undefined, ranking);
  return liveTasksNote({ tasks, owner: 'alpha', tree, command: 'teamrig' });
}

describe('showsLiveTasks', () => {
  it('shows the block at the fresh start of a refresh and after a compaction, at no other start', () => {
    assert.equal(COMPACT_SOURCE, 'compact');
    assert.equal(showsLiveTasks('clear', true), true);
    assert.equal(showsLiveTasks('startup', true), true);
    assert.equal(showsLiveTasks('compact', false), true);
    for (const source of ['clear', 'startup', 'resume', undefined]) {
      assert.equal(showsLiveTasks(source, false), false, String(source));
    }
  });
});

describe('liveTasksPointer', () => {
  it('names the start command that lists the tasks, and that the register wins (T1376)', () => {
    assert.equal(liveTasksPointer('alpha', 'teamrig'), `LIVE TASKS of alpha: this start has no room for them; run \`teamrig start --session alpha\` first, and ${WINS}.`);
  });
});

describe('blockStartLines', () => {
  const START =
    "START alpha, Tue 01-08 10:00 UTC: this note is your work block's start, so run no `teamrig start` now; it would add only the check flags and the rest of the list (run it at your next work block).";
  const MEETINGS = 'MEETINGS today: M1 14:00 UTC alpha';
  const WEEK = 'Week: 40% used (metered). Resets Wed 01-09 01:00 UTC.';

  it("makes the note the work block's start with start's first line, then its meetings and week lines (T1529)", () => {
    assert.deepEqual(blockStartLines('alpha', { at: 'Tue 01-08 10:00 UTC', meetings: MEETINGS, week: WEEK }, 'teamrig'), [START, MEETINGS, WEEK]);
  });

  it('leaves out the meetings line when none is due today, and the week line when the week could not be read', () => {
    assert.deepEqual(blockStartLines('alpha', { at: 'Tue 01-08 10:00 UTC', meetings: undefined, week: WEEK }, 'teamrig'), [START, WEEK]);
    assert.deepEqual(blockStartLines('alpha', { at: 'Tue 01-08 10:00 UTC', meetings: MEETINGS, week: undefined }, 'teamrig'), [START, MEETINGS]);
    assert.deepEqual(blockStartLines('alpha', { at: 'Tue 01-08 10:00 UTC', meetings: undefined, week: undefined }, 'teamrig'), [START]);
  });
});

describe('liveTasksNote', () => {
  it('says none are active in one line when the owner has no open, started, verifying or waiting task', () => {
    const others = [
      testTask({ id: 'T1', status: 'done' }),
      testTask({ id: 'T2', status: 'dropped' }),
      testTask({ id: 'T3', owner: 'bravo', status: 'in-progress' }),
    ];
    assert.equal(noteOf(others), `${HEAD}: none active; ${WINS}.`);
    assert.equal(noteOf([]), `${HEAD}: none active; ${WINS}.`);
  });

  it('lists work in hand first, then what waits, then what is not started, each in plan order', () => {
    const tasks = [
      testTask({ id: 'T1', title: 'Open improvement', priority: 1 }),
      testTask({ id: 'T2', title: 'Open upkeep', priority: 2 }),
      testTask({ id: 'T3', title: 'Started', status: 'in-progress' }),
      testTask({ id: 'T4', title: 'Shipped', status: 'verifying', proof: 'the nightly run' }),
      testTask({ id: 'T5', title: 'Blocked', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] }),
    ];
    assert.equal(
      noteOf(tasks, testRanking({ classes: { T2: 'Maintenance' } })),
      [
        `${HEAD} (5 active; ${WINS}):`,
        '  T3 in-progress, Improvements, score 3.33, p2 | Started',
        '  T4 verifying, Improvements, score 3.33, p2 | Shipped',
        '  T5 waiting, Improvements, score 3.33, p2 | Blocked (waiting: decision owner)',
        '  T2 open, Maintenance, score 33.33, p2 | Open upkeep',
        '  T1 open, Improvements, score 3.33, p1 | Open improvement',
      ].join('\n'),
    );
  });

  it('names the effective due date, with the task it comes from, and only the plan dependencies still unfinished', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'done' }),
      testTask({ id: 'T2', title: 'First' }),
      testTask({ id: 'T3', title: 'Then this', due: '2030-01-15', after: ['T1', 'T2'] }),
      testTask({ id: 'T4', title: 'Late on my own', due: '2030-01-20' }),
    ];
    assert.deepEqual(noteOf(tasks).split('\n').slice(1), [
      '  T2 open, p2, due 01-15 (from T3) | First',
      '  T3 open, p2, due 01-15, after T2 | Then this',
      '  T4 open, p2, due 01-20 | Late on my own',
    ]);
  });

  it('lists the tasks of other sessions waiting on the owner, at most LIVE_WAITING_ROWS, also when the owner holds none active', () => {
    assert.equal(LIVE_WAITING_ROWS, 3);
    const mine = testTask({ id: 'T1', title: 'Mine' });
    const asks = [{ kind: 'decision' as const, who: 'alpha' }];
    const needers = Array.from({ length: LIVE_WAITING_ROWS + 1 }, (_, index) => testTask({ id: `T${index + 2}`, owner: 'bravo', title: 'Theirs', after: ['T1'] }));
    const lines = noteOf([mine, ...needers]).split('\n');
    assert.equal(lines[2], `WAITING ON YOU ${LIVE_WAITING_ROWS + 1} task(s) of other sessions:`);
    assert.match(lines[3] ?? '', /^ {2}T2 .*\| Theirs · needs your T1$/);
    assert.equal(lines.length, 3 + LIVE_WAITING_ROWS + 1);
    assert.equal(lines.at(-1), '  +1 more: `teamrig start --session alpha --all`');
    const decided = testTask({ id: 'T7', owner: 'bravo', title: 'Asks me', status: 'waiting', waits: asks });
    assert.deepEqual(noteOf([decided]).split('\n').slice(1, 2), ['WAITING ON YOU 1 task(s) of other sessions:']);
    assert.match(noteOf([decided]).split('\n')[0] ?? '', /: none active; /);
    assert.match(noteOf([decided]), /\| Asks me \(waiting: decision alpha\) · waits on your decision$/);
  });

  it('marks the ready wait reasons, and shows the note of a waiting task with no reasons', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'done' }),
      testTask({ id: 'T2', title: 'Waits on two', status: 'waiting', waits: [{ kind: 'task', id: 'T1' }, { kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T3', title: 'Old wait', status: 'waiting', note: `the vendor answers ${'x'.repeat(80)}` }),
      testTask({ id: 'T4', title: 'Bare wait', status: 'waiting' }),
    ];
    const rows = noteOf(tasks).split('\n');
    assert.equal(rows[1], '  T2 waiting, p2 | Waits on two (waiting: on T1 ready · approval lead)');
    assert.equal(rows[2], `  T3 waiting, p2 | Old wait (waiting: the vendor answers ${'x'.repeat(40)}…)`);
    assert.equal(rows[3], '  T4 waiting, p2 | Bare wait');
  });

  it('cuts a long title, and caps the rows with a line naming the command that lists the rest', () => {
    assert.equal(LIVE_TASK_ROWS, 6);
    assert.equal(LIVE_TITLE_CHARS, 60);
    const tasks = Array.from({ length: LIVE_TASK_ROWS + 3 }, (_, index) => testTask({ id: `T${index + 1}`, title: 'y'.repeat(70) }));
    const lines = noteOf(tasks).split('\n');
    assert.equal(lines[0], `${HEAD} (9 active; ${WINS}):`);
    assert.equal(lines.length, 1 + LIVE_TASK_ROWS + 1);
    assert.equal(lines[1], `  T1 open, p2 | ${'y'.repeat(LIVE_TITLE_CHARS - 1)}…`);
    assert.equal(lines.at(-1), '  +3 more: `teamrig list --session alpha`');
  });
});
