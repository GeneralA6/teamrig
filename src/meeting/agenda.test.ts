import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import type { GoalScore } from '../register/goal-board.ts';
import { ownSizing, treeRanking } from '../register/ranking.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { AGENDA_ROWS, agendaLines, askedDecisions, agendaSince, cardFacts, DESCRIPTION_CHARS, DONE_WINDOW_DAYS, oneLine, TEAM_ROWS, type AgendaInput, type AgendaTeam } from './agenda.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function treeOf(tasks: readonly Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC);
}

/** A tree that ranks its tasks, as a real read's does: the decisions' order and INCIDENTS read it. */
function rankedTreeOf(tasks: readonly Task[]): TaskTree {
  const ranking = treeRanking({ focus: DEFAULT_FOCUS, ownerSource: 'owner', goals: new Map(), sizing: ownSizing });
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC, null, undefined, ranking);
}

/** NOW is a Tuesday, so the default here is a day the Improvements batch is not asked. */
function inputOf(tasks: readonly Task[], since = NOW - MS_PER_DAY, requireGate = true, below: readonly AgendaTeam[] = []): AgendaInput {
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
    board: [],
    focus: DEFAULT_FOCUS,
    dedicatedOwners: [],
    improvementsDay: 'wed',
    runFiles: new Map(),
  };
}

function rankedInputOf(tasks: readonly Task[], below: readonly AgendaTeam[] = []): AgendaInput {
  return { ...inputOf(tasks, NOW - MS_PER_DAY, true, below), tree: rankedTreeOf(tasks) };
}

function teamOf(team: string, tasks: readonly Task[], tree = treeOf(tasks)): AgendaTeam {
  return { team, tasks, tree, ownerMarker: 'owner', requireGate: true, focus: DEFAULT_FOCUS, dedicatedOwners: [] };
}

