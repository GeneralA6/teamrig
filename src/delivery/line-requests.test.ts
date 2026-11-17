import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EXIT } from '../cli/runtime.ts';
import { CliHarness, EVENTS_PATH, TEAM_HOME } from '../testing/cli-harness.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { lineFrontPath, LineFrontStore } from './line-front-store.ts';
import { requestSourceOf, teamRequestsOf } from './line-requests.ts';
import { processRequest, type LineTask, type RequestFocus } from './process-request.ts';

const FOCUS: RequestFocus = { defaultClass: 'Improvements', allocation: { Roadmap: 60, Maintenance: 25, Improvements: 15 } };
const STATE = join(TEAM_HOME, 'state');
const AT = '2030-01-08T10:00:00.000Z';

describe('requestSourceOf (T4082)', () => {
  it('reads the task and the front again at each call, so a raise or a front put while a step waits shows at its next read', async () => {
    const tasks = new Map<string, LineTask>([['T5', { priority: 2, workClass: 'Maintenance', status: 'in-progress' }]]);
    const front = new LineFrontStore(new MemoryFiles(), lineFrontPath(STATE));
    const source = requestSourceOf(async (id) => tasks.get(id), front, FOCUS);
    assert.deepEqual(await source.current(processRequest('merge', 'T5')), { kind: 'merge', task: 'T5', priority: 2, class: 'Maintenance', classPct: 25 });
    tasks.set('T5', { priority: 0, workClass: 'Maintenance', status: 'in-progress' });
    await front.put({ task: 'T5', at: AT, by: 'lead' });
    assert.deepEqual(await source.current(processRequest('merge', 'T5', 2)), { kind: 'merge', task: 'T5', priority: 0, class: 'Maintenance', classPct: 25, frontAt: AT });
    await front.clear();
    assert.equal((await source.current(processRequest('merge', 'T5', 0))).frontAt, undefined, 'a front taken off leaves the step in its usual place');
  });

  it("fronts no step of another task, nor one of a task the team's register lacks", async () => {
    const front = new LineFrontStore(new MemoryFiles(), lineFrontPath(STATE));
    await front.put({ task: 'T9', at: AT, by: 'lead' });
    const source = requestSourceOf(async (id) => (id === 'T5' ? { priority: 1, workClass: null, status: 'open' } : undefined), front, FOCUS);
    assert.deepEqual(
      [(await source.current(processRequest('test', 'T5'))).frontAt, (await source.current(processRequest('test', 'T9'))).frontAt],
      [undefined, undefined],
    );
  });
});

describe('teamRequestsOf (T4082)', () => {
  it("reads the team's register and the front in its state folder", async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Fix the gate', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    const source = teamRequestsOf(kit.files, { events: EVENTS_PATH, state: STATE }, FOCUS);
    assert.deepEqual(await source.current(processRequest('ship', 'T1')), { kind: 'ship', task: 'T1', priority: 1, class: 'Improvements', classPct: 15 });
    await new LineFrontStore(kit.files, lineFrontPath(STATE)).put({ task: 'T1', at: AT, by: 'lead' });
    assert.equal((await source.current(processRequest('ship', 'T1'))).frontAt, AT);
  });
});
