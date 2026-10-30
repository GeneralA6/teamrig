import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HireFlag } from '../hiring/due.ts';
import { FLAG_KINDS, formatFlag, type Flag, type FlagKind } from '../register/check.ts';
import type { Task } from '../register/fold.ts';
import { formatTask } from '../register/views.ts';
import type { SkillFlag } from '../skills/lint.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { testTask } from '../testing/task.ts';
import { TaskTree } from '../register/tree.ts';
import {
  checkLines,
  fitBudget,
  listLines,
  MAX_FLAGS_PER_KIND,
  MAX_WAITING_ROWS,
  ownCheck,
  printedChars,
  SHORT_FORM_CHARS,
  waitingOnLines,
  type CheckReport,
  type TaskRow,
} from './reports.ts';
import { EXIT } from './runtime.ts';
import type { UnownedWarning } from './unowned.ts';
import { TimeZone } from '../core/zone.ts';

const LONG_TITLE = 'Move the nightly export onto the shared queue and drop the old cron that wrote it twice';
const NOW = new Date('2030-01-08T12:00:00.000Z');
/** A read with no other task in it, at NOW: each task keeps its own due. */
const TREE = new TaskTree(new Map(), NOW, TimeZone.UTC);

function treeOf(...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
}

function row(overrides: Partial<Task>, team?: string): TaskRow {
  return { task: testTask(overrides), team, tree: TREE };
}

function flag(kind: FlagKind, task: Partial<Task>, detail = `${kind.toLowerCase()} detail`): Flag {
  return { kind, task: testTask(task), detail };
}

function skillFlag(skill: string): SkillFlag {
  return { kind: 'UNVERIFIED', skill, owner: 'alpha', detail: 'Last verified 2029-11-01, over 30 days' };
}

function report(overrides: Partial<CheckReport>): CheckReport {
  return { sections: [], scope: 'week 2030-01-07', skills: [], skillsDir: 'skills-dir', hires: [], unowned: [], lead: 'lead', decisions: undefined, ...overrides };
}

/** `count` tasks numbered from T1, each with `title` (a long one by default), cycling through three owners. */
function manyTasks(count: number, title = LONG_TITLE): TaskRow[] {
  const owners = ['alpha', 'bravo', 'lead'];
  return Array.from({ length: count }, (_, index) => row({ id: `T${index + 1}`, owner: owners[index % owners.length] ?? 'alpha', title }));
}

describe('printedChars and fitBudget', () => {
  it('counts each line with its newline', () => {
    assert.equal(printedChars([]), 0);
    assert.equal(printedChars(['ab', '']), 4);
  });

  it('keeps every line that fits, else the first lines and a more line, all inside the budget', () => {
    const lines = ['aaaa', 'bbbb', 'cccc'];
    const more = (left: number): string => `+${left}`;
    assert.deepEqual(fitBudget(lines, 15, more), lines);
    assert.deepEqual(fitBudget(lines, 14, more), ['aaaa', 'bbbb', '+1']);
    assert.equal(printedChars(fitBudget(lines, 14, more)) <= 14, true);
    assert.deepEqual(fitBudget(lines, 7, more), ['+3']);
  });
});

