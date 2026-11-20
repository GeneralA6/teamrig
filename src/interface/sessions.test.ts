import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import type { HireRecord, RetireRecord } from '../hiring/record.ts';
import type { TabNeed } from '../tabs/need.ts';
import type { TabState } from '../tabs/state.ts';
import { cutText, sessionsBody, type MemberInput, type ServedSession, type SessionsBody, type SessionsInput, type TeamInput } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

const HOST = { id: 'claude-code', name: 'Claude Code' };
const LAUNCH = { model: null, effort: null, text: 'the default model and effort' };
const HIRED = Date.parse('2030-01-02T09:00:00.000Z');
const RETIRED = Date.parse('2030-01-05T17:30:00.000Z');

function member(id: string, input: Partial<MemberInput> = {}): MemberInput {
  return {
    id,
    name: `app-${id}`,
    formerNames: [],
    roles: [],
    leader: 'lead',
    ledBy: ['lead'],
    leads: 0,
    launch: LAUNCH,
    hire: null,
    rehiredFrom: null,
    unread: 0,
    tab: null,
    host: HOST,
    conversation: null,
    ...input,
  };
}

function hire(input: Partial<HireRecord> = {}): HireRecord {
  return { kind: 'hire', session: 'alpha', scope: 'the import', reason: 'the queue grew', reviewBy: '2030-01-16', by: 'lead', at: HIRED, ...input };
}

function retire(input: Partial<RetireRecord> = {}): RetireRecord {
  return { kind: 'retire', session: 'alpha', reason: 'the import shipped', by: 'lead', at: RETIRED, ...input };
}

function tab(state: TabState, input: Partial<TabNeed> = {}): TabNeed {
  return { session: 'alpha', state, kind: null, text: null, task: null, pid: 77, since: '2030-01-08T09:58:00.000Z', ...input };
}

function bodyOf(teams: readonly TeamInput[], input: Partial<SessionsInput> = {}): SessionsBody {
  return sessionsBody({ self: null, teams, failures: [], shapes: new SecretScanner(), ...input });
}

/** The one session of a team `app` that holds only it. */
function servedOf(input: Partial<MemberInput>): ServedSession {
  const [served] = bodyOf([{ id: 'app', parent: null, members: [member('alpha', input)], retired: [] }]).sessions;
  assert.ok(served !== undefined);
  return served;
}