/** The ids of a section's task rows, in order. */
function rowIds(lines: readonly string[]): string[] {
  return lines.flatMap((line) => /^ {2}(\S+) \w+, /.exec(line)?.[1] ?? []);
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
    const step = '/w/tasks/T4/grant-read.ps1';
    const handed: Task = { ...DECIDE, card: { ...TEST_OWNER_CARD, run: step }, audits: [{ path: step, sha256: 'c'.repeat(64), by: 'gamma', at: '2030-01-07T15:00:00.000Z' }] };
    const run = section(agendaLines({ ...inputOf([handed]), runFiles: new Map([[step, 'c'.repeat(64)]]) }), 'DECISIONS');
    assert.deepEqual(run.slice(8, 10), ['    with no answer: Basic ships on the due date', `    run: & '${step}'   (sha256 cccccccc, audited by gamma)`], 'the hand step file a card hands, after its default (T2312)');
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
    // T1366: an answer recorded with --decided drops the card's wait on the owner, so it leaves the agenda at once.
    assert.equal(
      lines[17],
      '  Record each answer in the same turn: teamrig update <id> --decided --note "owner decided: <decision>" --session lead; the card leaves the agenda, and meeting end tells each task\'s owner.',
    );
    // T1295: a card the owner puts off is recorded with --later, in place of an answer.
    assert.equal(lines[18], '  A card owner puts off to a date: teamrig update <id> --later <date> --note "owner put it off: <why>" --session lead; it waits in LATER until then.');
    assert.equal(lines.length, 19);
  });

  // T1018: a child team's waits on the owner go up to the lead at its tree's root, who reads them after its own.
  it("lists the decisions of each team under the lead's after its own, by <team>/<id>, and how to ask and record them there", () => {
    const decide = testTask({ id: 'T7', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD });
    const ungated = { ...UNGATED, id: 'T8' };
    const web = teamOf('web', [decide, ungated]);
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
      '  Record each answer in the same turn: teamrig update <id> (<team>/<id> for a task of a team under yours, as its row names it) --decided --note "owner decided: <decision>" --session lead; the card leaves the agenda, and meeting end tells each task\'s owner.',
    );
  });

  it("counts a team under the lead's alone when the lead's own team waits on nothing", () => {
    const decide = testTask({ id: 'T7', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] });
    const web = teamOf('web', [decide]);
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
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 2 waiting on owner (decision or approval)');
    assert.ok(!all.some((line) => line.startsWith('UNGATED')), all.join('\n'));
  });

  // T1295: a card the owner put off waits on a time beside the owner, and comes back once that time passed.
  it('moves a card the owner put off out of DECISIONS, into LATER with its time, own team first', () => {
    const later = { ...DECIDE, id: 'T9', waits: [...DECIDE.waits, { kind: 'time' as const, at: '2030-01-09 12:00' }] };
    const webLater = { ...later, id: 'T7' };
    const web = teamOf('web', [webLater]);
    const all = agendaLines(inputOf([DECIDE, later], NOW - MS_PER_DAY, true, [web]));
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!section(all, 'DECISIONS').some((line) => /\bT[79]\b/.test(line)), all.join('\n'));
    assert.deepEqual(section(all, 'LATER'), [
      'LATER 2 put off by owner: asked once their time passed, never read out before',
      '  T9 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner · until Wed 01-09 12:00 UTC)',
      '  web/T7 waiting, p2, owner alpha | Pick the pricing tier (waiting: decision owner · until Wed 01-09 12:00 UTC)',
    ]);
    const heads = all.filter((line) => /^[A-Z]+ /.test(line)).map((line) => line.split(' ')[0]);
    assert.deepEqual(heads, ['GOALS', 'DECISIONS', 'LATER', 'LATE', 'DONE']);
  });

  it('asks a card put off once its time passed, and shows no LATER block then', () => {
    const back = { ...DECIDE, id: 'T9', waits: [...DECIDE.waits, { kind: 'time' as const, at: '2030-01-08 09:00' }] };
    const all = agendaLines(inputOf([back]));
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!all.some((line) => line.startsWith('LATER')), all.join('\n'));
  });

  it('cuts a long description', () => {
    const lines = agendaLines(inputOf([{ ...DECIDE, description: 'x'.repeat(DESCRIPTION_CHARS * 2) }]));
    const what = lines.find((line) => line.startsWith('    what and why: ')) ?? '';
    assert.equal([...what.slice('    what and why: '.length)].length, DESCRIPTION_CHARS);
  });

  it('says so when nothing waits on the owner, nothing is late and nothing finished', () => {
    assert.deepEqual(agendaLines(inputOf([testTask()])), [
      'GOALS none ranked: teamrig goal rank <tag> <n> --session lead',
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

describe('the meeting agenda: LATE and DONE over the teams under the lead (T2457)', () => {
  const lateOf = (count: number): Task[] => Array.from({ length: count }, (_, index) => testTask({ id: `T${index + 1}`, due: '2030-01-07' }));
  const doneOf = (count: number): Task[] =>
    Array.from({ length: count }, (_, index) => testTask({ id: `T${index + 1}`, status: 'done', priority: 1, statusAt: '2030-01-08T09:00:00.000Z' }));

  it("lists each team's late tasks after the lead's own by <team>/<id>, and counts them all in the head", () => {
    const lines = section(agendaLines(inputOf(lateOf(1), NOW - MS_PER_DAY, true, [teamOf('web', lateOf(2))])), 'LATE');
    assert.equal(lines[0], 'LATE 3 past their due date');
    assert.deepEqual(rowIds(lines), ['T1', 'web/T1', 'web/T2']);
  });

  it('collapses a team past the cap to one count line naming the command for all, and leaves out a team with none late', () => {
    const below = [teamOf('web', lateOf(TEAM_ROWS + 1)), teamOf('ledger', [testTask({ id: 'T1' })]), teamOf('pricing', lateOf(TEAM_ROWS))];
    const lines = section(agendaLines(inputOf([], NOW - MS_PER_DAY, true, below)), 'LATE');
    assert.equal(lines[0], `LATE ${2 * TEAM_ROWS + 1} past their due date`);
    assert.equal(lines[1], `  web: ${TEAM_ROWS + 1} late: teamrig check --tree`);
    assert.deepEqual(rowIds(lines.slice(2)), lateOf(TEAM_ROWS).map((task) => `pricing/${task.id}`));
    assert.equal(lines.length, 2 + TEAM_ROWS);
  });

  it("lists each team's finished work after the lead's own: its counts, then its grouped rows by <team>/<id>, with other work only counted", () => {
    const other = testTask({ id: 'T9', status: 'done', statusAt: '2030-01-08T08:00:00.000Z' });
    const dropped = testTask({ id: 'T8', status: 'dropped', statusAt: '2030-01-08T08:00:00.000Z' });
    const lines = section(agendaLines(inputOf(doneOf(1), NOW - MS_PER_DAY, true, [teamOf('web', [...doneOf(2), other, dropped])])), 'DONE');
    assert.deepEqual(
      lines.map((line) => line.replace(/^( {4}\S+) .*/, '$1')),
      [
        'DONE 4 done, 1 dropped since Mon 01-07 10:00 UTC',
        '  Urgent p1 (1)',
        '    T1',
        '  web: 3 done, 1 dropped: teamrig list --tree --status done',
        '    web/T1',
        '    web/T2',
      ],
    );
  });

  it('shows a team past the cap as its count line alone, and no line for a team that finished nothing', () => {
    const below = [teamOf('web', doneOf(TEAM_ROWS + 1)), teamOf('ledger', [testTask({ id: 'T1' })])];
    const lines = section(agendaLines(inputOf([], NOW - MS_PER_DAY, true, below)), 'DONE');
    assert.deepEqual(lines, [`DONE ${TEAM_ROWS + 1} done, 0 dropped since Mon 01-07 10:00 UTC`, `  web: ${TEAM_ROWS + 1} done, 0 dropped: teamrig list --tree --status done`]);
  });
});

describe('the meeting agenda: the goal scoreboard (T2092)', () => {
  const GOAL: GoalScore = { tag: 'A1', title: 'Ship the beta', rank: 1, target: '2030-02-01', done: 1, total: 3, spentPct: 1.2, sizePct: 4, slips: 2, overdue: 1, waiting: ['T4', 'web/T7'] };

  it('opens with a row per ranked goal: done, spend against size, risk and what waits', () => {
    const all = agendaLines({ ...inputOf([]), board: [GOAL, { ...GOAL, tag: 'B1', title: 'Docs\nsite', rank: 2, slips: 1, overdue: 0, waiting: [] }] });
    assert.deepEqual(section(all, 'GOALS'), [
      'GOALS 2 ranked, best first: done, spend against size, risk, what waits',
      '  #1 A1 Ship the beta (target 2030-02-01): 1/3 done, spent 1.2% of 4.0% sized, 2 slips, 1 overdue, 2 waiting: T4, web/T7',
      '  #2 B1 Docs site (target 2030-02-01): 1/3 done, spent 1.2% of 4.0% sized, 1 slip, 0 overdue, 0 waiting',
    ]);
    assert.equal(all[0], 'GOALS 2 ranked, best first: done, spend against size, risk, what waits');
  });

  it('lists at most a screen of goals, then the command for all', () => {
    const board = Array.from({ length: AGENDA_ROWS + 1 }, (_, index) => ({ ...GOAL, rank: index + 1 }));
    const lines = section(agendaLines({ ...inputOf([]), board }), 'GOALS');
    assert.equal(lines.length, 1 + AGENDA_ROWS + 1);
    assert.equal(lines.at(-1), '  +1 more: teamrig goal list');
  });
});

describe('the meeting agenda: decisions by what they unblock (T2092)', () => {
  const IMPROVEMENT = { ...DECIDE, id: 'T9', workClass: 'Improvements' };

  it('asks a decision that frees Roadmap work ahead of one that frees nothing', () => {
    const plain = { ...DECIDE, id: 'T1', workClass: 'Maintenance' };
    const freeing = { ...DECIDE, id: 'T2', workClass: 'Maintenance' };
    const freed = testTask({ id: 'T3', workClass: 'Roadmap', after: ['T2'] });
    assert.deepEqual(rowIds(section(agendaLines(rankedInputOf([plain, freeing, freed])), 'DECISIONS')), ['T2', 'T1']);
  });

  it('merges the teams under the lead into the one ranked list', () => {
    const own = { ...DECIDE, id: 'T1', workClass: 'Maintenance' };
    const roadmap = { ...DECIDE, id: 'T7', workClass: 'Roadmap' };
    const web = teamOf('web', [roadmap], rankedTreeOf([roadmap]));
    assert.deepEqual(rowIds(section(agendaLines(rankedInputOf([own], [web])), 'DECISIONS')), ['web/T7', 'T1']);
  });

  it('asks the Improvements batch on its day, after the daily cards, and counts it in the head', () => {
    const tuesday: AgendaInput = { ...inputOf([IMPROVEMENT, DECIDE]), improvementsDay: 'tue' };
    const lines = section(agendaLines(tuesday), 'DECISIONS');
    assert.equal(lines[0], 'DECISIONS 2 waiting on owner (decision or approval)');
    assert.deepEqual(rowIds(lines), ['T4', 'T9']);
    const batch = lines.indexOf('  Improvements batch 1, weekly, after the daily cards:');
    assert.ok(batch > lines.findIndex((line) => line.startsWith('  T4 ')), lines.join('\n'));
    assert.ok(batch < lines.findIndex((line) => line.startsWith('  T9 ')), lines.join('\n'));
  });

  it('shows the batch nowhere on any other day', () => {
    const all = agendaLines(inputOf([IMPROVEMENT, DECIDE]));
    assert.equal(section(all, 'DECISIONS')[0], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!all.some((line) => /\bT9\b|Improvements batch/.test(line)), all.join('\n'));
  });

  it('prints no how-to lines when the batch was all there was to ask', () => {
    assert.deepEqual(section(agendaLines(inputOf([IMPROVEMENT])), 'DECISIONS'), ['DECISIONS 0 waiting on owner (decision or approval)']);
  });

  it('hands the asked cards out in the agenda order, the batch apart and only on its day (T2512)', () => {
    const own = { ...DECIDE, id: 'T1', workClass: 'Maintenance' };
    const roadmap = { ...DECIDE, id: 'T7', workClass: 'Roadmap' };
    const below = [teamOf('web', [roadmap], rankedTreeOf([roadmap]))];
    const ids = (cards: readonly { readonly task: Task; readonly team: string | undefined }[]): string[] =>
      cards.map((card) => (card.team === undefined ? card.task.id : `${card.team}/${card.task.id}`));
    const tuesday = askedDecisions({ ...rankedInputOf([own, IMPROVEMENT], below), improvementsDay: 'tue' });
    assert.deepEqual(ids(tuesday.daily), ['web/T7', 'T1']);
    assert.deepEqual(ids(tuesday.batch), ['T9']);
    assert.deepEqual(askedDecisions(rankedInputOf([own, IMPROVEMENT], below)).batch, []);
  });

  it("names no team in the how-to lines when a team's only decision waits for the batch", () => {
    const hidden = { ...IMPROVEMENT, id: 'T7' };
    const lines = section(agendaLines(inputOf([DECIDE], NOW - MS_PER_DAY, true, [teamOf('web', [hidden])])), 'DECISIONS');
    assert.ok(!lines.some((line) => /<team>/.test(line)), lines.join('\n'));
  });
});

describe('the meeting agenda: INCIDENTS (T2092)', () => {
  const BUG = testTask({ id: 'T1', type: 'bug', workClass: 'Maintenance' });

  it('lists the active Maintenance bugs and critical tasks after the decisions, the own team first', () => {
    const critical = testTask({ id: 'T2', critical: true, workClass: 'Maintenance' });
    const webBug = { ...BUG, id: 'T7' };
    const web = teamOf('web', [webBug], rankedTreeOf([webBug]));
    const all = agendaLines(rankedInputOf([BUG, critical], [web]));
    const lines = section(all, 'INCIDENTS');
    assert.equal(lines[0], 'INCIDENTS 3 active Maintenance bugs or critical tasks');
    assert.deepEqual(rowIds(lines).sort(), ['T1', 'T2', 'web/T7']);
    assert.equal(rowIds(lines).at(-1), 'web/T7');
    assert.deepEqual(
      all.filter((line) => /^[A-Z]+ /.test(line)).map((line) => line.split(' ')[0]),
      ['GOALS', 'DECISIONS', 'INCIDENTS', 'LATE', 'DONE'],
    );
  });

  it('leaves out other classes, plain Maintenance work and finished bugs, and shows no block with none', () => {
    const tasks = [
      { ...BUG, id: 'T1', workClass: 'Improvements' },
      testTask({ id: 'T2', workClass: 'Maintenance' }),
      { ...BUG, id: 'T3', status: 'done' as const, statusAt: '2030-01-08T09:00:00.000Z' },
    ];
    const all = agendaLines(rankedInputOf(tasks));
    assert.ok(!all.some((line) => line.startsWith('INCIDENTS')), all.join('\n'));
  });

  it('lists at most a screen of incidents, then the command for all', () => {
    const bugs = Array.from({ length: AGENDA_ROWS + 1 }, (_, index) => ({ ...BUG, id: `T${index + 10}` }));
    const lines = section(agendaLines(rankedInputOf(bugs)), 'INCIDENTS');
    assert.equal(lines.length, 1 + AGENDA_ROWS + 1);
    assert.equal(lines.at(-1), '  +1 more: teamrig list --tree');
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
    const lines = cardFacts(naming, inputOf(tasks).tree, new Map(), 'web');
    assert.match(lines[0] ?? '', /^ {2}web\/T4 waiting, p2, owner alpha \| Pick the pricing tier/);
    assert.ok(lines.includes("    no card yet: alpha owes one, and team web's check flags it NO-CARD to its lead"), lines.join('\n'));
    assert.deepEqual(
      lines.filter((line) => /^ {4}web\/T\d+: /.test(line)),
      ['    web/T2: Ship the basic tier', '    web/T9: not in the working set'],
    );
  });
});

describe('the meeting agenda: DEDICATED (T868)', () => {
  /** A decision in a core-business area: its owning session is one of `decisions.dedicatedOwners`. */
  const PRICED: Task = { ...DECIDE, id: 'T7', owner: 'pricing', title: 'Set the launch price' };
  const BRIEF = "A full brief for owner's dedicated meeting, in this task's files: context, data, each option with its numbers and risks, your recommendation.";

  it("moves a dedicated session's decisions out of DECISIONS into one group, with the line asking its brief and the one booking its meeting", () => {
    const second: Task = { ...PRICED, id: 'T10', title: 'Set the renewal price' };
    const input: AgendaInput = { ...inputOf([DECIDE, PRICED, second]), dedicatedOwners: ['pricing'] };
    const order = input.tree.inPlanOrder([second, PRICED]).map((task) => task.id);
    const all = agendaLines(input);
    assert.deepEqual(rowIds(section(all, 'DECISIONS')), ['T4']);
    const lines = section(all, 'DEDICATED');
    assert.equal(lines[0], "DEDICATED 2 waiting on owner in core-business areas: never a card; each owning session's own meeting after the daily");
    assert.equal(lines[1], '  pricing: 2 decision(s)');
    assert.deepEqual(
      lines.slice(2, 4).map((line) => /^ {4}(T\d+) waiting, p2, owner pricing \| Set the /.exec(line)?.[1]),
      order,
      'its rows in the plan order',
    );
    assert.equal(
      lines[4],
      `    brief: teamrig add --owner pricing --source owner --priority p1 --due <slot date> --title "Dedicated meeting with owner at <slot>: brief on ${order.join(', ')}" --description "${BRIEF}" --session lead`,
    );
    assert.equal(
      lines[5],
      `    book: teamrig meeting schedule --meets pricing --at "<slot>" --about "owner's core-business decisions" --tasks ${order.join(',')} --session lead`,
    );
    assert.match(lines[6] ?? '', /^ {2}Agree a slot after the daily with owner for each session, then run its brief and book lines once/);
    assert.equal(lines.length, 7);
  });

  it("groups a team under the lead's by <team>/<session> on that team's own sessions, its brief asked in that team and its meeting booked by that team's lead", () => {
    const ledger: Task = { ...DECIDE, id: 'T8', owner: 'ledger' };
    const notDedicatedThere: Task = { ...PRICED, id: 'T9' };
    const web: AgendaTeam = { ...teamOf('web', [ledger, notDedicatedThere]), dedicatedOwners: ['ledger'] };
    const all = agendaLines({ ...inputOf([PRICED], NOW - MS_PER_DAY, true, [web]), dedicatedOwners: ['pricing'] });
    assert.deepEqual(rowIds(section(all, 'DECISIONS')), ['web/T9']);
    const lines = section(all, 'DEDICATED');
    assert.match(lines[0] ?? '', /^DEDICATED 2 waiting on owner /);
    assert.deepEqual(
      lines.filter((line) => /^ {2}\S+: \d+ decision/.test(line)),
      ['  pricing: 1 decision(s)', '  web/ledger: 1 decision(s)'],
    );
    assert.ok(lines.some((line) => /^ {4}web\/T8 waiting, p2, owner ledger \| /.test(line)), lines.join('\n'));
    assert.ok(
      lines.includes(
        `    brief: teamrig add --team web --owner ledger --source owner --priority p1 --due <slot date> --title "Dedicated meeting with owner at <slot>: brief on T8" --description "${BRIEF}" --session lead`,
      ),
      lines.join('\n'),
    );
    assert.ok(
      lines.includes(
        `    book: team web's lead runs teamrig meeting schedule --meets ledger --at "<slot>" --about "owner's core-business decisions" --tasks T8 --session <web's lead>`,
      ),
      lines.join('\n'),
    );
  });

  it('shows no block when no dedicated session waits on the owner', () => {
    const all = agendaLines({ ...inputOf([DECIDE]), dedicatedOwners: ['pricing'] });
    assert.equal(all.some((line) => line.startsWith('DEDICATED')), false);
    assert.deepEqual(rowIds(section(all, 'DECISIONS')), ['T4']);
  });
});