describe('listLines', () => {
  it('prints every field of every row with --all, ids naming their team', () => {
    const rows = [row({ id: 'T2', week: '2030-01-07', goals: ['G1'] }), row({ id: 'T1' }, 'web')];
    assert.deepEqual(listLines(rows, true), [formatTask(testTask({ id: 'T2', week: '2030-01-07', goals: ['G1'] }), undefined, TREE), formatTask(testTask(), 'web', TREE)]);
    assert.deepEqual(listLines([], true), []);
  });

  it('ends each full row with why it sorts ahead of the next, in the given order', () => {
    const rows = [row({ id: 'T5', status: 'in-progress' }), row({ id: 'T1' })];
    assert.deepEqual(listLines(rows, true), [`${formatTask(testTask({ id: 'T5', status: 'in-progress' }), undefined, TREE)} · ahead: in progress`, formatTask(testTask(), undefined, TREE)]);
  });

  it("prints one owner's tasks as short rows in plan order, without an owner summary", () => {
    const rows = [row({ id: 'T3', priority: 2 }), row({ id: 'T1', priority: 2, due: '2030-01-09' }), row({ id: 'T2', priority: 1, title: LONG_TITLE })];
    assert.deepEqual(listLines(rows, false), [
      'LIST 3 task(s) (short rows; --all for every field)',
      'T2 open, p1, owner alpha | Move the nightly export onto the shared queue and drop the…',
      'T1 open, p2, owner alpha, due 01-09 | Add a health check · ahead: due',
      'T3 open, p2, owner alpha | Add a health check',
    ]);
  });

  it('orders rows of several registers on each one\'s effective due', () => {
    const work = testTask({ id: 'T3' });
    const needer = testTask({ id: 'T9', owner: 'bravo', due: '2030-01-09', after: ['T3'] });
    const web = treeOf(work, needer);
    const rows: TaskRow[] = [row({ id: 'T1', due: '2030-01-10' }, 'api'), { task: work, team: 'web', tree: web }];
    assert.deepEqual(listLines(rows, false).slice(-2), [
      'web/T3 open, p2, owner alpha, due 01-09 (from T9) | Add a health check · needed by T9 (bravo) · ahead: due',
      'api/T1 open, p2, owner alpha, due 01-10 | Add a health check',
    ]);
  });

  it('counts each owner by status, the busiest first, then by name', () => {
    const rows = [
      row({ id: 'T1', owner: 'bravo', status: 'done' }),
      row({ id: 'T2', owner: 'alpha', status: 'waiting' }),
      row({ id: 'T3', owner: 'alpha', status: 'in-progress' }),
      row({ id: 'T4', owner: 'alpha', status: 'dropped' }),
      row({ id: 'T5', owner: 'lead' }, 'web'),
      row({ id: 'T6', owner: 'alpha', status: 'verifying' }),
    ];
    assert.deepEqual(listLines(rows, false).slice(0, 4), [
      'LIST 6 task(s) of 3 owners (short rows; --all for every field)',
      '  alpha 4: 1 in-progress, 1 verifying, 1 waiting, 1 dropped',
      '  bravo 1: 1 done',
      '  web/lead 1: 1 open',
    ]);
  });

  it('says so when nothing matches', () => {
    assert.deepEqual(listLines([], false), ['LIST 0 task(s)']);
  });

  it(`stays within ${SHORT_FORM_CHARS} characters at 200 tasks and counts the rows it leaves out`, () => {
    const lines = listLines(manyTasks(200), false);
    assert.equal(printedChars(lines) <= SHORT_FORM_CHARS, true);
    const shown = lines.filter((line) => /^T\d+ /.test(line)).length;
    assert.equal(lines.at(-1), `+${200 - shown} more (--all lists every task in full)`);
    assert.deepEqual(lines.slice(0, 4), [
      'LIST 200 task(s) of 3 owners (short rows; --all for every field)',
      '  alpha 67: 67 open',
      '  bravo 67: 67 open',
      '  lead 66: 66 open',
    ]);
  });
});

