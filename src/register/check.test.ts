import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testConfig } from '../testing/config.ts';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { checkTasks, formatFlag, leaderWaitFlags, PACE_DAYS, peerWaitFlags } from './check.ts';
import { RETAIN_DAYS } from './compaction.ts';
import type { Task } from './fold.ts';
import { NO_TASKS_ELSEWHERE, TaskTree } from './tree.ts';
import { WATCH_USAGE } from './verify.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const FRESH = '2030-01-10T09:00:00.000Z';
const CONFIG = testConfig().register;
/** A read with no task in it, at NOW: each flagged task keeps its own due. */
const TREE = new TaskTree(new Map(), NOW, TimeZone.UTC);

describe('checkTasks', () => {
  const kinds = (tasks: Parameters<typeof checkTasks>[0], week: string | null = null) =>
    checkTasks(tasks, NOW, TimeZone.UTC, week, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}`);

  it('flags overdue tasks; a bare day is due at its end', () => {
    assert.deepEqual(kinds([testTask({ due: '2030-01-09', ownerSeenAt: FRESH, updatedAt: FRESH })]), ['OVERDUE T1']);
    assert.deepEqual(kinds([testTask({ due: '2030-01-10', ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('flags a verifying task past its verify-by date, not as overdue work', () => {
    const late = testTask({ status: 'verifying', due: '2030-01-09', ownerSeenAt: FRESH, updatedAt: FRESH });
    assert.deepEqual(kinds([late]), ['VERIFY-OVERDUE T1']);
    const [flag] = checkTasks([late], NOW, TimeZone.UTC, null, CONFIG);
    assert.ok(flag);
    assert.equal(formatFlag(flag, undefined, TREE), 'VERIFY-OVERDUE (verify by 01-09) T1 verifying, p2, owner alpha, due 01-09, from lead | Add a health check');
    assert.deepEqual(kinds([testTask({ status: 'verifying', due: '2030-01-10', ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('flags a verifying task another active task needs first, naming those tasks', () => {
    const shipped = testTask({ id: 'T1', status: 'verifying', due: '2030-01-11', ownerSeenAt: FRESH, updatedAt: FRESH });
    const after = testTask({ id: 'T2', owner: 'bravo', after: ['T1'], ownerSeenAt: FRESH, updatedAt: FRESH });
    const waits = testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'task', id: 'T1' }], ownerSeenAt: FRESH, updatedAt: FRESH });
    const finished = testTask({ id: 'T4', status: 'done', after: ['T1'] });
    assert.deepEqual(kinds([shipped, after, finished]), ['VERIFY-BLOCKS T1']);
    const flags = checkTasks([shipped, after, waits], NOW, TimeZone.UTC, null, CONFIG).filter((flag) => flag.kind === 'VERIFY-BLOCKS');
    assert.deepEqual(flags.map((flag) => flag.detail), ['T2 (owner bravo), T3 (owner alpha) need it; prove it or reopen it']);
    assert.equal(checkTasks([shipped, after], NOW, TimeZone.UTC, null, CONFIG)[0]?.detail, 'T2 (owner bravo) needs it; prove it or reopen it');
  });

  it('reads the effective due: a task is late, due this week or quietly verifying by the due of a task that needs it', () => {
    const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
    const needer = (due: string, extra: Parameters<typeof testTask>[0] = {}) => testTask({ id: 'T2', owner: 'bravo', due, after: ['T1'], ...seen, ...extra });
    const work = testTask({ id: 'T1', ...seen });
    const late = checkTasks([work, needer('2030-01-09')], NOW, TimeZone.UTC, null, CONFIG);
    assert.deepEqual(late.map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`), ['OVERDUE T1: due 01-09, from T2', 'OVERDUE T2: due 01-09']);
    const shipped = testTask({ id: 'T1', status: 'verifying', ownerSeenAt: '2030-01-01T08:00:00.000Z', updatedAt: '2030-01-01T08:00:00.000Z' });
    const proof = checkTasks([shipped, needer('2030-01-09')], NOW, TimeZone.UTC, null, CONFIG);
    assert.deepEqual(proof.map((flag) => `${flag.kind} ${flag.task.id}`), ['OVERDUE T2', 'VERIFY-OVERDUE T1', 'VERIFY-BLOCKS T1']);
    assert.equal(proof[1]?.detail, 'verify by 01-09, from T2');
    assert.deepEqual(kinds([shipped, needer('2030-01-12')]), ['VERIFY-BLOCKS T1'], 'an inherited date keeps a verifying task from going stale');
    assert.deepEqual(kinds([work, needer('2030-01-12', { week: '2030-01-07' })], '2030-01-07'), ['DUE-UNPLANNED T1']);
  });

  it('flags each loop among active tasks once, on its lowest task, with how its first link goes', () => {
    const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
    const planned = testTask({ id: 'T1', after: ['T2'], ...seen });
    const held = testTask({ id: 'T2', owner: 'bravo', status: 'waiting', waits: [{ kind: 'task', id: 'T1' }], ...seen });
    const waiter = testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'task', id: 'T4' }], ...seen });
    const back = testTask({ id: 'T4', owner: 'bravo', after: ['T3'], ...seen });
    assert.deepEqual(checkTasks([planned, held, waiter, back], NOW, TimeZone.UTC, null, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`), [
      'LOOP T1: T1 -> T2 -> T1 is a loop, and no task in a loop can finish: make the step T1 needs from T2 its own task: teamrig add --owner bravo --title "<the step>", then teamrig update T1 --after <its id>',
      'LOOP T3: T3 -> T4 -> T3 is a loop, and no task in a loop can finish: make the step T3 needs from T4 its own task: teamrig set T3 --status waiting --ask bravo --text "<the step>"',
    ]);
    assert.deepEqual(kinds([planned, { ...held, status: 'done', waits: [] }]), [], 'a finished task closes no loop');
  });

  it('flags the oldest verifying task of an owner holding more than maxVerifying, never with 0', () => {
    const verifying = (n: number, owner = 'alpha') =>
      testTask({ id: `T${n}`, owner, status: 'verifying', due: '2030-01-11', statusAt: `2030-01-0${n}T08:00:00.000Z`, ownerSeenAt: FRESH, updatedAt: FRESH });
    const pile = [verifying(3), verifying(2), verifying(4), verifying(5, 'bravo')];
    const two = { ...CONFIG, maxVerifying: 2 };
    assert.deepEqual(checkTasks(pile, NOW, TimeZone.UTC, null, two).map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`), [
      'PILE-UP T2: alpha holds 3 verifying tasks, more than 2; this is the oldest',
    ]);
    assert.deepEqual(kinds(pile), [], 'the default allows 5');
    assert.deepEqual(checkTasks(pile, NOW, TimeZone.UTC, null, { ...CONFIG, maxVerifying: 0 }), []);
  });

  it('flags a verifying task whose proof was put off maxReparks times, never with 0', () => {
    const parked = (reparks: number) => testTask({ status: 'verifying', due: '2030-01-11', reparks, ownerSeenAt: FRESH, updatedAt: FRESH });
    assert.deepEqual(checkTasks([parked(2)], NOW, TimeZone.UTC, null, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`), [
      `REPARKED T1: its proof was put off to other waits 2 times [register.maxReparks]: run the proof now, close it done with ${WATCH_USAGE} if tests or a dry run proved it, or reopen it`,
    ]);
    assert.deepEqual(kinds([parked(1)]), []);
    assert.deepEqual(checkTasks([parked(5)], NOW, TimeZone.UTC, null, { ...CONFIG, maxReparks: 0 }), []);
  });

  it('lets a verifying task with a due date wait quietly for its proof, and calls one with none stale', () => {
    const quiet = (due: string | null) => testTask({ status: 'verifying', due, ownerSeenAt: '2030-01-01T08:00:00.000Z', updatedAt: '2030-01-01T08:00:00.000Z' });
    assert.deepEqual(kinds([quiet('2030-01-12')]), []);
    assert.deepEqual(kinds([quiet(null)]), ['STALE T1']);
  });

  it('lets a verifying task with no due date stay quiet while its proof waits for a time to come', () => {
    const parked = testTask({ status: 'verifying', waits: [{ kind: 'time', at: '2030-01-12 09:00' }], ownerSeenAt: '2030-01-01T08:00:00.000Z', updatedAt: '2030-01-01T08:00:00.000Z' });
    assert.deepEqual(kinds([parked]), []);
  });

  it('lets a waiting task parked until a time to come stay quiet, and calls it stale once that time passed', () => {
    const parked = (at: string) =>
      testTask({ status: 'waiting', waits: [{ kind: 'time', at }], ownerSeenAt: '2030-01-01T08:00:00.000Z', updatedAt: '2030-01-01T08:00:00.000Z' });
    assert.deepEqual(kinds([parked('2030-01-12 09:00')]), []);
    assert.deepEqual(kinds([parked('2030-01-09 09:00')]), ['READY T1', 'STALE T1']);
  });

  it('flags a waiting task with no reason, as an older teamrig wrote it', () => {
    const bare = testTask({ status: 'waiting', waits: [], ownerSeenAt: FRESH, updatedAt: FRESH });
    const flags = checkTasks([bare], NOW, TimeZone.UTC, null, CONFIG);
    assert.deepEqual(flags.map((flag) => `${flag.kind}: ${flag.detail}`), ['NO-REASON: set what it waits for (--waits) or its next status']);
    assert.deepEqual(kinds([testTask({ status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }], ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('flags a task its owner has not touched since assignment, instead of calling it stale', () => {
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T11:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' })]), [
      'NOT-PICKED-UP T1',
    ]);
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T13:00:00.000Z', updatedAt: FRESH })]), []);
  });

  it('flags tasks with no event for the stale window', () => {
    const old = testTask({ ownerSeenAt: '2030-01-07T08:00:00.000Z', updatedAt: '2030-01-07T11:00:00.000Z', updatedBy: 'bravo' });
    const flags = checkTasks([old], NOW, TimeZone.UTC, null, CONFIG);
    assert.deepEqual(flags.map((flag) => formatFlag(flag, undefined, TREE)), ['STALE (last event 01-07 11:00 UTC by bravo) T1 open, p2, owner alpha, from lead | Add a health check']);
  });

  it('flags owner orders and tasks due this week that are outside the week plan', () => {
    const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
    const tasks = [
      testTask({ id: 'T1', source: 'owner', ...seen }),
      testTask({ id: 'T2', due: '2030-01-12', ...seen }),
      testTask({ id: 'T3', due: '2030-01-14', ...seen }),
      testTask({ id: 'T4', source: 'owner', week: '2030-01-07', ...seen }),
      testTask({ id: 'T5', source: 'owner', status: 'done', ...seen }),
    ];
    assert.deepEqual(kinds(tasks, '2030-01-07'), ['OWNER-UNPLANNED T1', 'DUE-UNPLANNED T2']);
    assert.deepEqual(kinds(tasks), [], 'no week plan, no week flags');
  });

  it('reports the most urgent kinds first', () => {
    const tasks = [
      testTask({ id: 'T1', ownerSeenAt: FRESH, updatedAt: '2030-01-01T00:00:00.000Z' }),
      testTask({ id: 'T2', due: '2030-01-08', ownerSeenAt: FRESH, updatedAt: FRESH, priority: 4 }),
    ];
    assert.deepEqual(kinds(tasks), ['OVERDUE T2', 'STALE T1']);
  });

  it('reads its thresholds from the config', () => {
    const quick = testConfig({ register: { check: { staleAfterHours: 1, notPickedUpAfterHours: 1, weekLengthDays: 7 } } }).register;
    const flags = checkTasks([testTask({ ownerSeenAt: '2030-01-10T10:00:00.000Z', updatedAt: '2030-01-10T10:00:00.000Z' })], NOW, TimeZone.UTC, null, quick);
    assert.deepEqual(flags.map((flag) => flag.kind), ['STALE']);
  });
});

describe('checkTasks: URGENT', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const urgent = testTask({ id: 'T1', priority: 0, ...seen });
  const flags = (tasks: Parameters<typeof checkTasks>[0]) => checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG);
  const urgentIds = (tasks: Parameters<typeof checkTasks>[0]) => flags(tasks).filter((flag) => flag.kind === 'URGENT').map((flag) => flag.task.id);

  it('flags an open p0 free to start before every other kind: its owner starts it now, ahead of the task in hand', () => {
    const stale = testTask({ id: 'T2', ownerSeenAt: FRESH, updatedAt: '2030-01-01T00:00:00.000Z' });
    const raised = flags([stale, urgent]);
    assert.deepEqual(raised.map((flag) => `${flag.kind} ${flag.task.id}`), ['URGENT T1', 'STALE T2']);
    const [first] = raised;
    assert.ok(first);
    assert.equal(formatFlag(first, undefined, TREE),'URGENT (p0: start it now, ahead of the task in hand) T1 open, p0, owner alpha, from lead | Add a health check');
  });

  it("names the lead's deadline burst on its effective due, typed on the team's clock: its own or a later task's", () => {
    const own = flags([{ ...urgent, due: '2030-01-12 09:30' }])[0]?.detail;
    assert.equal(own, 'p0: start it now, ahead of the task in hand; to finish it by its due, the lead may run burst start deadline --task T1 --by "2030-01-12 09:30 UTC" --stop-pct <n> --reason "<why>"');
    const needer = testTask({ id: 'T3', priority: 2, after: ['T1'], due: '2030-01-11 08:00', ...seen });
    assert.match(flags([urgent, needer])[0]?.detail ?? '', /--task T1 --by "2030-01-11 08:00 UTC" /);
  });

  it('leaves a p0 in progress, waiting, verifying or planned after a task not finished yet alone, and an open p1', () => {
    const first = testTask({ id: 'T3', priority: 2, ...seen });
    assert.deepEqual(urgentIds([{ ...urgent, status: 'in-progress' }]), []);
    assert.deepEqual(urgentIds([{ ...urgent, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD }]), []);
    assert.deepEqual(urgentIds([{ ...urgent, status: 'verifying' }]), []);
    assert.deepEqual(urgentIds([{ ...urgent, after: ['T3'] }, first]), []);
    assert.deepEqual(urgentIds([{ ...urgent, priority: 1 }]), []);
    assert.deepEqual(urgentIds([{ ...urgent, after: ['T3'] }, { ...first, status: 'done' }]), ['T1'], 'free once the task before it finished');
  });
});

describe('leaderWaitFlags', () => {
  const focus = { roadmapClass: 'Roadmap', defaultClass: 'Improvements', leaderWaitMinutes: 60 };
  const askedAt = '2030-01-10T10:30:00.000Z';
  const held = (id: string, who: string, owner = 'alpha') => testTask({ id, owner, status: 'waiting', workClass: 'Roadmap', waits: [{ kind: 'approval', who }], waitsAt: askedAt });
  const details = (tasks: readonly Task[], tree = new LeadTree(testConfig())) => leaderWaitFlags(tasks, tree, focus, NOW.getTime()).map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`);

  it('names the wait, how long it stood and the limit, in the order given', () => {
    assert.deepEqual(details([held('T2', 'lead'), held('T1', 'lead')]), [
      'ROADMAP-WAITS-ON-LEAD T2: approval:lead unanswered for 90 min, past the 60 min limit: answer it first',
      'ROADMAP-WAITS-ON-LEAD T1: approval:lead unanswered for 90 min, past the 60 min limit: answer it first',
    ]);
  });

  it('raises one flag on a task held on two leaders, naming both', () => {
    const tree = new LeadTree(testConfig({ leads: { bravo: ['alpha'] } }));
    const both = testTask({ status: 'waiting', workClass: 'Roadmap', waits: [{ kind: 'approval', who: 'bravo' }, { kind: 'decision', who: 'lead' }], waitsAt: askedAt });
    assert.deepEqual(details([both], tree), ['ROADMAP-WAITS-ON-LEAD T1: approval:bravo, decision:lead unanswered for 90 min, past the 60 min limit: answer it first']);
  });

  it("reads the leaders of each task's own owner, so a wait on a leader of someone else is no hold", () => {
    const tree = new LeadTree(testConfig({ leads: { bravo: ['alpha'] } }));
    assert.deepEqual(details([held('T1', 'bravo'), held('T2', 'bravo', 'charlie')], tree).map((line) => line.slice(0, 25)), ['ROADMAP-WAITS-ON-LEAD T1:']);
  });

  it('flags nothing inside the limit', () => {
    assert.deepEqual(details([testTask({ status: 'waiting', workClass: 'Roadmap', waits: [{ kind: 'approval', who: 'lead' }], waitsAt: '2030-01-10T11:30:00.000Z' })]), []);
  });
});

describe('peerWaitFlags', () => {
  it("flags a waiting task, or a verifying task's proof, on a peer's decision or approval, as an older teamrig wrote it, naming the ask to make", () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T4' }, { kind: 'approval', who: 'bravo' }, { kind: 'decision', who: 'alpha' }] }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }, { kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T3', status: 'verifying', proof: 'the run', waits: [{ kind: 'approval', who: 'bravo' }] }),
    ];
    assert.deepEqual(
      peerWaitFlags(tasks, new LeadTree(testConfig()), {}, 'owner').map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`),
      [
        `PEER-WAIT T1: approval:bravo is a peer's work: wait on it by its task (set T1 --status waiting --ask bravo --text "<the work>")`,
        `PEER-WAIT T3: approval:bravo is a peer's work: wait on it by its task (set T3 --status waiting --ask bravo --text "<the work>")`,
      ],
    );
  });

  it("takes an approval of the security reviewer's on another's task, never on its own or as a decision (T828)", () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'approval', who: 'bravo' }] }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'decision', who: 'bravo' }] }),
      testTask({ id: 'T3', owner: 'bravo', status: 'waiting', waits: [{ kind: 'approval', who: 'bravo' }] }),
    ];
    assert.deepEqual(
      peerWaitFlags(tasks, new LeadTree(testConfig()), { securityReviewer: 'bravo' }, 'owner').map((flag) => flag.task.id),
      ['T2', 'T3'],
    );
  });
});

