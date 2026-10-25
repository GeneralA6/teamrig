import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storedDeadline } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { MeetingStore } from '../meeting/state.ts';
import type { Task } from '../register/fold.ts';
import { TEST_OWNER_CARD } from '../testing/card.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { AskedStore } from './store.ts';
import { teamDecisions } from './team.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATHS = { decisionsAsked: '/kit/state/decisions-asked.json', meeting: '/kit/state/meeting.json' };
const CONFIG = { decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 5 }, register: { ownerSource: 'owner', requireDecisionCard: true } };

function ownerWait(id: string, statusAt: string): Task {
  return testTask({ id, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, statusAt });
}

/** An owner wait due at `typed` as a person types it on `zone`'s clock, stored the way the CLI stores it (in UTC). */
function typedDueWait(typed: string, zone: TimeZone): Task {
  const due = storedDeadline(typed, NOW, zone) ?? assert.fail(`${typed} does not read as a deadline`);
  return testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, statusAt: '2030-01-08T09:50:00.000Z', due });
}

const TASKS = new Map([ownerWait('T1', '2030-01-07T08:00:00.000Z'), ownerWait('T2', '2030-01-08T09:00:00.000Z')].map((task) => [task.id, task]));

describe("a team's decision batch", () => {
  it('counts every wait not yet asked before any batch or meeting', async () => {
    const { batch } = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, TASKS, NOW, TimeZone.UTC);
    assert.deepEqual(
      batch.pending.map((task) => task.id),
      ['T1', 'T2'],
    );
  });

  it('counts a wait asked by the later of the last batch asked and the last meeting start', async () => {
    const files = new MemoryFiles();
    await new AskedStore(files, PATHS.decisionsAsked).write({ askedAt: '2030-01-07T09:00:00.000Z', by: 'lead', ids: ['T1'] });
    assert.deepEqual(
      (await teamDecisions(files, PATHS, CONFIG, TASKS, NOW, TimeZone.UTC)).batch.pending.map((task) => task.id),
      ['T2'],
    );
    await new MeetingStore(files, PATHS.meeting).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null });
    assert.deepEqual((await teamDecisions(files, PATHS, CONFIG, TASKS, NOW, TimeZone.UTC)).batch.pending, []);
  });

  it("reads a due typed on the team's clock, so a wait due before the next batch is asked at once", async () => {
    const urgent = typedDueWait('14:00', JERUSALEM);
    assert.equal(urgent.due, '2030-01-08 12:00', '14:00 IST, stored in UTC');
    const local = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, new Map([[urgent.id, urgent]]), NOW, JERUSALEM);
    assert.equal(local.tree.zone, JERUSALEM);
    assert.deepEqual(local.batch.trigger, { kind: 'deadline', task: urgent, due: Date.parse('2030-01-08T12:00:00Z') });
    const late = typedDueWait('14:00', TimeZone.UTC);
    const utc = await teamDecisions(new MemoryFiles(), PATHS, CONFIG, new Map([[late.id, late]]), NOW, TimeZone.UTC);
    assert.equal(utc.batch.trigger, undefined, '14:00 UTC is after the 13:03 batch');
  });
});
