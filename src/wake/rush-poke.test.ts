import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rush } from '../budget/burst.ts';
import { RUN_RECORD_FORMAT, type DetachedRunRecord } from '../delivery/detached-runs.ts';
import type { LedgerRecord } from '../delivery/ledger.ts';
import { testTask } from '../testing/task.ts';
import { changedSincePoke, decideRushPoke, pokeMarkOf, queuedTasksOf, rushPokePrompt, rushPokeToast, stepRunningFor, type PokeInput, type PokeNow } from './rush-poke.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2030-01-08T20:00:00.000Z');
const IDLE_MS = 5 * MINUTE;
const COST = { w: 210_000, cold: true, weekPct: 0.021 };

const RUSH: Rush = {
  kind: 'rush',
  sessions: ['alpha', 'bravo'],
  helpers: 3,
  hires: 0,
  dailyPct: 5,
  stopPct: 98,
  endsAt: NOW + 4 * HOUR,
  tasks: [],
  goal: 'PROD',
  reason: 'ship PROD',
  by: 'lead',
  at: NOW - 2 * HOUR,
};

const OPEN = testTask({ id: 'T1', priority: 1 });
const ON_GOAL = testTask({ id: 'T2', priority: 2, goals: ['PROD'], status: 'in-progress' });

function input(overrides: Partial<PokeInput> = {}): PokeInput {
  return { rush: RUSH, startable: [OPEN], lastTurnAt: NOW - IDLE_MS, now: NOW, idleMs: IDLE_MS, lastPokeAt: undefined, queued: new Set(), ...overrides };
}

describe('decideRushPoke', () => {
  it('checks again once the tab has sat idle the poke span, and pokes it then', () => {
    assert.deepEqual(decideRushPoke(input({ lastTurnAt: NOW - 2 * MINUTE })), { kind: 'later', at: NOW + 3 * MINUTE });
    assert.deepEqual(decideRushPoke(input()), { kind: 'poke', task: OPEN, idleMs: IDLE_MS });
    assert.deepEqual(decideRushPoke(input({ lastTurnAt: NOW - 75 * MINUTE })), { kind: 'poke', task: OPEN, idleMs: 75 * MINUTE });
  });

  it('pokes once per idle stretch: again only after a new turn', () => {
    assert.deepEqual(decideRushPoke(input({ lastPokeAt: NOW - MINUTE, lastTurnAt: NOW - 10 * MINUTE })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ lastPokeAt: NOW - 10 * MINUTE, lastTurnAt: NOW - 10 * MINUTE })), { kind: 'none' }, 'a poke at the turn itself');
    assert.equal(decideRushPoke(input({ lastPokeAt: NOW - 20 * MINUTE, lastTurnAt: NOW - 10 * MINUTE })).kind, 'poke');
  });

  it('pokes for work left only: waiting or verifying tasks, or none, never poke', () => {
    const waiting = testTask({ id: 'T3', status: 'waiting' });
    const verifying = testTask({ id: 'T4', status: 'verifying' });
    assert.deepEqual(decideRushPoke(input({ startable: [waiting, verifying] })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ startable: [] })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ startable: [waiting, OPEN] })), { kind: 'poke', task: OPEN, idleMs: IDLE_MS });
  });

  it("names the rush goal's task ahead of a more urgent one off the goal", () => {
    assert.deepEqual(decideRushPoke(input({ startable: [OPEN, ON_GOAL] })), { kind: 'poke', task: ON_GOAL, idleMs: IDLE_MS });
  });

  it('pokes not for a task a queued run is for, but for the next one with work left (T3168)', () => {
    assert.deepEqual(decideRushPoke(input({ queued: new Set(['T1']) })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ startable: [OPEN, ON_GOAL], queued: new Set(['T2']) })), { kind: 'poke', task: OPEN, idleMs: IDLE_MS });
    assert.deepEqual(decideRushPoke(input({ queued: new Set(['T9']) })), { kind: 'poke', task: OPEN, idleMs: IDLE_MS });
  });
});

describe('queuedTasksOf', () => {
  const run = (id: string, session: string, what: string): DetachedRunRecord => ({ v: RUN_RECORD_FORMAT, id, team: 'app', session, what, log: `${id}.log`, pid: 4242, startedAt: '2030-01-08T19:00:00.000Z' });

  it("names the task each of the session's runs is for, by its label", () => {
    const runs = [run('r1', 'alpha', 'T1 gate'), run('r2', 'alpha', 'ship T7 merge'), run('r3', 'bravo', 'T2 gate'), run('r4', 'alpha', 'nightly build')];
    assert.deepEqual([...queuedTasksOf(runs, 'alpha')].sort(), ['T1', 'T7']);
  });

  it('names none with no runs', () => {
    assert.equal(queuedTasksOf([], 'alpha').size, 0);
  });

  it('pokes nothing with no rush, an unknown last turn, or a poke due at or past the rush end', () => {
    assert.deepEqual(decideRushPoke(input({ rush: undefined })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ lastTurnAt: undefined })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ rush: { ...RUSH, endsAt: NOW } })), { kind: 'none' });
    assert.deepEqual(decideRushPoke(input({ rush: { ...RUSH, endsAt: NOW - MINUTE } })), { kind: 'none' });
  });
});