describe('checkTasks: PRIORITY-SKIP', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const since = (iso: string) => ({ assignedAt: iso, statusAt: iso, priorityAt: iso });
  /** alpha's task open since 01-08 09:00, Roadmap under `roadmap`, and its unclassed task in progress since 01-08 10:00. */
  const waiting = testTask({ id: 'T1', ...seen, ...since('2030-01-08T09:00:00.000Z') });
  const working = testTask({ id: 'T2', status: 'in-progress', ...seen, ...since('2030-01-08T10:00:00.000Z') });
  const roadmap = testRanking({ classes: { T1: 'Roadmap' } });
  const firstGoal = { tag: 'A1', rank: 1 };
  const skips = (tasks: Parameters<typeof checkTasks>[0], ranking = roadmap, config = CONFIG) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, config, NO_TASKS_ELSEWHERE, ranking).map((flag) => formatFlag(flag, undefined, TREE));

  it('flags work in progress in a worse band than its own open task, counted from the later of the two', () => {
    assert.deepEqual(skips([waiting, working]), [
      'PRIORITY-SKIP (T1 (Roadmap, score 10) waits open, skipped since 01-08 10:00 UTC) T2 in-progress, p2, owner alpha, from lead | Add a health check',
    ]);
  });

  it('flags a lower score in the same band, and leaves a tie on band and score alone', () => {
    const classes = { T1: 'Roadmap', T2: 'Roadmap' };
    assert.match(skips([waiting, working], testRanking({ classes, goals: { T1: firstGoal } }))[0] ?? '', /^PRIORITY-SKIP \(T1 \(Roadmap, score 66\.67\) waits open/);
    assert.deepEqual(skips([waiting, working], testRanking({ classes })), []);
  });

  it('reads the band before the score', () => {
    assert.equal(skips([waiting, { ...working, size: 0.05 }]).length, 1, 'a better band with a lower score');
    assert.deepEqual(skips([{ ...waiting, size: 0.05 }, working], testRanking({ classes: { T2: 'Roadmap' } })), [], 'a worse band with a higher score');
  });

  it('reads no priority', () => {
    assert.deepEqual(skips([{ ...waiting, priority: 1 }, { ...working, priority: 3 }], testRanking()), [], 'equals, one of them a p1');
    assert.equal(skips([{ ...waiting, priority: 3 }, { ...working, priority: 1 }]).length, 1, 'a p1 in progress below a p3 of a better band');
  });

  it('calls a skipped task of the expedite band that, not by its class', () => {
    assert.match(skips([{ ...waiting, critical: true }, working], testRanking({ classes: { T1: 'Maintenance' } }))[0] ?? '', /^PRIORITY-SKIP \(T1 \(expedite, score 66\.67\) waits open/);
  });

  it("leaves a waiting task, another owner's task, one already in progress and work that is not in progress alone", () => {
    assert.deepEqual(skips([{ ...waiting, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD }, working]), []);
    assert.deepEqual(skips([{ ...waiting, owner: 'bravo' }, working]), []);
    assert.deepEqual(skips([{ ...waiting, status: 'in-progress' }, working]), []);
    assert.deepEqual(skips([waiting, { ...working, status: 'open' }]), []);
  });

  it('waits the configured hours after the latest owner, status or priority change of either task', () => {
    const recent = '2030-01-10T00:00:00.000Z';
    assert.deepEqual(skips([{ ...waiting, priorityAt: recent }, working]), [], 'its priority changed 12 h ago');
    assert.deepEqual(skips([{ ...waiting, statusAt: recent }, working]), [], 'back from waiting 12 h ago');
    assert.deepEqual(skips([waiting, { ...working, assignedAt: recent }]), [], 'handed to alpha 12 h ago');
    const quick = testConfig({ register: { check: { prioritySkipAfterHours: 6 } } }).register;
    assert.equal(skips([{ ...waiting, statusAt: recent }, working], roadmap, quick).length, 1);
  });

  it('names the best-ranked open task, and of equals the one that has stood longest', () => {
    const older = testTask({ id: 'T3', ...seen, ...since('2030-01-07T09:00:00.000Z') });
    const newer = { ...waiting, ...since('2030-01-08T11:00:00.000Z') };
    const classes = { T1: 'Roadmap', T3: 'Roadmap' };
    assert.match(skips([newer, older, working], testRanking({ classes }))[0] ?? '', /^PRIORITY-SKIP \(T3 \(Roadmap, score 10\) waits open, skipped since 01-08 10:00 UTC\) T2 /);
    assert.match(skips([newer, older, working], testRanking({ classes, goals: { T1: firstGoal } }))[0] ?? '', /^PRIORITY-SKIP \(T1 \(Roadmap, score 66\.67\) waits open, skipped since 01-08 11:00 UTC\) T2 /);
  });

  it('ranks past a pin, which puts a task first in plan order without outranking anything', () => {
    const pinned = testTask({ id: 'T3', pin: 'lead', ...seen, ...since('2030-01-07T09:00:00.000Z') });
    const ranking = testRanking({ classes: { T1: 'Roadmap', T3: 'Roadmap' }, goals: { T1: firstGoal } });
    assert.match(skips([pinned, waiting, working], ranking)[0] ?? '', /^PRIORITY-SKIP \(T1 \(Roadmap, score 66\.67\) /);
  });

  it('leaves a task planned after one not finished yet alone, and counts it once that task finished', () => {
    const first = testTask({ id: 'T3', owner: 'bravo', status: 'open', ...seen, ...since('2030-01-08T09:00:00.000Z') });
    const planned = { ...waiting, after: ['T3'] };
    assert.deepEqual(skips([planned, working, first]), []);
    assert.equal(skips([planned, working, { ...first, status: 'done' }]).length, 1);
    assert.equal(skips([planned, working]).length, 1, 'a task the read lacks was retired, so finished');
  });

  it('raises nothing on a read with no ranking', () => {
    assert.deepEqual(checkTasks([waiting, working], NOW, TimeZone.UTC, null, CONFIG), []);
  });
});

describe('checkTasks: READY', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const ready = (tasks: Parameters<typeof checkTasks>[0]) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG)
      .filter((flag) => flag.kind === 'READY')
      .map((flag) => flag.task.id);

  it('flags a waiting task once every reason cleared: its tasks finished and its time passed', () => {
    const done = testTask({ id: 'T2', status: 'done', ...seen });
    const busy = testTask({ id: 'T3', status: 'in-progress', ...seen });
    const passed = { kind: 'time' as const, at: '2030-01-10 11:00' };
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T2' }, passed], ...seen }),
      testTask({ id: 'T4', status: 'waiting', waits: [{ kind: 'task', id: 'T3' }], ...seen }),
      testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'time', at: '2030-01-10 13:00' }], ...seen }),
      testTask({ id: 'T6', status: 'waiting', waits: [passed, { kind: 'decision', who: 'owner' }], ...seen }),
      testTask({ id: 'T7', status: 'waiting', ...seen }),
      testTask({ id: 'T8', status: 'waiting', waits: [{ kind: 'task', id: 'T99' }], ...seen }),
      done,
      busy,
    ];
    assert.deepEqual(ready(tasks), ['T1', 'T8'], 'a task the read lacks was retired, so finished');
  });

  it('prints why, with each ready reason marked', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', note: 'needs the export', waits: [{ kind: 'task', id: 'T2' }], ...seen }),
      testTask({ id: 'T2', status: 'dropped', ...seen }),
    ];
    const [flag] = checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG);
    assert.equal(
      flag === undefined ? undefined : formatFlag(flag, undefined, new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC)),
      'READY (every reason cleared; set its next status) T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: on T2 ready; needs the export)',
    );
  });

  it("reads a wait on another register's task there: ready once that task finished", () => {
    const elsewhere = new Map([
      ['T20', { team: 'web', task: testTask({ id: 'T20', status: 'in-progress' }) }],
      ['T21', { team: 'web', task: testTask({ id: 'T21', status: 'done' }) }],
    ]);
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T20' }], ...seen }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'task', id: 'T21' }], ...seen }),
    ];
    const flagged = checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG, elsewhere).filter((flag) => flag.kind === 'READY');
    assert.deepEqual(
      flagged.map((flag) => flag.task.id),
      ['T2'],
    );
    assert.deepEqual(ready(tasks), ['T1', 'T2'], 'outside a tree, both read retired');
  });

  it("flags a verifying task once its proof's waits cleared, and none whose proof waits for nothing", () => {
    const tasks = [
      testTask({ id: 'T1', status: 'verifying', proof: 'the run', waits: [{ kind: 'task', id: 'T2' }], ...seen }),
      testTask({ id: 'T2', status: 'done', ...seen }),
      testTask({ id: 'T3', status: 'verifying', proof: 'the run', waits: [{ kind: 'time', at: '2030-01-10 13:00' }], ...seen }),
      testTask({ id: 'T4', status: 'verifying', proof: 'the run', ...seen }),
    ];
    assert.deepEqual(ready(tasks), ['T1']);
    const flag = checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG).find((candidate) => candidate.kind === 'READY');
    assert.equal(flag?.detail, 'every wait of its proof cleared; verify it now');
  });
});