describe('sessionsBody', () => {
  it('serves a session as its place, names, leaders and launch, in this order', () => {
    const body = bodyOf([{ id: 'app', parent: null, members: [member('alpha', { formerNames: ['app-a'], unread: 2, conversation: 'c-1' })], retired: [] }]);
    assert.deepEqual(body.sessions, [
      {
        team: 'app',
        id: 'alpha',
        name: 'app-alpha',
        formerNames: ['app-a'],
        roles: [],
        leader: 'lead',
        ledBy: ['lead'],
        leads: 0,
        active: true,
        launch: LAUNCH,
        hire: null,
        rehiredFrom: null,
        retire: null,
        unread: 2,
        state: null,
        ask: null,
        since: null,
        host: HOST,
        conversation: 'c-1',
      },
    ]);
    assert.deepEqual(Object.keys(body), ['self', 'teams', 'sessions', 'failures', 'cuts']);
  });

  it('serves the tab as busy, idle or asking, and no state without a tab', () => {
    const states: readonly (readonly [TabState, string])[] = [
      ['working', 'busy'],
      ['compacting', 'busy'],
      ['ready', 'idle'],
      ['waiting', 'asking'],
      ['decision', 'asking'],
      ['error', 'asking'],
    ];
    for (const [state, expected] of states) {
      const served = servedOf({ tab: tab(state) });
      assert.equal(served.state, expected, state);
      assert.equal(served.since, '2030-01-08T09:58:00.000Z');
    }
    const closed = servedOf({ tab: null });
    assert.deepEqual([closed.state, closed.ask, closed.since], [null, null, null]);
  });

  it('serves an ask as its kind and task, never its words', () => {
    const served = servedOf({ tab: tab('waiting', { kind: 'permission', text: `Bash: deploy ${SECRET}`, task: 'T12' }) });
    assert.deepEqual(served.ask, { kind: 'permission', task: 'T12' });
    assert.equal(JSON.stringify(served).includes('deploy'), false);
    assert.equal(servedOf({ tab: tab('working') }).ask, null);
  });

  it('serves a hire and the retirement it came back from, with their times as ISO text', () => {
    const served = servedOf({ hire: hire({ approvedBy: 'owner', burst: HIRED }), rehiredFrom: retire({ heir: 'bravo', handover: '/team/handover/alpha.md' }) });
    assert.deepEqual(served.hire, {
      at: '2030-01-02T09:00:00.000Z',
      by: 'lead',
      scope: 'the import',
      reason: 'the queue grew',
      reviewBy: '2030-01-16',
      approvedBy: 'owner',
      burst: '2030-01-02T09:00:00.000Z',
    });
    assert.deepEqual(served.rehiredFrom, { at: '2030-01-05T17:30:00.000Z', by: 'lead', reason: 'the import shipped', heir: 'bravo' });
    assert.deepEqual(servedOf({ hire: hire() }).hire, { at: '2030-01-02T09:00:00.000Z', by: 'lead', scope: 'the import', reason: 'the queue grew', reviewBy: '2030-01-16', approvedBy: null, burst: null });
  });

  it('cuts a hire or retire text that holds a secret shape, naming the session by its team', () => {
    const shape = new SecretScanner().find(SECRET)?.description;
    assert.ok(shape !== undefined);
    const body = bodyOf([
      { id: 'web', parent: 'app', members: [member('alpha', { hire: hire({ scope: SECRET, reason: `use ${SECRET}` }), rehiredFrom: retire({ reason: SECRET }) })], retired: [{ id: 'old', name: 'web-old', formerNames: [], retire: retire({ reason: SECRET }) }] },
    ]);
    assert.deepEqual(body.cuts, [
      { id: 'web/alpha', field: 'hire.scope', shape },
      { id: 'web/alpha', field: 'hire.reason', shape },
      { id: 'web/alpha', field: 'rehiredFrom.reason', shape },
      { id: 'web/old', field: 'retire.reason', shape },
    ]);
    assert.equal(body.sessions[0]?.hire?.scope, cutText(shape));
    assert.equal(body.sessions[1]?.retire?.reason, cutText(shape));
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  });

  it('serves a retired session as a row on no team, with only its names and its retirement', () => {
    const body = bodyOf([{ id: 'app', parent: null, members: [], retired: [{ id: 'old', name: 'app-old', formerNames: ['app-first'], retire: retire({ heir: 'alpha' }) }] }]);
    assert.deepEqual(body.sessions, [
      {
        team: 'app',
        id: 'old',
        name: 'app-old',
        formerNames: ['app-first'],
        roles: [],
        leader: null,
        ledBy: [],
        leads: 0,
        active: false,
        launch: null,
        hire: null,
        rehiredFrom: null,
        retire: { at: '2030-01-05T17:30:00.000Z', by: 'lead', reason: 'the import shipped', heir: 'alpha' },
        unread: null,
        state: null,
        ask: null,
        since: null,
        host: null,
        conversation: null,
      },
    ]);
  });

  it('serves the teams in the order handed in, each with its counts, its sessions before its retired ones', () => {
    const body = bodyOf(
      [
        { id: 'app', parent: null, members: [member('lead', { leader: null, ledBy: [], leads: 1, roles: ['lead'] }), member('alpha')], retired: [{ id: 'old', name: 'app-old', formerNames: [], retire: retire() }] },
        { id: 'web', parent: 'app', members: [member('lead')], retired: [] },
      ],
      { self: { team: 'web', session: 'lead' }, failures: [{ team: 'torn', reason: 'the team config cannot be read' }] },
    );
    assert.deepEqual(body.teams, [
      { id: 'app', parent: null, active: 2, retired: 1 },
      { id: 'web', parent: 'app', active: 1, retired: 0 },
    ]);
    assert.deepEqual(body.sessions.map((session) => `${session.team}/${session.id}`), ['app/lead', 'app/alpha', 'app/old', 'web/lead']);
    assert.deepEqual(body.sessions[0]?.roles, ['lead']);
    assert.deepEqual(body.self, { team: 'web', session: 'lead' });
    assert.deepEqual(body.failures, [{ team: 'torn', reason: 'the team config cannot be read' }]);
  });
});
