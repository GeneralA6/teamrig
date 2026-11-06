import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { renderPlan } from './plan.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';

const NOW = new Date('2030-01-07T08:00:00Z');
const WEEK = '2030-01-07';

describe('renderPlan', () => {
  it('renders the week by band with each status, each line naming its class and score', () => {
    const week = WEEK;
    const tasks = [
      testTask({ id: 'T1', week, priority: 2, status: 'done', evidence: 'abc1234' }),
      testTask({ id: 'T2', week, priority: 1, source: 'owner', due: '2030-01-08', goals: ['G1'] }),
      testTask({ id: 'T3', week, priority: 2, status: 'waiting', note: 'waiting on disk', waits: [{ kind: 'decision', who: 'owner' }, { kind: 'task', id: 'T4' }] }),
      testTask({ id: 'T4', week, priority: 2, status: 'dropped', note: 'merged into T1' }),
      testTask({ id: 'T5', week, priority: 2, status: 'in-progress' }),
      testTask({ id: 'T6', week: '2030-01-14' }),
      testTask({ id: 'T7', week, priority: 2, status: 'verifying', note: 'the nightly run is green', waits: [{ kind: 'task', id: 'T5' }] }),
      testTask({ id: 'T8', week, priority: 2, after: ['T5', 'T3'], size: 1.5 }),
    ];
    const ranking = testRanking({ classes: { T2: 'Roadmap', T3: 'Maintenance', T5: 'Roadmap' } });
    assert.equal(
      renderPlan(tasks, week, NOW, TimeZone.UTC, { ranking }),
      [
        '# Week plan 2030-01-07',
        '',
        '7 tasks: 1 done, 1 dropped, 5 to do. From the task register at 2030-01-07 08:00 UTC.',
        '',
        '## Expedite',
        '',
        '- [ ] **T2** Add a health check (Roadmap · score 63.33 · alpha · due 01-08 · owner order · G1)',
        '',
        '## Roadmap and Maintenance',
        '',
        '- [ ] **T5** Add a health check (Roadmap · score 11.67 · alpha · from lead) (in progress)',
        '- [ ] **T3** Add a health check (Maintenance · score 35 · alpha · from lead) **waiting:** decision owner · on T4 ready; waiting on disk',
        '',
        '## Other work',
        '',
        '- [x] **T1** Add a health check (Improvements · alpha · from lead) done: abc1234',
        '- [ ] **T4** ~~Add a health check~~ (Improvements · alpha · from lead) dropped: merged into T1',
        '- [ ] **T7** Add a health check (Improvements · score 3.33 · alpha · from lead) verifying, proof: the nightly run is green; waiting: on T5',
        '- [ ] **T8** Add a health check (Improvements · score 0.67 · alpha · after T5,T3 · from lead · size 1.5%)',
      ].join('\n'),
    );
  });

  it("heads each band from the team's own class names, expedite first", () => {
    const tasks = [testTask({ id: 'T1', week: WEEK }), testTask({ id: 'T2', week: WEEK }), testTask({ id: 'T3', week: WEEK, priority: 1, source: 'owner' })];
    const base = testRanking({ classes: { T2: 'Product' } });
    const ranking = { ...base, focus: { ...base.focus, roadmapClass: 'Product', maintenanceClass: 'Upkeep' } };
    const plan = renderPlan(tasks, WEEK, NOW, TimeZone.UTC, { ranking });
    assert.match(plan, /\n## Expedite\n\n- \[ \] \*\*T3\*\* [^\n]*\n\n## Product and Upkeep\n\n- \[ \] \*\*T2\*\* [^\n]*\n\n## Other work\n\n- \[ \] \*\*T1\*\* /);
  });

  it('heads no band that holds no task of the week', () => {
    const plan = renderPlan([testTask({ id: 'T1', week: WEEK }), testTask({ id: 'T2', week: '2030-01-14', priority: 1, source: 'owner' })], WEEK, NOW, TimeZone.UTC, { ranking: testRanking() });
    assert.deepEqual(plan.split('\n').filter((line) => line.startsWith('## ')), ['## Other work']);
  });

  it("reads a wait on another register's task there", () => {
    const tasks = [testTask({ id: 'T1', week: WEEK, status: 'waiting', waits: [{ kind: 'task', id: 'T20' }, { kind: 'task', id: 'T21' }] })];
    const elsewhere = new Map([
      ['T20', { team: 'web', task: testTask({ id: 'T20', status: 'in-progress' }) }],
      ['T21', { team: 'web', task: testTask({ id: 'T21', status: 'done' }) }],
    ]);
    const plan = renderPlan(tasks, WEEK, NOW, TimeZone.UTC, { elsewhere, ranking: testRanking() });
    assert.match(plan, /\*\*waiting:\*\* on T20 · on T21 ready$/m);
  });

  it('orders and dates each task by its effective due, naming the task it comes from', () => {
    const tasks = [
      testTask({ id: 'T1', week: WEEK, due: '2030-01-12' }),
      testTask({ id: 'T2', week: WEEK }),
      testTask({ id: 'T3', owner: 'beta', due: '2030-01-09', after: ['T2'] }),
    ];
    const lines = renderPlan(tasks, WEEK, NOW, TimeZone.UTC, { ranking: testRanking() }).split('\n').filter((line) => line.startsWith('- ['));
    assert.deepEqual(lines, [
      '- [ ] **T2** Add a health check (Improvements · score 18.33 · alpha · due 01-09 from T3 · from lead)',
      '- [ ] **T1** Add a health check (Improvements · score 3.33 · alpha · due 01-12 · from lead)',
    ]);
  });

  it('lists the fit lines under the counts', () => {
    const text = renderPlan([testTask({ id: 'T1', week: WEEK, size: 2 })], WEEK, NOW, TimeZone.UTC, { fit: ['fits: p2 2% (left 9% of the week)'], ranking: testRanking() });
    assert.ok(text.includes('1 to do. From the task register at 2030-01-07 08:00 UTC.\n\n- fits: p2 2% (left 9% of the week)\n\n## Other work'), text);
  });
});


describe('renderPlan and parked tasks', () => {
  it('leaves a parked task out of the week', () => {
    const tasks = [
      testTask({ id: 'T1', week: WEEK, workClass: 'Improvements', updatedAt: '2029-12-01T08:00:00.000Z' }),
      testTask({ id: 'T2', week: WEEK, workClass: 'Improvements', updatedAt: NOW.toISOString() }),
    ];
    const text = renderPlan(tasks, WEEK, NOW, TimeZone.UTC, { ranking: testRanking() });
    assert.ok(text.includes('1 tasks: 0 done, 0 dropped, 1 to do.'), text);
    assert.doesNotMatch(text, /\bT1\b/);
  });
});

describe("renderPlan in the team's zone", () => {
  it('stamps the plan there, zone-marked', () => {
    const text = renderPlan([testTask({ id: 'T1', week: WEEK })], WEEK, NOW, JERUSALEM, { ranking: testRanking() });
    assert.ok(text.includes('From the task register at 2030-01-07 10:00 IST.'), text);
  });
});
