import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLineRequest,
  isStepKind,
  kindOfCommand,
  lineRequestOf,
  processRequest,
  STEP_KINDS,
  taskOfLabel,
  type LineTask,
  type RequestFocus,
  type StepKind,
} from './process-request.ts';

describe('kindOfCommand', () => {
  for (const [command, kind] of [
    [['git', 'push', 'origin', 'HEAD'], 'push'],
    [['git', '-C', 'C:\\work\\app', 'push', '--force-with-lease'], 'push'],
    [['C:\\Program Files\\Git\\cmd\\git.exe', 'push'], 'push'],
    [['node', '--test', 'src/a.test.ts'], 'test'],
    [['node', '--disable-warning=ExperimentalWarning', '--test', 'src/a.test.ts'], 'test'],
    [['npm', 'test'], 'test'],
    [['npm', 't'], 'test'],
    [['npm', 'run', 'test:unit'], 'test'],
    [['npm', '--prefix', 'app', 'test'], 'test'],
    [['npx', 'vitest', 'run'], 'test'],
    [['pnpm', 'vitest', 'run'], 'test'],
    [['C:\\work\\app\\node_modules\\.bin\\jest.cmd', '--ci'], 'test'],
    [['npm', 'run', 'lint'], 'lint'],
    [['yarn', 'lint:fix'], 'lint'],
    [['C:\\work\\app\\node_modules\\.bin\\eslint.cmd', 'src'], 'lint'],
    [['npx', 'lint-staged'], 'lint'],
    [['pnpm', 'build'], 'build'],
    [['pnpm', '-C', 'web', 'build'], 'build'],
    [['npm', '--prefix', 'C:\\work\\app', 'run', 'typecheck'], 'build'],
    [['tsc', '-p', '.'], 'build'],
    [['node', 'node_modules/typescript/bin/tsc.js', '--noEmit'], 'build'],
    [['npm', 'run', 'check'], 'other'],
    [['npm', 'install'], 'other'],
    [['node', 'tools/ship/ship.ts', 'plan.json', '--merge'], 'other'],
    [['git', 'fetch', 'origin'], 'other'],
  ] as const) {
    it(`reads ${command.join(' ')} as ${kind}`, () => {
      assert.equal(kindOfCommand(command), kind);
    });
  }
});

describe('taskOfLabel', () => {
  for (const [label, task] of [
    ['teamrig T2192 tests', 'T2192'],
    ['T7 tsc', 'T7'],
    ['merge t12-fix (T12): T13 next', 'T12'],
    ['T0 build', undefined],
    ['build api', undefined],
    ['T12a lint', undefined],
  ] as const) {
    it(`reads ${task ?? 'no task'} from the label "${label}"`, () => {
      assert.equal(taskOfLabel(label), task);
    });
  }
});

describe('processRequest', () => {
  it('keeps the task it works for', () => {
    assert.deepEqual(processRequest('build', 'T5'), { kind: 'build', task: 'T5' });
  });

  it('leaves the task out when there is none, so a record holds no empty field', () => {
    assert.deepEqual(Object.keys(processRequest('merge', undefined)), ['kind']);
  });

  it("keeps the task's priority beside its task, and drops a priority with no task to belong to (T2209)", () => {
    assert.deepEqual([processRequest('test', 'T5', 2), processRequest('test', undefined, 2)], [{ kind: 'test', task: 'T5', priority: 2 }, { kind: 'test' }]);
  });
});

describe('lineRequestOf (T2210)', () => {
  /** The default focus: Roadmap 60, Maintenance 25 and Improvements 15 percent of the week, a task with no class counting as Improvements. */
  const FOCUS: RequestFocus = { defaultClass: 'Improvements', allocation: { Roadmap: 60, Maintenance: 25, Improvements: 15 } };

  /** A register lookup over `tasks` that counts its reads. */
  function registerOf(tasks: ReadonlyMap<string, LineTask>): { readonly reads: string[]; readonly taskOf: (id: string) => Promise<LineTask | undefined> } {
    const reads: string[] = [];
    return {
      reads,
      taskOf: async (id) => {
        reads.push(id);
        return tasks.get(id);
      },
    };
  }

  it("adds the register's priority and class of the task the request works for, and that class's share, in one read", async () => {
    const register = registerOf(new Map([['T5', { priority: 1, workClass: 'Maintenance' }]]));
    assert.deepEqual(
      [await lineRequestOf(processRequest('merge', 'T5'), register.taskOf, FOCUS), register.reads],
      [{ kind: 'merge', task: 'T5', priority: 1, class: 'Maintenance', classPct: 25 }, ['T5']],
    );
  });

  it('counts a task with no class as the default class', async () => {
    const register = registerOf(new Map([['T5', { priority: 2, workClass: null }]]));
    assert.deepEqual(await lineRequestOf(processRequest('test', 'T5'), register.taskOf, FOCUS), { kind: 'test', task: 'T5', priority: 2, class: 'Improvements', classPct: 15 });
  });

  it('counts a request that names no task as the default class, without reading the register', async () => {
    const register = registerOf(new Map([['T5', { priority: 1, workClass: 'Roadmap' }]]));
    assert.deepEqual([await lineRequestOf(processRequest('build', undefined), register.taskOf, FOCUS), register.reads], [{ kind: 'build', class: 'Improvements', classPct: 15 }, []]);
  });

  it("counts a task the register lacks, another team's or a typo, as the default class with no priority", async () => {
    const register = registerOf(new Map());
    assert.deepEqual([await lineRequestOf(processRequest('test', 'T9'), register.taskOf, FOCUS), register.reads], [{ kind: 'test', task: 'T9', class: 'Improvements', classPct: 15 }, ['T9']]);
  });

  it('gives a class the allocation has no share for a share of 0', async () => {
    const register = registerOf(new Map([['T5', { priority: 1, workClass: 'Research' }]]));
    assert.deepEqual(await lineRequestOf(processRequest('test', 'T5'), register.taskOf, FOCUS), { kind: 'test', task: 'T5', priority: 1, class: 'Research', classPct: 0 });
  });
});

describe('isLineRequest (T2210)', () => {
  it('reads a line request with or without its task and priority, ignoring a field another kit adds', () => {
    const requests = [
      { kind: 'test', task: 'T5', priority: 1, class: 'Maintenance', classPct: 25 },
      { kind: 'build', class: 'Improvements', classPct: 15 },
      { kind: 'deploy', class: 'Roadmap', classPct: 33.3, needMb: 4096, heavy: true },
    ];
    assert.deepEqual(requests.filter(isLineRequest), requests);
  });

  it('refuses a kind, task, priority, class or share this teamrig cannot read', () => {
    const good = { kind: 'test', task: 'T5', priority: 1, class: 'Maintenance', classPct: 25 };
    const bad: readonly unknown[] = [
      null,
      'test',
      { ...good, kind: 'vm' },
      { ...good, task: 5 },
      { ...good, priority: -1 },
      { ...good, priority: 1.5 },
      { ...good, class: undefined },
      { ...good, classPct: 'x' },
      { ...good, classPct: -5 },
      { ...good, classPct: Number.POSITIVE_INFINITY },
    ];
    assert.deepEqual(bad.filter(isLineRequest), []);
  });
});

describe('isStepKind', () => {
  it('knows each kind, and nothing else', () => {
    const kinds: readonly StepKind[] = STEP_KINDS;
    assert.deepEqual(kinds.filter(isStepKind), kinds);
    assert.deepEqual(['tests', 'Build', '', 5, undefined].filter(isStepKind), []);
  });
});
