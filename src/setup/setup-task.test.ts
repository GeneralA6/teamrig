import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { OWN_NUMBERS } from '../register/numbering.ts';
import type { AddInput, StatusInput, Verdict } from '../register/policy.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register, type WriteResult } from '../register/register.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import { JsonlEventLog } from '../register/store.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  applySetupTask,
  SETUP_TASK_TITLE,
  setupTaskDryLines,
  setupTaskInput,
  setupTaskLines,
  setupTaskStep,
  type SetupTaskOutcome,
  type SetupTaskRegister,
} from './setup-task.ts';
import type { Checked } from './team-create.ts';

/** A register on memory files for the team `lead`, `alpha`, `bravo`. */
function memoryRegister(): Register {
  return new Register({
    log: new JsonlEventLog(new MemoryFiles(), 'register/events.jsonl'),
    mutex: new InlineMutex(),
    numbering: OWN_NUMBERS,
    elsewhere: NOTHING_ELSEWHERE,
    goals: NO_GOAL_RECORDS,
    clock: new FakeClock('2030-01-07T09:00:00.000Z'),
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(testConfig()),
    skills: { exists: async () => false },
    autoArchive: true,
  });
}

function valueOf(checked: Checked<SetupTaskOutcome>): SetupTaskOutcome {
  assert.ok(checked.ok, checked.ok ? '' : checked.problem);
  return checked.value;
}

function written(verdict: Verdict<WriteResult>): WriteResult {
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
  return verdict.value;
}

/** A register whose add goes through and whose status change is refused, to see a refused start reported. */
class RefusedStartRegister implements SetupTaskRegister {
  private readonly inner = memoryRegister();

  snapshot(): Promise<RegisterSnapshot> {
    return this.inner.snapshot();
  }

  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.inner.add(caller, input);
  }

  async setStatus(_caller: string, id: string, _input: StatusInput): Promise<Verdict<WriteResult>> {
    return { ok: false, error: `${id} is held` };
  }
}

describe('applySetupTask', () => {
  it('adds the setup task to an empty task list, owned by the lead from the user, and starts it', async () => {
    const register = memoryRegister();
    const outcome = valueOf(await applySetupTask(register, 'lead', 'owner'));
    assert.equal(outcome.kind, 'added');
    const [task] = (await register.snapshot()).state.tasks.values();
    assert.ok(task !== undefined);
    assert.deepEqual(
      [task.id, task.title, task.status, task.owner, task.source, task.priority],
      ['T1', SETUP_TASK_TITLE, 'in-progress', 'lead', 'owner', 1],
    );
    assert.match(task.description ?? '', /skill team-setup.*ask what they want the team to do/);
    assert.deepEqual(outcome, { kind: 'added', task });
  });

  it('keeps the setup task a run before added, whatever its status, and adds no second', async () => {
    const register = memoryRegister();
    valueOf(await applySetupTask(register, 'lead', 'owner'));
    assert.deepEqual(valueOf(await applySetupTask(register, 'lead', 'owner')), { kind: 'kept', task: (await register.snapshot()).state.tasks.get('T1') });
    written(await register.setStatus('lead', 'T1', { status: 'done', note: 'set up', evidence: 'T2, T3 open', skill: 'none', followups: [] }));
    const kept = valueOf(await applySetupTask(register, 'lead', 'owner'));
    assert.equal(kept.kind === 'kept' ? kept.task.status : kept.kind, 'done');
    assert.equal((await register.snapshot()).state.tasks.size, 1);
  });

  it('gives a team already at work no setup task', async () => {
    const register = memoryRegister();
    written(await register.add('lead', { title: 'Ship the form', description: 'the signup form', owner: 'alpha', source: 'lead', priority: 2 }));
    assert.deepEqual(valueOf(await applySetupTask(register, 'lead', 'owner')), { kind: 'none' });
    assert.equal((await register.snapshot()).state.tasks.size, 1);
  });

  it('reports a refused add or a refused start', async () => {
    const refusedAdd = await applySetupTask(memoryRegister(), 'ghost', 'owner');
    assert.equal(refusedAdd.ok, false);
    assert.match(refusedAdd.ok ? '' : refusedAdd.problem, /ghost/);
    assert.deepEqual(await applySetupTask(new RefusedStartRegister(), 'lead', 'owner'), { ok: false, problem: 'T1 is held' });
  });
});

describe('setupTaskStep', () => {
  it('finds only the lead\'s setup task, not one of the same title another session owns', async () => {
    const register = memoryRegister();
    written(await register.add('lead', { ...setupTaskInput('alpha', 'owner') }));
    assert.deepEqual(setupTaskStep(await register.snapshot(), 'lead'), { kind: 'none' });
  });
});

describe('setup task lines', () => {
  it('says what a run did and a dry run would do', async () => {
    const register = memoryRegister();
    const added = valueOf(await applySetupTask(register, 'lead', 'owner'));
    assert.deepEqual(setupTaskLines(added, 'lead'), [
      'ADDED T1 Set up the team, in progress, owner lead: close it with teamrig set T1 --status done once every session runs its first task',
    ]);
    const kept = valueOf(await applySetupTask(register, 'lead', 'owner'));
    const keptLine = 'UNCHANGED T1 Set up the team (in-progress, owner lead): the task list already has the team\'s setup';
    assert.deepEqual(setupTaskLines(kept, 'lead'), [keptLine]);
    assert.deepEqual(setupTaskLines({ kind: 'none' }, 'lead'), []);
    assert.deepEqual(setupTaskDryLines(setupTaskStep(await register.snapshot(), 'lead'), 'lead'), [keptLine]);
    assert.deepEqual(setupTaskDryLines({ kind: 'add' }, 'boss'), ['WOULD ADD Set up the team, in progress, owner boss']);
    assert.deepEqual(setupTaskDryLines({ kind: 'none' }, 'lead'), []);
  });
});