describe('checkTasks: OFF-GOAL', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const kinds = (tasks: Parameters<typeof checkTasks>[0], week: string | null = '2030-01-07') =>
    checkTasks(tasks, NOW, TimeZone.UTC, week, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}`);

  it('flags work in progress with no goal outside the week plan', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'in-progress', ...seen }),
      testTask({ id: 'T2', status: 'in-progress', goals: ['G1'], ...seen }),
      testTask({ id: 'T3', status: 'in-progress', week: '2030-01-07', ...seen }),
      testTask({ id: 'T4', ...seen }),
      testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, ...seen }),
    ];
    assert.deepEqual(kinds(tasks), ['OFF-GOAL T1']);
    assert.deepEqual(kinds(tasks, null), [], 'no week plan, no week flags');
    assert.deepEqual(
      checkTasks(tasks, NOW, TimeZone.UTC, '2030-01-07', CONFIG).map((flag) => formatFlag(flag, undefined, TREE)),
      ['OFF-GOAL (in progress with no goal, not in week 2030-01-07) T1 in-progress, p2, owner alpha, from lead | Add a health check'],
    );
  });

  it('raises the more specific week flag instead on an owner order or a task due this week', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'in-progress', source: 'owner', ...seen }),
      testTask({ id: 'T2', status: 'in-progress', due: '2030-01-12', ...seen }),
    ];
    assert.deepEqual(kinds(tasks), ['OWNER-UNPLANNED T1', 'DUE-UNPLANNED T2']);
  });
});

describe('checkTasks: NO-CARD', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const noCard = (tasks: Parameters<typeof checkTasks>[0], config = CONFIG) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, config)
      .filter((flag) => flag.kind === 'NO-CARD')
      .map((flag) => `${flag.task.id}: ${flag.detail}`);

  it("flags a wait on the owner's decision or approval with no card, as one set before cards reads", () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], ...seen }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD, ...seen }),
      testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }], ...seen }),
    ];
    assert.deepEqual(noCard(tasks), ['T1: no card for owner to decide from: set it waiting again with --question, --options, --recommend and --default']);
    assert.deepEqual(noCard(tasks, { ...CONFIG, requireDecisionCard: false }), [], 'never with the switch off');
  });

  it("flags a verifying task whose proof waits on the owner's approval with no card, naming its own status", () => {
    const tasks = [testTask({ id: 'T1', status: 'verifying', proof: 'the run', waits: [{ kind: 'approval', who: 'owner' }], ...seen })];
    assert.deepEqual(noCard(tasks), ['T1: no card for owner to decide from: set it verifying again with --question, --options, --recommend and --default']);
  });
});

describe('checkTasks: OWNER-ORDERED', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const flagged = (tasks: Parameters<typeof checkTasks>[0]) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG)
      .filter((flag) => flag.kind === 'OWNER-ORDERED')
      .map((flag) => `${flag.task.id}: ${flag.detail}`);
  const fix = (waits: string, status: string) =>
    `owner ordered it, and an order approves its own work and proof: drop the wait on owner's ${waits}, or set it ${status} again with --why-ask "<how the order must change, what new it needs, or why only owner can see the result>"`;

  it('flags an owner order that asks the owner with no card part saying why, its proof too', () => {
    const tasks = [
      testTask({ id: 'T1', source: 'owner', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD, ...seen }),
      testTask({ id: 'T2', source: 'owner', status: 'verifying', proof: 'the run', waits: [{ kind: 'decision', who: 'owner' }, { kind: 'approval', who: 'owner' }], ...seen }),
      testTask({ id: 'T3', source: 'owner', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: { ...TEST_CARD, whyAsk: 'the ordered tier cannot ship at that price' }, ...seen }),
      testTask({ id: 'T4', source: 'lead', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD, ...seen }),
      testTask({ id: 'T5', source: 'owner', status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }], ...seen }),
    ];
    assert.deepEqual(flagged(tasks), [`T1: ${fix('approval', 'waiting')}`, `T2: ${fix('decision and approval', 'verifying')}`]);
  });
});

