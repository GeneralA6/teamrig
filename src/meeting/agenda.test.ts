import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AskWith } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { AGENDA_ROWS, agendaLines, agendaSince, cardFacts, DESCRIPTION_CHARS, DONE_WINDOW_DAYS, oneLine, type AgendaInput, type AgendaTeam } from './agenda.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function treeOf(tasks: readonly Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC);
}

function inputOf(tasks: readonly Task[], since = NOW - MS_PER_DAY, requireGate = true, below: readonly AgendaTeam[] = [], askWith: AskWith = 'text'): AgendaInput {
  return {
    tasks,
    tree: treeOf(tasks),
    now: NOW,
    since,
    ownerMarker: 'owner',
    requireGate,
    below,
    lead: 'lead',
    command: 'teamrig',
    askWith,
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
  card: TEST_OWNER_CARD,
});

/** A wait on the owner's decision whose card names no gate (T1194). */
const UNGATED = testTask({ id: 'T6', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD });

describe('the meeting agenda', () => {
  it('starts the finished work at the meeting before, else a day back, and never past the window', () => {
    assert.equal(agendaSince(undefined, NOW), NOW - MS_PER_DAY);
    assert.equal(agendaSince(NOW - 3 * MS_PER_DAY, NOW), NOW - 3 * MS_PER_DAY);
    assert.equal(agendaSince(NOW - 30 * MS_PER_DAY, NOW), NOW - DONE_WINDOW_DAYS * MS_PER_DAY);
  });

  it('puts text on one line', () => {
    assert.equal(oneLine(' a\n  b\tc '), 'a b c');
  });

  it("gives each owner's decision its card facts, then how to card, ask about and record it", () => {
    const lines = section(agendaLines(inputOf([DECIDE, testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] })])), 'DECISIONS');
    assert.deepEqual(lines.slice(0, 11), [
      'DECISIONS 2 waiting on owner (decision or approval)',
      '  T4 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner)',
      '    what and why: Which tier ships first. The launch waits on it.',
      '    decide: Which pricing tier ships first',
      '    gate: budget',
      '      1. Basic at 9 dollars a month',
      '      2. Pro at 29 dollars a month',
      '    recommended: Basic, the cheaper launch',
      '    with no answer: Basic ships on the due date',
      '    waiting since 01-07 15:30 UTC: two options, numbers in the card',
      '    asked at: issue 12',
    ]);
    assert.deepEqual(lines.slice(11, 14), [
      '  T5 waiting, p2, owner alpha | Add a health check (waiting: approval owner)',
      '    no card yet: ask alpha for one (check flags it NO-CARD)',
      '    waiting since 01-07 09:00 UTC',
    ]);
    assert.match(lines[14] ?? '', /^ {2}Read each card to owner as it stands, .*Never point to a doc; `teamrig show <id>` prints a task whole\.$/);
    // T1278: by default the owner answers in plain text, never through the picker.
    assert.equal(
      lines[15],
      "  Ask in plain text, never with the question picker: each card's options numbered, your recommendation first; owner answers in their own words.",
    );
    // T737: the owner's follow-up question goes to the task's owner, not to the lead's own research.
    assert.equal(
      lines[16],
      "  A question a card does not answer is its task owner's to find: teamrig add --owner <id> --due <date> --session lead, then relay the answer; never look it up yourself.",
    );
    assert.equal(lines[17], '  Record each answer in the same turn: teamrig update <id> --note "owner decided: <decision>" --session lead; meeting end tells each task\'s owner.');
    // T1295: a card the owner puts off is recorded with --later, in place of an answer.
    assert.equal(lines[18], '  A card owner puts off to a date: teamrig update <id> --later <date> --note "owner put it off: <why>" --session lead; it waits in LATER until then.');
    assert.equal(lines.length, 19);
  });

  // T1278: a team that asks for the picker (decisions.askWith: picker) gets it named instead of plain text.
  it('tells the lead to ask the choices with the question picker when the team asks with it', () => {
    const lines = section(agendaLines(inputOf([DECIDE], NOW - MS_PER_DAY, true, [], 'picker')), 'DECISIONS');
    const asks = lines.filter((line) => line.startsWith('  Ask '));
    assert.deepEqual(asks, ["  Ask the choices with the question picker (AskUserQuestion), at most 4 a call: each card's options as its choices, your recommendation first."]);
  });

  // T1018: a child team's waits on the owner go up to the lead at its tree's root, who reads them after its own.
  it("lists the decisions of each team under the lead's after its own, by <team>/<id>, and how to ask and record them there", () => {
    const decide = testTask({ id: 'T7', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD });
    const ungated = { ...UNGATED, id: 'T8' };
    const web: AgendaTeam = { team: 'web', tasks: [decide, ungated], tree: treeOf([decide, ungated]), ownerMarker: 'owner', requireGate: true };
    const lines = section(agendaLines(inputOf([DECIDE], NOW - MS_PER_DAY, true, [web])), 'DECISIONS');
    assert.equal(lines[0], 'DECISIONS 2 waiting on owner (decision or approval)');
    const rows = lines.filter((line) => /^ {2}\S+ waiting, /.test(line));
    assert.deepEqual(rows, ['  T4 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner)', '  web/T7 waiting, p2, owner alpha | Add a health check (waiting: decision owner)']);
    assert.ok(!lines.some((line) => /\bT8\b/.test(line)), 'an ungated wait of a team that requires gates stays out');
    assert.equal(
      lines.at(-3),
      "  A question a card does not answer is its task owner's to find: teamrig add --owner <id> (and --team <team> for a team under yours) --due <date> --session lead, then relay the answer; never look it up yourself.",
    );
    assert.equal(
      lines.at(-2),
      '  Record each answer in the same turn: teamrig update <id> (<team>/<id> for a task of a team under yours, as its row names it) --note "owner decided: <decision>" --session lead; meeting end tells each task\'s owner.',
    );
  });

  it("counts a team under the lead's alone when the lead's own team waits on nothing", () => {
    const decide = testTask({ id: 'T7', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] });
    const web: AgendaTeam = { team: 'web', tasks: [decide], tree: treeOf([decide]), ownerMarker: 'owner', requireGate: true };
    const lines = section(agendaLines(inputOf([testTask()], NOW - MS_PER_DAY, true, [web])), 'DECISIONS');
    assert.equal(lines[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.match(lines[1] ?? '', /^ {2}web\/T7 waiting, /);
  });

  // T1219: an ungated wait is its session's or its leader's, so the lead never reads it to the owner.
  it("moves a wait on the owner's decision whose card names no gate out of DECISIONS, into UNGATED with whose it is", () => {
    const all = agendaLines(inputOf([DECIDE, UNGATED]));
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!section(all, 'DECISIONS').some((line) => /\bT6\b/.test(line)), all.join('\n'));
    assert.deepEqual(section(all, 'UNGATED'), [
      "UNGATED 1 waiting on owner's decision with no gate: never read to owner",
      '  T6 waiting, p2, owner alpha | Add a health check (waiting: decision owner)',
      `  Each is its session's or its leader's to decide: decide those of the sessions you lead and send each its answer as an inbox line; where an owner gate or a business decision does apply, its owner sets it again with --gate "<the owner gate, or business>".`,
    ]);
  });

  it('lists at most a screen of ungated waits, then the command for all', () => {
    const ungated = Array.from({ length: AGENDA_ROWS + 1 }, (_, index) => ({ ...UNGATED, id: `T${index + 10}` }));
    const lines = section(agendaLines(inputOf(ungated)), 'UNGATED');
    assert.equal(lines[0], `UNGATED ${AGENDA_ROWS + 1} waiting on owner's decision with no gate: never read to owner`);
    assert.equal(lines.at(-2), '  +1 more: teamrig check');
  });

  it('keeps an ungated wait in DECISIONS while gates are not required', () => {
    const all = agendaLines(inputOf([DECIDE, UNGATED], NOW - MS_PER_DAY, false));
    assert.equal(all[0], 'DECISIONS 2 waiting on owner (decision or approval)');
    assert.ok(!all.some((line) => line.startsWith('UNGATED')), all.join('\n'));
  });

  // T1295: a card the owner put off waits on a time beside the owner, and comes back once that time passed.
  it('moves a card the owner put off out of DECISIONS, into LATER with its time, own team first', () => {
    const later = { ...DECIDE, id: 'T9', waits: [...DECIDE.waits, { kind: 'time' as const, at: '2030-01-09 12:00' }] };
    const webLater = { ...later, id: 'T7' };
    const web: AgendaTeam = { team: 'web', tasks: [webLater], tree: treeOf([webLater]), ownerMarker: 'owner', requireGate: true };
    const all = agendaLines(inputOf([DECIDE, later], NOW - MS_PER_DAY, true, [web]));
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!section(all, 'DECISIONS').some((line) => /\bT[79]\b/.test(line)), all.join('\n'));
    assert.deepEqual(section(all, 'LATER'), [
      'LATER 2 put off by owner: asked once their time passed, never read out before',
      '  T9 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner · until Wed 01-09 12:00 UTC)',
      '  web/T7 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner · until Wed 01-09 12:00 UTC)',
    ]);
    const heads = all.filter((line) => /^[A-Z]+ /.test(line)).map((line) => line.split(' ')[0]);
    assert.deepEqual(heads, ['DECISIONS', 'LATER', 'LATE', 'DONE']);
  });

  it('asks a card put off once its time passed, and shows no LATER block then', () => {
    const back = { ...DECIDE, id: 'T9', waits: [...DECIDE.waits, { kind: 'time' as const, at: '2030-01-08 09:00' }] };
    const all = agendaLines(inputOf([back]));
    assert.equal(all[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!all.some((line) => line.startsWith('LATER')), all.join('\n'));
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
      'DONE 0 done, 0 dropped since Mon 01-07 10:00 UTC',
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

  it('groups the work done since the start, with other work and the dropped as one count line each, and not the work before it', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'done', statusAt: '2030-01-08T08:00:00.000Z' }),
      testTask({ id: 'T2', status: 'dropped', statusAt: '2030-01-07T11:00:00.000Z' }),
      testTask({ id: 'T3', status: 'done', statusAt: '2030-01-06T11:00:00.000Z', source: 'owner' }),
      testTask({ id: 'T4', status: 'done', statusAt: '2030-01-08T07:00:00.000Z', source: 'owner', goals: ['A1'] }),
      testTask({ id: 'T5', status: 'done', statusAt: '2030-01-08T06:00:00.000Z', goals: ['A1'] }),
      testTask({ id: 'T6', status: 'done', statusAt: '2030-01-08T05:00:00.000Z', priority: 1 }),
      testTask({ id: 'T7', status: 'done', statusAt: '2030-01-08T04:00:00.000Z', week: '2030-01-07' }),
      testTask({ id: 'T8', status: 'verifying', statusAt: '2030-01-08T04:00:00.000Z', source: 'owner' }),
    ];
    const lines = section(agendaLines(inputOf(tasks)), 'DONE');
    assert.deepEqual(
      lines.map((line) => line.replace(/^( {4}T\d+) .*/, '$1')),
      [
        'DONE 5 done, 1 dropped since Mon 01-07 10:00 UTC',
        '  Owner asked (1)',
        '    T4',
        '  A1 (1)',
        '    T5',
        '  Urgent p1 (1)',
        '    T6',
        "  This week's plan (1)",
        '    T7',
        '  Other work 1: teamrig list --status done',
        '  Dropped 1: teamrig list --status dropped',
      ],
    );
    assert.match(lines[2] ?? '', /^ {4}T4 done, p2, owner alpha \| Add a health check/);
  });

  it('lists at most a screen of rows in a group, then the command for all', () => {
    const urgent = Array.from({ length: AGENDA_ROWS + 2 }, (_, index) => testTask({ id: `T${index + 10}`, status: 'done', priority: 1, statusAt: '2030-01-08T09:00:00.000Z' }));
    const lines = section(agendaLines(inputOf(urgent)), 'DONE');
    assert.equal(lines[1], `  Urgent p1 (${AGENDA_ROWS + 2})`);
    assert.equal(lines.length, 2 + AGENDA_ROWS + 1);
    assert.equal(lines.at(-1), '    +2 more: teamrig list --status done');
  });
});

