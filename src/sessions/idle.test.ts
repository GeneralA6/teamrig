import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../core/guards.ts';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from '../register/tree.ts';
import { DECISION_MARKER } from '../tabs/status.ts';
import { parkedFacts, TEST_PARKING } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { lastTurnAtOf, reopenVerdict, soonTimeWaitOf, tabActivityOf, TIME_WAIT_GUARD_MINUTES, type ReopenInput, type ReopenVerdict } from './idle.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const UTC = TimeZone.UTC;
const AWAKE = { held: false, quiet: false };
/** After every change `testTask` makes, so a task carrying it is no news to its owner. */
const SEEN = '2030-01-07T10:00:00.000Z';

function transcript(...entries: readonly JsonRecord[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function prompt(text: string): JsonRecord {
  return { type: 'user', uuid: 'u1', message: { role: 'user', content: text } };
}

function toolResult(): JsonRecord {
  return { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } };
}

function said(text: string, extra: JsonRecord = {}): JsonRecord {
  return { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra };
}

function call(extra: JsonRecord = {}): JsonRecord {
  return { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] }, ...extra };
}

function tasksOf(...tasks: readonly Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function timeWait(id: string, at: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, status: 'waiting', waits: [{ kind: 'time', at }], ...overrides });
}

function reopen(overrides: Partial<ReopenInput>): ReopenVerdict {
  return reopenVerdict({
    tasks: new Map(),
    elsewhere: NO_TASKS_ELSEWHERE,
    session: 'alpha',
    asks: [],
    closedAt: NOW - 2 * HOUR,
    maxPriority: 2,
    parking: TEST_PARKING,
    rest: AWAKE,
    dayStartUtc: undefined,
    now: NOW,
    zone: UTC,
    ...overrides,
  });
}

function idsOf(verdict: ReopenVerdict): readonly string[] {
  return verdict.kind === 'stay' || verdict.kind === 'asked' ? [] : verdict.tasks.map((task) => task.id);
}

