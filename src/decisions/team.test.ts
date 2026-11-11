import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { storedDeadline } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { MeetingStore } from '../meeting/state.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE } from '../register/tree.ts';
import { taskLabel } from '../register/views.ts';
import { TEST_OWNER_CARD } from '../testing/card.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { AskedStore } from './store.ts';
import { teamDecisions, type DecisionRegister, type TeamDecisionsConfig } from './team.ts';

/** A Tuesday. */
const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATHS = { decisionsAsked: '/kit/state/decisions-asked.json', meeting: '/kit/state/meeting.json' };
const CONFIG: TeamDecisionsConfig = { decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 5 }, focus: { improvementsDay: 'wed' } };

function ownerWait(id: string, statusAt: string, who = 'owner'): Task {
  return testTask({ id, status: 'waiting', waits: [{ kind: 'decision', who }], card: TEST_OWNER_CARD, statusAt });
}

/** An owner wait due at `typed` as a person types it on `zone`'s clock, stored the way the CLI stores it (in UTC). */
function typedDueWait(typed: string, zone: TimeZone): Task {
  const due = storedDeadline(typed, NOW, zone) ?? assert.fail(`${typed} does not read as a deadline`);
  return testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, statusAt: '2030-01-08T09:50:00.000Z', due });
}

function tasksOf(...tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/** The team's own register of `tasks`, its marker for the owner `owner`, on `zone`'s clock. */
function own(tasks: ReadonlyMap<string, Task>, zone = TimeZone.UTC): DecisionRegister {
  return { team: undefined, tasks, ownerMarker: 'owner', requireGate: true, zone, elsewhere: NO_TASKS_ELSEWHERE, ranking: testRanking(), focus: DEFAULT_FOCUS, dedicatedOwners: [] };
}

const TASKS = tasksOf(ownerWait('T1', '2030-01-07T08:00:00.000Z'), ownerWait('T2', '2030-01-08T09:00:00.000Z'));

describe("a team's decision batch", () => {
  it('counts every wait not yet asked before any batch or meeting', async () => {
    const batch = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [own(TASKS)], NOW);
    assert.deepEqual(
      batch.pending.map((wait) => wait.task.id),
      ['T1', 'T2'],
    );
  });

  it('counts a wait asked by the later of the last batch asked and the last meeting start', async () => {
    const files = new MemoryFiles();
    await new AskedStore(files, PATHS.decisionsAsked).write({ askedAt: '2030-01-07T09:00:00.000Z', by: 'lead', ids: ['T1'] });
    assert.deepEqual(
      (await teamDecisions(files, PATHS, CONFIG, [own(TASKS)], NOW)).pending.map((wait) => wait.task.id),
      ['T2'],
    );
    await new MeetingStore(files, PATHS.meeting).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null });
    assert.deepEqual((await teamDecisions(files, PATHS, CONFIG, [own(TASKS)], NOW)).pending, []);
  });

  it("asks the waits in the order of the register's ranking (T2076)", async () => {
    const ranked: DecisionRegister = { ...own(TASKS), ranking: testRanking({ classes: { T2: 'Maintenance' } }) };
    assert.deepEqual(
      (await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [ranked], NOW)).pending.map((wait) => wait.task.id),
      ['T2', 'T1'],
    );
  });

  it("reads a due typed on the team's clock, so a wait due before the next batch is asked at once", async () => {
    const urgent = typedDueWait('14:00', JERUSALEM);
    assert.equal(urgent.due, '2030-01-08 12:00', '14:00 IST, stored in UTC');
    const local = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [own(tasksOf(urgent), JERUSALEM)], NOW);
    assert.equal(local.pending[0]?.tree.zone, JERUSALEM, "the wait is judged on the tree of its team's clock");
    assert.deepEqual(local.trigger, { kind: 'deadline', task: urgent, team: undefined, due: Date.parse('2030-01-08T12:00:00Z') });
    const late = typedDueWait('14:00', TimeZone.UTC);
    const utc = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [own(tasksOf(late))], NOW);
    assert.equal(utc.trigger, undefined, '14:00 UTC is after the 13:03 batch');
  });

  it("holds the waits of the registers under the team's own after its own, each on its own marker and clock (T1018)", async () => {
    const files = new MemoryFiles();
    await new AskedStore(files, PATHS.decisionsAsked).write({ askedAt: '2030-01-08T08:00:00.000Z', by: 'lead', ids: ['T1', 'web/T1'] });
    const webTasks = tasksOf(ownerWait('T1', '2030-01-07T08:00:00.000Z', 'human'), ownerWait('T2', '2030-01-08T09:00:00.000Z', 'human'), ownerWait('T5', '2030-01-08T09:00:00.000Z'));
    const web: DecisionRegister = { ...own(webTasks), team: 'web', ownerMarker: 'human' };
    const urgent = typedDueWait('14:00', JERUSALEM);
    const ui: DecisionRegister = { ...own(tasksOf(urgent, ownerWait('T4', '2030-01-08T09:00:00.000Z')), JERUSALEM), team: 'ui' };
    const batch = await teamDecisions(files, PATHS, CONFIG, [own(TASKS), web, ui], NOW);
    assert.deepEqual(
      batch.pending.map((wait) => taskLabel(wait.task, wait.team)),
      ['T2', 'web/T2', 'ui/T3', 'ui/T4'],
      "the own register's first; a wait on another marker than its register's own is no wait on the owner",
    );
    assert.deepEqual(batch.trigger, { kind: 'deadline', task: urgent, team: 'ui', due: Date.parse('2030-01-08T12:00:00Z') }, "ui's 14:00 is on ui's clock");
  });

  it("leaves out the waits of each register's own dedicated sessions (T868)", async () => {
    const webTasks = tasksOf(ownerWait('T1', '2030-01-08T09:00:00.000Z'), testTask({ ...ownerWait('T2', '2030-01-08T09:00:00.000Z'), owner: 'pricing' }));
    const web: DecisionRegister = { ...own(webTasks), team: 'web', dedicatedOwners: ['pricing'] };
    const batch = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [own(TASKS), web], NOW);
    assert.deepEqual(
      batch.pending.map((wait) => taskLabel(wait.task, wait.team)),
      ['T1', 'T2', 'web/T1'],
    );
  });

  // T2113: the team's focus.improvementsDay says when a wait that frees only Improvements work is asked.
  it("holds a wait that frees only Improvements work until the team's Improvements day", async () => {
    const improvements = tasksOf(testTask({ ...ownerWait('T1', '2030-01-08T09:00:00.000Z'), workClass: 'Improvements' }));
    const held = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, [own(improvements)], NOW);
    assert.deepEqual([held.pending, held.weekly.map((wait) => wait.task.id), held.improvementsDay], [[], ['T1'], 'wed']);
    const today = await teamDecisions(new MemoryFiles(), PATHS, { ...CONFIG, focus: { improvementsDay: 'tue' } }, [own(improvements)], NOW);
    assert.deepEqual([today.pending.map((wait) => wait.task.id), today.weekly], [['T1'], []]);
  });
});