describe('the meeting agenda: no task number stands alone', () => {
  it('names each other task a decision names by its title', () => {
    const naming: Task = { ...DECIDE, card: { ...TEST_OWNER_CARD, recommend: 'Basic, as T2 already shipped it' }, note: 'T2 and T9 both matter' };
    const lines = section(agendaLines(inputOf([naming, testTask({ id: 'T2', title: 'Ship the basic tier' })])), 'DECISIONS');
    assert.deepEqual(
      lines.filter((line) => /^ {4}T\d+: /.test(line)),
      ['    T2: Ship the basic tier', '    T9: not in the working set'],
    );
  });

  it("names another team's task and the tasks it names by their team, from that team's register", () => {
    const naming: Task = { ...DECIDE, card: null, note: 'T2 and T9 both matter' };
    const tasks = [naming, testTask({ id: 'T2', title: 'Ship the basic tier' })];
    const lines = cardFacts(naming, inputOf(tasks).tree, 'web');
    assert.match(lines[0] ?? '', /^ {2}web\/T4 waiting, p2, owner alpha \| Pick the pricing tier/);
    assert.ok(lines.includes("    no card yet: alpha owes one, and team web's check flags it NO-CARD to its lead"), lines.join('\n'));
    assert.deepEqual(
      lines.filter((line) => /^ {4}web\/T\d+: /.test(line)),
      ['    web/T2: Ship the basic tier', '    web/T9: not in the working set'],
    );
  });
});