describe('checkLines', () => {
  const sections = [
    { team: 'app', tree: TREE, flags: [flag('OVERDUE', { id: 'T4', due: '2030-01-07' }, 'due 01-07')] },
    { team: 'web', tree: TREE, flags: [flag('STALE', { id: 'T2' }, 'last event 2030-01-01 by lead')] },
  ];

  it('prints each register, every flag in full and every skill flag with --all', () => {
    const lines = checkLines(report({ sections, skills: [skillFlag('alpha-demo')] }), true);
    assert.deepEqual(lines, [
      'CHECK app: 1 flag(s), week 2030-01-07',
      formatFlag(sections[0]?.flags[0] ?? flag('OVERDUE', {}), 'app', TREE),
      'CHECK web: 1 flag(s), week 2030-01-07',
      formatFlag(sections[1]?.flags[0] ?? flag('STALE', {}), 'web', TREE),
      'SKILLS 1 flag(s) in skills-dir',
      'SKILL UNVERIFIED (Last verified 2029-11-01, over 30 days) alpha alpha-demo',
    ]);
    assert.deepEqual(checkLines(report({ sections: [{ team: undefined, tree: TREE, flags: [] }] }), true), [
      'CHECK 0 flag(s), week 2030-01-07',
      'SKILLS 0 flag(s) in skills-dir',
    ]);
  });

  it('prints the hire flags before the skills, in both forms, and counts them toward the hint', () => {
    const hires: readonly HireFlag[] = [{ kind: 'RETIRE-DUE', session: 'helper', detail: 'the burst it was hired for is over', action: 'retire it (teamrig retire helper)' }];
    const flagged = report({ sections: [{ team: undefined, tree: TREE, flags: [] }], hires });
    const line = 'HIRE RETIRE-DUE (the burst it was hired for is over) helper: retire it (teamrig retire helper)';
    assert.deepEqual(checkLines(flagged, true), ['CHECK 0 flag(s), week 2030-01-07', 'HIRES 1 flag(s)', line, 'SKILLS 0 flag(s) in skills-dir']);
    assert.deepEqual(checkLines(flagged, false), [
      'CHECK 0 flag(s), week 2030-01-07 (short form; --all for every flag in full)',
      'HIRES 1 flag(s)',
      `  ${line}`,
      'SKILLS 0 flag(s) in skills-dir',
    ]);
  });

  it('prints the unowned warnings after the hire flags under the lead they go to, in both forms, and counts them toward the hint (T951)', () => {
    const unowned: readonly UnownedWarning[] = [
      { key: 'context maxClaudeMdChars', source: 'the context check [contextFiles.maxClaudeMdChars]', text: 'WARN context-size CLAUDE.md files: over its budget' },
    ];
    const flagged = report({ sections: [{ team: undefined, tree: TREE, flags: [] }], unowned });
    const heading = 'UNOWNED 1 warning(s) no session owns, so they go to the lead (lead): fix each, hand it on (teamrig add --owner <session>) or settle its check';
    const line = 'from the context check [contextFiles.maxClaudeMdChars]: WARN context-size CLAUDE.md files: over its budget';
    assert.deepEqual(checkLines(flagged, true), ['CHECK 0 flag(s), week 2030-01-07', heading, line, 'SKILLS 0 flag(s) in skills-dir']);
    assert.deepEqual(checkLines(flagged, false), [
      'CHECK 0 flag(s), week 2030-01-07 (short form; --all for every flag in full)',
      heading,
      `  ${line}`,
      'SKILLS 0 flag(s) in skills-dir',
    ]);
  });

  it('shows the first unowned warnings in the short form, like a kind, and every one with --all', () => {
    const unowned = Array.from({ length: MAX_FLAGS_PER_KIND + 2 }, (_, index) => ({ key: `skill OWNER s${index}`, source: 'the skill check of skills-dir', text: `SKILL OWNER (no owner) - s${index}` }));
    const short = checkLines(report({ unowned }), false);
    assert.equal(short.filter((line) => line.startsWith('  from the skill check')).length, MAX_FLAGS_PER_KIND);
    assert.equal(short.includes('  +2 more'), true, short.join('\n'));
    assert.equal(checkLines(report({ unowned }), true).filter((line) => line.startsWith('from the skill check')).length, MAX_FLAGS_PER_KIND + 2);
  });

  it('prints one count over every team, each kind with its shared detail, and no hint when nothing is flagged', () => {
    assert.deepEqual(checkLines(report({ sections }), false), [
      'CHECK 2 flag(s) in 2 team(s), week 2030-01-07 (short form; --all for every flag in full)',
      'OVERDUE 1 (due 01-07)',
      '  app/T4 open, p2, owner alpha, due 01-07 | Add a health check',
      'STALE 1 (last event 2030-01-01 by lead)',
      '  web/T2 open, p2, owner alpha | Add a health check',
      'SKILLS 0 flag(s) in skills-dir',
    ]);
    assert.deepEqual(checkLines(report({ sections: [{ team: undefined, tree: TREE, flags: [] }], scope: 'no week plan' }), false), [
      'CHECK 0 flag(s), no week plan',
      'SKILLS 0 flag(s) in skills-dir',
    ]);
  });

  it(`orders the kinds, keeps each row's own detail and shows ${MAX_FLAGS_PER_KIND} flags of a kind in plan order`, () => {
    const overdue = Array.from({ length: 7 }, (_, index) => flag('OVERDUE', { id: `T${7 - index}` }, `due 01-0${index + 1}`));
    const lines = checkLines(
      report({
        sections: [{ team: undefined, tree: TREE, flags: [flag('STALE', { id: 'T9' }), ...overdue] }],
        skills: Array.from({ length: 6 }, (_, index) => skillFlag(`alpha-skill${index}`)),
      }),
      false,
    );
    assert.deepEqual(lines, [
      'CHECK 8 flag(s), week 2030-01-07 (short form; --all for every flag in full)',
      'OVERDUE 7',
      '  (due 01-07) T1 open, p2, owner alpha | Add a health check',
      '  (due 01-06) T2 open, p2, owner alpha | Add a health check',
      '  (due 01-05) T3 open, p2, owner alpha | Add a health check',
      '  (due 01-04) T4 open, p2, owner alpha | Add a health check',
      '  (due 01-03) T5 open, p2, owner alpha | Add a health check',
      '  +2 more',
      'STALE 1 (stale detail)',
      '  T9 open, p2, owner alpha | Add a health check',
      'SKILLS 6 flag(s) in skills-dir',
      ...[0, 1, 2, 3, 4].map((index) => `  SKILL UNVERIFIED (Last verified 2029-11-01, over 30 days) alpha alpha-skill${index}`),
      '  +1 more',
    ]);
  });

  it(`shows fewer flags of every kind when ${MAX_FLAGS_PER_KIND} would pass ${SHORT_FORM_CHARS} characters`, () => {
    // Short titles keep one flag of each kind within the budget as kinds are added.
    const flags = FLAG_KINDS.flatMap((kind) => manyTasks(30, 'Short title').map(({ task }) => ({ kind, task, detail: `${kind} detail for ${task.id}` })));
    const lines = checkLines(report({ sections: [{ team: undefined, tree: TREE, flags }] }), false);
    assert.equal(printedChars(lines) <= SHORT_FORM_CHARS, true);
    const more = lines.filter((line) => /^ {2}\+\d+ more$/.test(line));
    assert.equal(more.length, FLAG_KINDS.length);
    const shown = 30 - Number(/\d+/.exec(more[0] ?? '')?.[0]);
    assert.equal(shown < MAX_FLAGS_PER_KIND && shown >= 1, true);
    assert.deepEqual(new Set(more), new Set([`  +${30 - shown} more`]));
  });

  it('cuts whole lines with a more line when even one flag of each kind passes the budget', () => {
    const detail = 'x'.repeat(500);
    const flags = FLAG_KINDS.flatMap((kind) => [flag(kind, { id: 'T1' }, `${detail}1`), flag(kind, { id: 'T2' }, `${detail}2`)]);
    const lines = checkLines(report({ sections: [{ team: undefined, tree: TREE, flags }] }), false);
    assert.equal(printedChars(lines) <= SHORT_FORM_CHARS, true);
    assert.match(lines.at(-1) ?? '', /^\+\d+ more line\(s\) \(--all for every flag in full\)$/);
    assert.equal(lines.filter((line) => line.startsWith('  (')).length < FLAG_KINDS.length, true);
  });
});