describe('tabActivityOf', () => {
  it('reads an ended reply as idle, and no entry at all too', () => {
    assert.equal(tabActivityOf(transcript(prompt('fix it'), said('Fixed.')), false), 'idle');
    assert.equal(tabActivityOf('', false), 'idle');
  });

  it('reads a model entry calling a tool as at a call', () => {
    assert.equal(tabActivityOf(transcript(prompt('fix it'), call()), false), 'call');
  });

  it('reads a reply putting a decision to the person as a question, unless the marker sits in a code block', () => {
    assert.equal(tabActivityOf(transcript(prompt('pick'), said(`Two ways.\n${DECISION_MARKER} a or b?`)), false), 'question');
    assert.equal(tabActivityOf(transcript(prompt('show'), said(`The card:\n\`\`\`\n${DECISION_MARKER} a or b?\n\`\`\``)), false), 'idle');
  });

  it("reads the person's prompt and a tool's result as a turn under way", () => {
    assert.equal(tabActivityOf(transcript(said('Done.'), prompt('next')), false), 'turn');
    assert.equal(tabActivityOf(transcript(prompt('fix it'), call(), toolResult()), false), 'turn');
  });

  it('reads the person stopping a turn as idle', () => {
    const stopped = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
    assert.equal(tabActivityOf(transcript(prompt('fix it'), call(), stopped), false), 'idle');
  });

  it('keeps a question asked before a slash command, which starts no turn', () => {
    const command = { type: 'user', message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' } };
    const output = { type: 'user', message: { role: 'user', content: '<local-command-stdout>Reloaded</local-command-stdout>' } };
    assert.equal(tabActivityOf(transcript(prompt('pick'), said(`${DECISION_MARKER} a or b?`), command, output), false), 'question');
  });

  it("skips meta entries, a helper's entries and entries of other kinds", () => {
    const meta = { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: the messages below' } };
    const system = { type: 'system', subtype: 'turn_duration' };
    assert.equal(tabActivityOf(transcript(prompt('fix it'), said('Fixed.'), meta, call({ isSidechain: true }), system), false), 'idle');
  });

  it("skips a cut tail's first line, which may be partial", () => {
    assert.equal(tabActivityOf(transcript(call()), true), 'idle');
    assert.equal(tabActivityOf(transcript(call()), false), 'call');
  });
});

describe('lastTurnAtOf', () => {
  const stamp = (minutesAgo: number): JsonRecord => ({ timestamp: new Date(NOW - minutesAgo * MINUTE).toISOString() });

  it("reads the time of the tab's last own entry, past slash commands, away summaries and meta entries (T1417)", () => {
    const command = { type: 'user', ...stamp(10), message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' } };
    const meta = { type: 'user', isMeta: true, ...stamp(10), message: { role: 'user', content: 'Caveat: the messages below' } };
    const away = { type: 'system', subtype: 'away_summary', ...stamp(5) };
    const helper = call({ isSidechain: true, ...stamp(20) });
    const text = transcript({ ...prompt('fix it'), ...stamp(80) }, said('Fixed.', stamp(75)), helper, command, meta, away);
    assert.equal(lastTurnAtOf(text, false), NOW - 75 * MINUTE);
    assert.equal(lastTurnAtOf(transcript(said('Fixed.', stamp(75)), { ...prompt('next'), ...stamp(3) }), false), NOW - 3 * MINUTE);
  });

  it('reads none with no own entry, a last one with no time, or only the partial first line of a cut tail', () => {
    assert.equal(lastTurnAtOf('', false), undefined);
    assert.equal(lastTurnAtOf(transcript({ type: 'system', subtype: 'away_summary', ...stamp(5) }), false), undefined);
    assert.equal(lastTurnAtOf(transcript(said('Old.', stamp(90)), said('Fixed.')), false), undefined);
    assert.equal(lastTurnAtOf(transcript(said('Fixed.', { timestamp: 'soon' })), false), undefined);
    assert.equal(lastTurnAtOf(transcript(said('Fixed.', stamp(75))), true), undefined);
  });
});

describe('soonTimeWaitOf', () => {
  it("finds the session's own time wait that ends within the guard, the soonest of several", () => {
    const later = timeWait('T2', '2030-01-08 10:25');
    const sooner = timeWait('T3', '2030-01-08 10:15');
    assert.deepEqual(soonTimeWaitOf(tasksOf(later, sooner), 'alpha', 2, NOW, UTC), { task: sooner, at: Date.parse('2030-01-08T10:15:00.000Z') });
  });

  it(`counts a wait that ends exactly ${TIME_WAIT_GUARD_MINUTES} minutes out`, () => {
    assert.equal(soonTimeWaitOf(tasksOf(timeWait('T2', '2030-01-08 10:30')), 'alpha', 2, NOW, UTC)?.task.id, 'T2');
  });

  it('ignores a wait already past or further out', () => {
    assert.equal(soonTimeWaitOf(tasksOf(timeWait('T2', '2030-01-08 09:50'), timeWait('T3', '2030-01-08 10:40')), 'alpha', 2, NOW, UTC), undefined);
  });

  it("ignores another session's task, one less urgent than maxPriority and a finished one", () => {
    const tasks = tasksOf(
      timeWait('T2', '2030-01-08 10:20', { owner: 'bravo' }),
      timeWait('T3', '2030-01-08 10:20', { priority: 3 }),
      timeWait('T4', '2030-01-08 10:20', { status: 'done' }),
      timeWait('T5', '2030-01-08 10:20', { status: 'dropped' }),
    );
    assert.equal(soonTimeWaitOf(tasks, 'alpha', 2, NOW, UTC), undefined);
  });
});

describe('reopenVerdict', () => {
  it('reopens first for urgent lines posted to it, at once and whatever its rest, dated by the oldest', () => {
    const asks = [
      { from: 'lead', text: 'look at it', at: NOW - MINUTE },
      { from: 'bravo', text: 'the build broke', at: NOW - 5 * MINUTE },
    ];
    const expected = { kind: 'asked', asks, at: NOW - 5 * MINUTE };
    assert.deepEqual(reopen({ asks, tasks: tasksOf(testTask({ id: 'T4', priority: 1 })) }), expected);
    assert.deepEqual(reopen({ asks, rest: { held: true, quiet: true }, maxPriority: 1 }), expected);
  });

  it('reopens for news it can start within maxPriority, most urgent first', () => {
    const tasks = tasksOf(testTask({ id: 'T7' }), testTask({ id: 'T4', priority: 1 }), testTask({ id: 'T3', priority: 1 }));
    const verdict = reopen({ tasks });
    assert.equal(verdict.kind, 'handed');
    assert.deepEqual(idsOf(verdict), ['T3', 'T4', 'T7']);
  });

  it("reopens once another team of the tree finished a task it waits on, and stays closed while that task is open (T1139)", () => {
    const tasks = tasksOf(testTask({ id: 'T4', priority: 1, status: 'waiting', waits: [{ kind: 'task', id: 'T9' }], ownerSeenAt: SEEN }));
    const held = (status: 'in-progress' | 'done', statusAt: string): TasksElsewhere => new Map([['T9', { team: 'app', task: testTask({ id: 'T9', owner: 'web', status, statusAt }) }]]);
    assert.deepEqual(reopen({ tasks, elsewhere: held('in-progress', '2030-01-08T09:00:00.000Z') }), { kind: 'stay' });
    const verdict = reopen({ tasks, elsewhere: held('done', '2030-01-08T09:00:00.000Z') });
    assert.equal(verdict.kind, 'handed');
    assert.deepEqual(idsOf(verdict), ['T4']);
  });

  it('stays closed for work it saw before the close, or less urgent than maxPriority', () => {
    assert.deepEqual(reopen({ tasks: tasksOf(testTask({ ownerSeenAt: SEEN })) }), { kind: 'stay' });
    assert.deepEqual(reopen({ tasks: tasksOf(testTask()), maxPriority: 1 }), { kind: 'stay' });
  });

  it('stays closed for a parked task, as news and at a day start alike, and reopens once an event moves it (T2090)', () => {
    const parked = testTask({ ...parkedFacts(NOW) });
    const morning = { dayStartUtc: '06:00', closedAt: Date.parse('2030-01-08T05:00:00.000Z') };
    assert.deepEqual(reopen({ tasks: tasksOf(parked) }), { kind: 'stay' });
    assert.deepEqual(reopen({ tasks: tasksOf(parked), ...morning }), { kind: 'stay' });
    assert.equal(reopen({ tasks: tasksOf({ ...parked, updatedAt: new Date(NOW).toISOString() }) }).kind, 'handed');
  });

  it('reopens at a day start after its close for any work it can start, less urgent work too', () => {
    const tasks = tasksOf(testTask({ id: 'T2', priority: 3, ownerSeenAt: SEEN }));
    const verdict = reopen({ tasks, maxPriority: 1, dayStartUtc: '06:00', closedAt: Date.parse('2030-01-08T05:00:00.000Z') });
    assert.deepEqual(verdict, { kind: 'day-start', at: Date.parse('2030-01-08T06:00:00.000Z'), tasks: [...tasks.values()] });
  });

  it('stays closed at a day start before its close, while it rests, or with no work to start', () => {
    const work = tasksOf(testTask({ ownerSeenAt: SEEN }));
    const morning = { dayStartUtc: '06:00', closedAt: Date.parse('2030-01-08T05:00:00.000Z') };
    assert.deepEqual(reopen({ tasks: work, dayStartUtc: '06:00', closedAt: Date.parse('2030-01-08T07:00:00.000Z') }), { kind: 'stay' });
    assert.deepEqual(reopen({ tasks: work, ...morning, rest: { held: false, quiet: true } }), { kind: 'stay' });
    assert.deepEqual(reopen({ tasks: work, ...morning, rest: { held: true, quiet: false } }), { kind: 'stay' });
    assert.deepEqual(reopen({ tasks: tasksOf(testTask({ status: 'done', ownerSeenAt: SEEN })), ...morning }), { kind: 'stay' });
    assert.deepEqual(reopen({ ...morning }), { kind: 'stay' });
  });
});