function heavy(id: string, session: string, startedAt: number, endedAt: number | null): LedgerRecord {
  return {
    type: 'heavy',
    id,
    session,
    what: 'tests',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    exitCode: endedAt === null ? null : 0,
  };
}

describe('stepRunningFor', () => {
  const MAX_RUN = 60 * MINUTE;

  it('is true for a step of the session that started within the longest run and has not ended', () => {
    assert.equal(stepRunningFor([heavy('a', 'alpha', NOW - 10 * MINUTE, null)], 'alpha', NOW, MAX_RUN), true);
  });

  it('is false for an ended step, one of another session, or a start older than the longest run', () => {
    const ended = [heavy('a', 'alpha', NOW - 10 * MINUTE, null), heavy('a', 'alpha', NOW - 10 * MINUTE, NOW - MINUTE)];
    assert.equal(stepRunningFor(ended, 'alpha', NOW, MAX_RUN), false);
    assert.equal(stepRunningFor([heavy('b', 'bravo', NOW - 10 * MINUTE, null)], 'alpha', NOW, MAX_RUN), false);
    assert.equal(stepRunningFor([heavy('c', 'alpha', NOW - MAX_RUN, null)], 'alpha', NOW, MAX_RUN), false);
  });
});

describe('changedSincePoke (T3407)', () => {
  const POKED_AT = NOW - 30 * MINUTE;
  const before = new Date(POKED_AT - MINUTE).toISOString();
  const after = new Date(POKED_AT + MINUTE).toISOString();
  const held = testTask({ id: 'T1', owner: 'alpha', updatedAt: before, updatedBy: 'lead' });
  const seen = (over: Partial<PokeNow> = {}): PokeNow => ({ session: 'alpha', lines: 3, startable: [held], own: [held], ...over });
  const mark = pokeMarkOf(seen());

  it('marks the inbox lines and the tasks the session could start at the poke', () => {
    assert.deepEqual(mark, { lines: 3, startable: ['T1'] });
  });

  it('sees no change for the same state, nor for the session writing its own note or status since', () => {
    assert.equal(changedSincePoke(mark, POKED_AT, seen()), false);
    const noted = testTask({ id: 'T1', owner: 'alpha', updatedAt: after, updatedBy: 'alpha', note: 'nothing can move' });
    assert.equal(changedSincePoke(mark, POKED_AT, seen({ startable: [noted], own: [noted] })), false);
    assert.equal(changedSincePoke(mark, POKED_AT, seen({ startable: [] })), false, 'a task it can no longer start is no news');
  });

  it('sees a new inbox line, an event on its task by anyone else, and a task it could not start then', () => {
    assert.equal(changedSincePoke(mark, POKED_AT, seen({ lines: 4 })), true);
    const answered = testTask({ id: 'T1', owner: 'alpha', updatedAt: after, updatedBy: 'lead' });
    assert.equal(changedSincePoke(mark, POKED_AT, seen({ own: [answered] })), true);
    const handed = testTask({ id: 'T2', owner: 'alpha', updatedAt: before, updatedBy: 'alpha' });
    assert.equal(changedSincePoke(mark, POKED_AT, seen({ startable: [held, handed] })), true);
  });

  it('counts anything as a change after a poke kept with no mark, as before marks', () => {
    assert.equal(changedSincePoke(undefined, POKED_AT, seen()), true);
  });
});

describe('poke text', () => {
  it('names the rush, the idle span, the task and the cost in the prompt and the toast', () => {
    const prompt = rushPokePrompt('alpha', RUSH, ON_GOAL, 12 * MINUTE, COST);
    assert.match(prompt, /^Rush on PROD: this tab sat idle 12 min with work left/);
    assert.match(prompt, /Start or continue T2 \(Add a health check\) now/);
    assert.match(prompt, /teamrig set T2 --session alpha --status waiting --waits <reason>/);
    assert.match(prompt, /no poke comes again until something changes for you/);
    assert.match(rushPokeToast(RUSH, ON_GOAL, 12 * MINUTE, COST), /^teamrig poked this tab \(rush on PROD, idle 12 min\): T2 \(/);
  });

  it('hands the exact wait on the task the named one is planned after, when that one is not finished (#1516)', () => {
    const prompt = rushPokePrompt('alpha', RUSH, ON_GOAL, 12 * MINUTE, COST, 'T6');
    assert.match(prompt, /It is planned after T6, not finished yet/);
    assert.ok(prompt.includes('`teamrig set T2 --session alpha --status waiting --waits task:T6 --note "..."`'), prompt);
    assert.doesNotMatch(prompt, /<reason>/);
  });
});