describe(`list and check at 200 tasks, through the CLI`, () => {
  it(`print within ${SHORT_FORM_CHARS} characters by default and every row with --all`, async () => {
    const kit = new CliHarness();
    const owners = ['alpha', 'bravo', 'lead'];
    for (let index = 0; index < 200; index += 1) {
      const owner = owners[index % owners.length] ?? 'alpha';
      const added = await kit.run(['add', '--title', `${LONG_TITLE} (part ${index + 1})`, '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-07', '--owner', owner, '--session', 'lead']);
      assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    }
    const own = await kit.run(['list', '--session', 'alpha']);
    const listed = await kit.run(['list']);
    const checked = await kit.run(['check', '--week', '2030-01-06', '--session', 'lead']);
    for (const result of [listed, checked]) {
      assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
      assert.equal(printedChars(result.stdout) <= SHORT_FORM_CHARS, true, `${printedChars(result.stdout)} characters`);
    }
    assert.equal(own.stdout[0], 'LIST 67 task(s) (short rows; --all for every field)');
    assert.equal((await kit.run(['list', '--all'])).stdout.length, 200);
    assert.equal((await kit.run(['check', '--week', '2030-01-06', '--session', 'lead', '--all'])).stdout.filter((line) => line.startsWith('OVERDUE')).length, 200);
  });
});

