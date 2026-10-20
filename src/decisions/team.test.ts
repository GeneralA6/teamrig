import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingStore } from '../meeting/state.ts';
import type { Task } from '../register/fold.ts';
import { TEST_CARD } from '../testing/card.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testTask } from '../testing/task.ts';
import { AskedStore } from './store.ts';
import { teamDecisions } from './team.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATHS = { decisionsAsked: '/kit/state/decisions-asked.json', meeting: '/kit/state/meeting.json' };
const CONFIG = { decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 5 }, register: { ownerSource: 'owner' } };

function ownerWait(id: string, statusAt: string): Task {
  return testTask({ id, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD, statusAt });
}

const TASKS = new Map([ownerWait('T1', '2030-01-07T08:00:00.000Z'), ownerWait('T2', '2030-01-08T09:00:00.000Z')].map((task) => [task.id, task]));

describe("a team's decision batch", () => {
  it('counts every wait not yet asked before any batch or meeting', async () => {
    const { batch } = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, TASKS, NOW);
    assert.deepEqual(
      batch.pending.map((task) => task.id),
      ['T1', 'T2'],
    );
  });

  it('counts a wait asked by the later of the last batch asked and the last meeting start', async () => {
    const files = new MemoryFiles();
    await new AskedStore(files, PATHS.decisionsAsked).write({ askedAt: '2030-01-07T09:00:00.000Z', by: 'lead', ids: ['T1'] });
    assert.deepEqual(
      (await teamDecisions(files, PATHS, CONFIG, TASKS, NOW)).batch.pending.map((task) => task.id),
      ['T2'],
    );
    await new MeetingStore(files, PATHS.meeting).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null });
    assert.deepEqual((await teamDecisions(files, PATHS, CONFIG, TASKS, NOW)).batch.pending, []);
  });
});
