import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRow, TeamDayRollup } from './rollup-file.ts';
import { planUse, type PlanUseInput, type TaskPlace } from './rollup-use.ts';

const FOCUS = { classes: ['Roadmap', 'Maintenance', 'Improvements'], allocation: { Roadmap: 60, Maintenance: 25, Improvements: 15 }, plannedTargetPct: 70 };

const PLACES: Readonly<Record<string, TaskPlace>> = {
  T1: { workClass: 'Roadmap', planned: true },
  T2: { workClass: 'Roadmap', planned: false },
  T3: { workClass: 'Maintenance', planned: false },
  T4: { workClass: 'Research', planned: true },
};

function row(session: string, task: string | null, w: number, seconds: number): TaskRow {
  return { session, task, w, seconds };
}

function day(team: string, date: string, tasks: readonly TaskRow[]): TeamDayRollup {
  return { day: date, team, rows: [], tasks };
}

function fold(days: readonly TeamDayRollup[], overrides: Partial<PlanUseInput> = {}): ReturnType<typeof planUse> {
  return planUse({ days, placeOf: (_team, _day, task) => PLACES[task] ?? { workClass: 'Improvements', planned: false }, focus: FOCUS, ...overrides });
}

describe('planUse', () => {
  it('splits the task rows by plan and class, each against its target', () => {
    const use = fold([day('app', '2030-01-07', [row('alpha', 'T1', 600, 60), row('alpha', 'T2', 200, 30), row('bravo', 'T3', 200, 90)])]);
    assert.deepEqual(use.planned, { w: 600, seconds: 60 });
    assert.deepEqual(use.unplanned, { w: 400, seconds: 120 });
    assert.equal(use.coveragePct, 60);
    assert.equal(use.targetPct, 70);
    assert.deepEqual(use.classes, [
      { workClass: 'Roadmap', planned: { w: 600, seconds: 60 }, unplanned: { w: 200, seconds: 30 }, sharePct: 80, targetPct: 60 },
      { workClass: 'Maintenance', planned: { w: 0, seconds: 0 }, unplanned: { w: 200, seconds: 90 }, sharePct: 20, targetPct: 25 },
      { workClass: 'Improvements', planned: { w: 0, seconds: 0 }, unplanned: { w: 0, seconds: 0 }, sharePct: 0, targetPct: 15 },
    ]);
  });

  it('keeps work that named no task apart from every share', () => {
    const use = fold([day('app', '2030-01-07', [row('alpha', 'T1', 100, 10), row('alpha', null, 900, 90)])]);
    assert.deepEqual(use.noTask, { w: 900, seconds: 90 });
    assert.equal(use.coveragePct, 100);
    assert.equal(use.classes[0]?.sharePct, 100);
  });

  it('adds up every day and team, each row placed by its own team and day', () => {
    const asked: string[] = [];
    const use = fold([day('app', '2030-01-07', [row('alpha', 'T1', 100, 10)]), day('web', '2030-01-08', [row('alpha', 'T1', 300, 30)])], {
      placeOf: (team, date, task) => {
        asked.push(`${team} ${date} ${task}`);
        return { workClass: 'Roadmap', planned: team === 'web' };
      },
    });
    assert.deepEqual(asked, ['app 2030-01-07 T1', 'web 2030-01-08 T1']);
    assert.deepEqual(use.planned, { w: 300, seconds: 30 });
    assert.deepEqual(use.unplanned, { w: 100, seconds: 10 });
  });

  it('lists a class outside focus.classes after them, with no target', () => {
    const use = fold([day('app', '2030-01-07', [row('alpha', 'T4', 100, 10)])]);
    assert.deepEqual(
      use.classes.map((entry) => [entry.workClass, entry.targetPct]),
      [
        ['Roadmap', 60],
        ['Maintenance', 25],
        ['Improvements', 15],
        ['Research', null],
      ],
    );
  });

  it("reads only the named session's rows of its team", () => {
    const rows = [row('alpha', 'T1', 100, 10), row('bravo', 'T1', 200, 20), row('alpha', null, 5, 1)];
    const use = fold([day('app', '2030-01-07', rows), day('web', '2030-01-07', [row('alpha', 'T1', 400, 40)])], { session: { team: 'app', session: 'alpha' } });
    assert.deepEqual(use.planned, { w: 100, seconds: 10 });
    assert.deepEqual(use.noTask, { w: 5, seconds: 1 });
  });

  it('reads no share at all when no W has a task, never a zero that looks measured', () => {
    const use = fold([day('app', '2030-01-07', [row('alpha', null, 100, 10)])]);
    assert.equal(use.coveragePct, null);
    assert.deepEqual(
      use.classes.map((entry) => entry.sharePct),
      [null, null, null],
    );
  });
});
