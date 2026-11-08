import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStepKind, kindOfCommand, processRequest, STEP_KINDS, taskOfLabel, withTaskPriority, type RequestTask, type StepKind } from './process-request.ts';

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

describe('withTaskPriority (T2209)', () => {
  /** A register lookup over `tasks` that counts its reads. */
  function registerOf(tasks: ReadonlyMap<string, RequestTask>): { readonly reads: string[]; readonly taskOf: (id: string) => Promise<RequestTask | undefined> } {
    const reads: string[] = [];
    return {
      reads,
      taskOf: async (id) => {
        reads.push(id);
        return tasks.get(id);
      },
    };
  }

  it("adds the register's priority of the task the request works for", async () => {
    const register = registerOf(new Map([['T5', { priority: 1 }]]));
    assert.deepEqual(await withTaskPriority(processRequest('merge', 'T5'), register.taskOf), { kind: 'merge', task: 'T5', priority: 1 });
  });

  it('leaves a request that names no task unchanged, without reading the register', async () => {
    const register = registerOf(new Map([['T5', { priority: 1 }]]));
    assert.deepEqual([await withTaskPriority(processRequest('build', undefined), register.taskOf), register.reads], [{ kind: 'build' }, []]);
  });

  it("adds no priority for a task the register lacks, another team's or a typo", async () => {
    const register = registerOf(new Map());
    assert.deepEqual([await withTaskPriority(processRequest('test', 'T9'), register.taskOf), register.reads], [{ kind: 'test', task: 'T9' }, ['T9']]);
  });
});

describe('isStepKind', () => {
  it('knows each kind, and nothing else', () => {
    const kinds: readonly StepKind[] = STEP_KINDS;
    assert.deepEqual(kinds.filter(isStepKind), kinds);
    assert.deepEqual(['tests', 'Build', '', 5, undefined].filter(isStepKind), []);
  });
});