describe('checkTasks: UNGATED', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const flagged = (tasks: Parameters<typeof checkTasks>[0], config: typeof CONFIG = CONFIG) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, config)
      .filter((flag) => flag.kind === 'UNGATED')
      .map((flag) => `${flag.task.id}: ${flag.detail}`);
  const fix = (status: string) =>
    `only an owner gate or a business decision is owner's to decide: set it ${status} again with --gate "<the owner gate, or business>", or decide it, or wait on your leader`;
  const tasks = [
    testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD, ...seen }),
    testTask({ id: 'T2', status: 'verifying', proof: 'the run', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD, ...seen }),
    testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, ...seen }),
    testTask({ id: 'T4', status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD, ...seen }),
    testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], ...seen }),
    testTask({ id: 'T6', status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }], card: TEST_CARD, ...seen }),
  ];

  it("flags a wait on the owner's decision whose card names no gate, its proof too; never an approval, a gated or a missing card", () => {
    assert.deepEqual(flagged(tasks), [`T1: ${fix('waiting')}`, `T2: ${fix('verifying')}`]);
  });

  it('flags nothing while cards are not required', () => {
    assert.deepEqual(flagged(tasks, { ...CONFIG, requireDecisionCard: false }), []);
  });
});

describe('checkTasks: SELF-MADE', () => {
  const made = (n: number, overrides: Partial<Task> = {}) =>
    testTask({ id: `T${n}`, owner: 'alpha', source: 'alpha', createdBy: 'alpha', createdAt: '2030-01-10T08:00:00.000Z', ownerSeenAt: FRESH, updatedAt: FRESH, ...overrides });
  const withMax = (maxSelfMadePerDay: number) => ({ ...CONFIG, check: { ...CONFIG.check, maxSelfMadePerDay } });
  const selfMade = (tasks: readonly Task[], config: typeof CONFIG = withMax(3)) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, config).map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`);

  it('flags the first task past the count its owner added for itself in 24 h, never with 0', () => {
    const run = [made(1), made(2), made(3), made(4), made(5)];
    assert.deepEqual(selfMade(run), ['SELF-MADE T4: alpha added 5 tasks for itself in 24 h, more than 3; this is the first still active past 3']);
    assert.deepEqual(selfMade(run.slice(0, 3)), [], 'at the count');
    assert.deepEqual(selfMade(run, withMax(0)), []);
    assert.deepEqual(selfMade(run, CONFIG), [], 'the default allows 10');
  });

  it("counts only an owner's own tasks asked by no one else, created in the 24 h before now", () => {
    const others = [
      made(4, { source: 'lead' }),
      made(5, { createdBy: 'lead', source: 'lead' }),
      made(6, { source: 'owner' }),
      made(7, { owner: 'bravo' }),
      made(8, { createdAt: '2030-01-09T12:00:00.000Z' }),
      made(9, { createdAt: '2030-01-10T13:00:00.000Z' }),
    ];
    const run = [made(1), made(2), made(3), ...others];
    assert.deepEqual(selfMade(run), []);
    assert.deepEqual(selfMade([...run, made(10, { createdAt: '2030-01-09T12:01:00.000Z' })]), [
      'SELF-MADE T10: alpha added 4 tasks for itself in 24 h, more than 3; this is the first still active past 3',
    ]);
    const bravo = [1, 2, 3, 4].map((n) => made(n + 10, { owner: 'bravo', source: 'bravo', createdBy: 'bravo' }));
    assert.deepEqual(selfMade([...run, ...bravo]), ['SELF-MADE T14: bravo added 4 tasks for itself in 24 h, more than 3; this is the first still active past 3']);
  });

  it('counts finished tasks of the run, raises the flag on the first one past the count still active, and none once all are finished', () => {
    const run = [made(1, { status: 'done' }), made(2), made(3), made(4, { status: 'done' }), made(5, { status: 'dropped' }), made(6, { status: 'in-progress', goals: ['G1'] })];
    assert.deepEqual(selfMade(run), ['SELF-MADE T6: alpha added 6 tasks for itself in 24 h, more than 3; this is the first still active past 3']);
    assert.deepEqual(selfMade(run.slice(0, 5)), [], 'the surplus is finished');
  });
});

describe('checkTasks: READY once the lead approved (T684)', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const asking = { status: 'waiting' as const, waits: [{ kind: 'approval' as const, who: 'lead' }], ...seen };
  const answer = (verdict: 'approved' | 'declined') => ({ verdict, by: 'lead', at: FRESH, note: 'checked' });
  const readyOf = (tasks: Task[]) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG)
      .filter((flag) => flag.kind === 'READY')
      .map((flag) => `${flag.task.id}: ${flag.detail}`);

  it('flags a task whose approval wait its giver approved, and sends its owner to push or merge', () => {
    assert.deepEqual(readyOf([testTask({ ...asking, answer: answer('approved') })]), ['T1: lead approved it; push or merge it, then set its next status']);
  });

  it('flags none on a decline, an unanswered wait, an answer from another, or a reason still open', () => {
    const busy = testTask({ id: 'T9', status: 'in-progress', ...seen });
    const tasks = [
      testTask({ id: 'T1', ...asking, answer: answer('declined') }),
      testTask({ id: 'T2', ...asking }),
      testTask({ id: 'T3', ...asking, waits: [{ kind: 'approval', who: 'owner' }], answer: answer('approved') }),
      testTask({ id: 'T4', ...asking, waits: [...asking.waits, { kind: 'task', id: 'T9' }], answer: answer('approved') }),
      busy,
    ];
    assert.deepEqual(readyOf(tasks), []);
  });
});

describe("checkTasks: READY once a leader recorded the owner's decision (T1366)", () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const decided = { by: 'lead', at: FRESH, note: 'human decided: ship it' };
  const flagsOf = (tasks: Task[]) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, CONFIG)
      .filter((flag) => flag.kind === 'READY' || flag.kind === 'NO-REASON')
      .map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`);

  it('flags a decided task with no wait left, or every one left ready, and sends its owner to act on it', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [], decided, ...seen }),
      testTask({ id: 'T2', status: 'verifying', waits: [{ kind: 'time', at: '2030-01-10 11:00' }], decided, ...seen }),
    ];
    assert.deepEqual(flagsOf(tasks), [
      "READY T1: lead recorded owner's decision: act on it (show T1 prints it), then set its next status",
      "READY T2: lead recorded owner's decision: act on it (show T2 prints it), verify it now",
    ]);
  });

  it('flags none while a wait left holds, and NO-REASON only for a waiting task neither waiting nor decided', () => {
    const busy = testTask({ id: 'T9', status: 'in-progress', ...seen });
    const tasks = [testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T9' }], decided, ...seen }), testTask({ id: 'T2', status: 'waiting', ...seen }), busy];
    assert.deepEqual(flagsOf(tasks), ['NO-REASON T2: set what it waits for (--waits) or its next status']);
  });
});