describe('ownCheck', () => {
  it('keeps the flags of the tasks and skills one session owns, and names it in the scope', () => {
    const flags = [flag('OVERDUE', { id: 'T1', owner: 'alpha' }), flag('OVERDUE', { id: 'T2', owner: 'bravo' })];
    const skills = [skillFlag('alpha-deploy'), { ...skillFlag('bravo-sync'), owner: 'bravo' }, { ...skillFlag('team-x'), owner: null }];
    const narrowed = ownCheck(report({ sections: [{ team: undefined, flags, tree: TREE }], skills }), 'alpha', []);
    assert.deepEqual(
      narrowed.sections.map((section) => section.flags.map((each) => each.task.id)),
      [['T1']],
    );
    assert.deepEqual(narrowed.skills.map((each) => each.skill), ['alpha-deploy']);
    const hires: readonly HireFlag[] = [
      { kind: 'REVIEW-DUE', session: 'alpha', detail: 'review day 2030-01-07 passed', action: 'decide' },
      { kind: 'RETIRE-DUE', session: 'bravo', detail: 'the burst it was hired for is over', action: 'retire it' },
    ];
    assert.deepEqual(ownCheck(report({ hires }), 'alpha', []).hires.map((each) => each.session), ['alpha']);
    const unowned: readonly UnownedWarning[] = [{ key: 'context maxSessionListsChars', source: 'the context check', text: 'WARN context-lists lists over their budget' }];
    assert.deepEqual(ownCheck(report({ unowned }), 'alpha', []).unowned, [], 'the warnings no session owns go to the lead, not to every session');
    assert.equal(narrowed.scope, "alpha's tasks and skills, week 2030-01-07");
    assert.match(checkLines(narrowed, false)[0] ?? '', /^CHECK 1 flag\(s\), alpha's tasks and skills, week 2030-01-07 /);
  });

  it("adds a sub-lead's group's task flags, not their skills or hires, and names the group in the scope (T782)", () => {
    const flags = [flag('OVERDUE', { id: 'T1', owner: 'alpha' }), flag('OVERDUE', { id: 'T2', owner: 'bravo' }), flag('OVERDUE', { id: 'T3', owner: 'charlie' })];
    const skills = [skillFlag('alpha-deploy'), { ...skillFlag('bravo-sync'), owner: 'bravo' }];
    const hires: readonly HireFlag[] = [{ kind: 'RETIRE-DUE', session: 'bravo', detail: 'the burst it was hired for is over', action: 'retire it' }];
    const narrowed = ownCheck(report({ sections: [{ team: undefined, flags, tree: TREE }], skills, hires }), 'alpha', ['bravo']);
    assert.deepEqual(
      narrowed.sections.map((section) => section.flags.map((each) => each.task.id)),
      [['T1', 'T2']],
    );
    assert.deepEqual(narrowed.skills.map((each) => each.skill), ['alpha-deploy']);
    assert.deepEqual(narrowed.hires, []);
    assert.equal(narrowed.scope, "alpha's tasks and skills, its group's tasks (bravo), week 2030-01-07");
  });
});

describe('waitingOnLines', () => {
  it('prints nothing when no task waits, else a heading and the first MAX_WAITING_ROWS rows, every one with --all', () => {
    assert.equal(MAX_WAITING_ROWS, 5);
    const mine = testTask({ id: 'T1' });
    const needers = Array.from({ length: MAX_WAITING_ROWS + 2 }, (_, index) => testTask({ id: `T${index + 2}`, owner: 'bravo', after: ['T1'] }));
    const tree = treeOf(mine, ...needers);
    assert.deepEqual(waitingOnLines('alpha', [], tree, false), []);
    const short = waitingOnLines('alpha', tree.waitingOn('alpha'), tree, false);
    assert.equal(short[0], `WAITING ON YOU ${MAX_WAITING_ROWS + 2} task(s) of other sessions wait on alpha`);
    assert.equal(short[1], '  T2 open, p2, owner bravo, after T1 | Add a health check · needs your T1');
    assert.equal(short.length, 1 + MAX_WAITING_ROWS + 1);
    assert.equal(short.at(-1), '  +2 more (--all lists every one)');
    assert.equal(waitingOnLines('alpha', tree.waitingOn('alpha'), tree, true).length, 1 + MAX_WAITING_ROWS + 2);
  });
});
