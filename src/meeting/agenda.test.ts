import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { testTask } from '../testing/task.ts';
import { AGENDA_ROWS, agendaLines, agendaSince, DESCRIPTION_CHARS, DONE_WINDOW_DAYS, oneLine, waitsOnOwner, type AgendaInput } from './agenda.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function inputOf(tasks: readonly Task[], since = NOW - MS_PER_DAY): AgendaInput {
  return {
    tasks,
    tree: new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW)),
    now: NOW,
    since,
    ownerMarker: 'owner',
    lead: 'lead',
    command: 'teamrig',
  };
}

function section(lines: readonly string[], head: string): string[] {
  const from = lines.findIndex((line) => line.startsWith(head));
  const to = lines.findIndex((line, index) => index > from && /^[A-Z]+ /.test(line));
  return lines.slice(from, to === -1 ? undefined : to);
}

const DECIDE = testTask({
  id: 'T4',
  title: 'Pick the pricing tier',
  description: 'Which tier ships first.\nThe launch waits on it.',
  status: 'waiting',
  waits: [{ kind: 'decision', who: 'owner' }],
  note: 'two options, numbers in the card',
  statusAt: '2030-01-07T15:30:00.000Z',
  ref: 'issue 12',
});

describe('the meeting agenda', () => {
  it('starts the finished work at the meeting before, else a day back, and never past the window', () => {
    assert.equal(agendaSince(undefined, NOW), NOW - MS_PER_DAY);
    assert.equal(agendaSince(NOW - 3 * MS_PER_DAY, NOW), NOW - 3 * MS_PER_DAY);
    assert.equal(agendaSince(NOW - 30 * MS_PER_DAY, NOW), NOW - DONE_WINDOW_DAYS * MS_PER_DAY);
  });

  it("knows a task waiting on the owner's decision or approval, and no other wait", () => {
    assert.equal(waitsOnOwner(DECIDE, 'owner'), true);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] }), 'owner'), true);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'decision', who: 'alpha' }] }), 'owner'), false);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'task', id: 'T1' }] }), 'owner'), false);
    assert.equal(waitsOnOwner(testTask({ waits: [{ kind: 'decision', who: 'owner' }] }), 'owner'), false);
  });

  it('puts text on one line', () => {
    assert.equal(oneLine(' a\n  b\tc '), 'a b c');
  });

  it("gives each owner's decision its card facts, then how to card and record it", () => {
    const lines = section(agendaLines(inputOf([DECIDE, testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] })])), 'DECISIONS');
    assert.deepEqual(lines.slice(0, 5), [
      'DECISIONS 2 waiting on owner (decision or approval)',
      '  T4 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner)',
      '    what and why: Which tier ships first. The launch waits on it.',
      '    waiting since 01-07 15:30: two options, numbers in the card',
      '    asked at: issue 12',
    ]);
    assert.deepEqual(lines.slice(5, 7), ['  T5 waiting, p2, owner alpha | Add a health check (waiting: approval owner)', '    waiting since 01-07 09:00']);
    assert.match(lines[7] ?? '', /^ {2}Card each so owner decides from it alone: .*Never point to a doc; `teamrig show <id>` prints a task whole\.$/);
    assert.equal(lines[8], '  Record each answer in the same turn: teamrig update <id> --note "owner decided: <decision>" --session lead; meeting end tells each task\'s owner.');
    assert.equal(lines.length, 9);
  });

  it('cuts a long description', () => {
    const lines = agendaLines(inputOf([{ ...DECIDE, description: 'x'.repeat(DESCRIPTION_CHARS * 2) }]));
    const what = lines.find((line) => line.startsWith('    what and why: ')) ?? '';
    assert.equal([...what.slice('    what and why: '.length)].length, DESCRIPTION_CHARS);
  });

  it('says so when nothing waits on the owner, nothing is late and nothing finished', () => {
    assert.deepEqual(agendaLines(inputOf([testTask()])), [
      'DECISIONS 0 waiting on owner (decision or approval)',
      'LATE 0 past their due date',
      'DONE 0 done or dropped since Mon 01-07 10:00 UTC',
    ]);
  });

  it('lists the late active tasks, at most a screen of them, then the command for all', () => {
    const late = Array.from({ length: AGENDA_ROWS + 2 }, (_, index) => testTask({ id: `T${index + 1}`, due: '2030-01-07' }));
    const finishedLate = testTask({ id: 'T90', due: '2030-01-07', status: 'done', statusAt: '2030-01-08T09:00:00.000Z' });
    const notDue = testTask({ id: 'T91', due: '2030-01-09' });
    const lines = section(agendaLines(inputOf([...late, finishedLate, notDue])), 'LATE');
    assert.equal(lines[0], `LATE ${AGENDA_ROWS + 2} past their due date`);
    assert.equal(lines.length, 1 + AGENDA_ROWS + 1);
    assert.equal(lines.at(-1), '  +2 more: teamrig check');
    assert.ok(!lines.some((line) => /\bT9[01]\b/.test(line)), lines.join('\n'));
  });

  it('lists a task late by the due of a task that needs it', () => {
    const work = testTask({ id: 'T1' });
    const needer = testTask({ id: 'T2', owner: 'beta', due: '2030-01-07', after: ['T1'] });
    const lines = section(agendaLines(inputOf([work, needer])), 'LATE');
    assert.equal(lines[0], 'LATE 2 past their due date');
    assert.match(lines[1] ?? '', /^ {2}T1 .*due 01-07 \(from T2\)/);
  });

  it('lists the tasks done or dropped since the start, and not those before it', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'done', statusAt: '2030-01-08T08:00:00.000Z' }),
      testTask({ id: 'T2', status: 'dropped', statusAt: '2030-01-07T11:00:00.000Z' }),
      testTask({ id: 'T3', status: 'done', statusAt: '2030-01-06T11:00:00.000Z' }),
      ...Array.from({ length: AGENDA_ROWS }, (_, index) => testTask({ id: `T${index + 10}`, status: 'done', statusAt: '2030-01-08T09:00:00.000Z' })),
    ];
    const lines = section(agendaLines(inputOf(tasks)), 'DONE');
    assert.equal(lines[0], `DONE ${AGENDA_ROWS + 2} done or dropped since Mon 01-07 10:00 UTC`);
    assert.ok(!lines.some((line) => /\bT3\b/.test(line)), lines.join('\n'));
    assert.equal(lines.at(-1), '  +2 more: teamrig list --status done,dropped');
  });
});