describe('checkTasks: OVER-PACE (T637)', () => {
  const OLD = '2030-01-01T09:00:00.000Z';
  const RECENT = '2030-01-08T09:00:00.000Z';
  const p1 = (n: number, overrides: Partial<Task> = {}) =>
    testTask({ id: `T${n}`, priority: 1, assignedAt: OLD, statusAt: OLD, priorityAt: OLD, ownerSeenAt: FRESH, updatedAt: FRESH, ...overrides });
  const finished = (n: number, overrides: Partial<Task> = {}) => p1(n, { status: 'done', statusAt: RECENT, ...overrides });
  const paces = (tasks: readonly Task[], config: typeof CONFIG = CONFIG) =>
    checkTasks(tasks, NOW, TimeZone.UTC, null, config)
      .filter((flag) => flag.kind === 'OVER-PACE')
      .map((flag) => `${flag.task.id}: ${flag.detail}`);

  it('flags the first held p1 past the count its owner finished in 7 days, in plan order', () => {
    const held = [p1(1), p1(2), p1(3, { status: 'in-progress' })];
    assert.deepEqual(paces([...held, finished(4)]), ['T1: alpha holds 3 unfinished p1 tasks, more than the 1 p1 it finished in 7 days; this is the first past that pace']);
    assert.deepEqual(paces([p1(1), finished(4)]), [], 'at the pace');
    assert.deepEqual(paces([p1(1)]), [], 'one held p1 is in hand at any pace');
    assert.deepEqual(paces([p1(1), p1(2)]), ['T2: alpha holds 2 unfinished p1 tasks and finished no p1 in 7 days; this is the first past the one in hand']);
  });

  it('counts a verifying p1 as finished, not held, and a waiting p1 as held', () => {
    const shipped = p1(4, { status: 'verifying', statusAt: RECENT, proof: 'a night flow' });
    assert.deepEqual(paces([p1(1), shipped]), []);
    const waiting = p1(2, { status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD });
    assert.match(paces([p1(1), waiting, shipped])[0] ?? '', /^T2: alpha holds 2 unfinished p1 tasks, more than the 1 p1 /);
  });

  it('leaves out finishes older than 7 days, dropped tasks and finishes below p1', () => {
    const held = [p1(1), p1(2)];
    assert.equal(paces([...held, finished(4)]).length, 1);
    assert.match(paces([...held, finished(4, { statusAt: '2030-01-03T11:59:00.000Z' })])[0] ?? '', /^T2: .* finished no p1 /);
    assert.match(paces([...held, finished(4, { status: 'dropped' })])[0] ?? '', /^T2: .* finished no p1 /);
    assert.match(paces([...held, finished(4, { priority: 2 })])[0] ?? '', /^T2: .* finished no p1 /);
    assert.deepEqual(paces([p1(1), p1(2, { priority: 2 }), finished(4)]), [], 'a held p2 is not held p1 work');
    assert.match(paces([...held, finished(4), finished(5, { statusAt: '2030-01-10T13:00:00.000Z' })])[0] ?? '', /^T2: .* more than the 1 p1 /, 'a finish after now is not counted');
  });

  it('waits until the owner has held tasks for 7 days', () => {
    const fresh = { assignedAt: '2030-01-03T12:01:00.000Z' };
    assert.deepEqual(paces([p1(1, fresh), p1(2, fresh)]), []);
    assert.equal(paces([p1(1, fresh), p1(2, fresh), finished(4, { status: 'dropped', assignedAt: '2030-01-03T12:00:00.000Z' })]).length, 1, 'a finished task counts for the history');
  });

  it('reads each owner apart, and skips the flag when the config names no priority', () => {
    const bravo = (n: number, overrides: Partial<Task> = {}) => p1(n, { owner: 'bravo', ...overrides });
    const tasks = [p1(1), finished(2), bravo(3), bravo(4), bravo(5, { status: 'done', statusAt: RECENT })];
    assert.deepEqual(paces(tasks), ['T4: bravo holds 2 unfinished p1 tasks, more than the 1 p1 it finished in 7 days; this is the first past that pace']);
    assert.deepEqual(paces(tasks, { ...CONFIG, priorities: [] }), []);
  });

  it('counts over no more days than a compaction keeps finished tasks in the working set', () => {
    assert.ok(PACE_DAYS <= RETAIN_DAYS);
  });
});
