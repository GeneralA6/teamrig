import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { foldEvents, type RegisterState, type Task } from './fold.ts';
import { normaliseTitle, RegisterPolicy, type AddInput, type StatusContext, type Verdict } from './policy.ts';
import type { WaitReason } from './waits.ts';

const EMPTY: RegisterState = foldEvents([]);
const INPUT: AddInput = { title: 'Add a health check', owner: 'alpha', source: 'lead', priority: 2 };

const TASK: Task = testTask({ status: 'in-progress', startedAt: '2030-01-07T10:00:00.000Z' });
const NOW = new Date('2030-01-08T12:00:00.000Z');
/** A status change judged on an empty register at NOW, with no skill on disk. */
const CTX: StatusContext = { state: EMPTY, now: NOW, skillExists: false };
const OWNER_DECISION: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];

/** A register holding these tasks, its next id after the highest. */
function stateOf(...tasks: Task[]): RegisterState {
  const highest = Math.max(0, ...tasks.map((task) => Number(task.id.slice(1))));
  return { tasks: new Map(tasks.map((task) => [task.id, task])), orphans: 0, nextId: `T${highest + 1}` };
}

function error<T>(verdict: Verdict<T>): string {
  return verdict.ok ? 'allowed' : verdict.error;
}

/** Built at runtime so no credential-shaped literal sits in the source. */
function credentialUrl(): string {
  return ['https://', 'user', ':', 'hunter2', '@', 'example.test'].join('');
}

describe('RegisterPolicy.add', () => {
  const policy = new RegisterPolicy(testConfig());

  it('fills optional fields and trims the title', () => {
    const verdict = policy.add({ ...INPUT, title: '  Add a health check ' }, EMPTY);
    assert.deepEqual(verdict, {
      ok: true,
      value: { title: 'Add a health check', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: [] },
    });
  });

  it('applies the team policy', () => {
    const cases: [Partial<AddInput>, RegExp][] = [
      [{ title: ' ' }, /title is empty/],
      [{ title: 'x'.repeat(141) }, /141 characters; the limit is 140/],
      [{ owner: 'charlie' }, /owner charlie is not a session/],
      [{ source: 'The Owner' }, /neither a session id nor owner/],
      [{ priority: 9 }, /^priority p9 is not one of p1, p2, p3, p4, p5$/],
      [{ due: 'friday' }, /due friday is not/],
      [{ week: '2030-1-7' }, /week 2030-1-7 is not/],
      [{ ref: 'r'.repeat(301) }, /ref has 301 characters/],
      [{ ref: credentialUrl() }, /ref looks like it holds a secret/],
      [{ title: `rotate ${['pass', 'word'].join('')}=abc` }, /title looks like it holds a secret/],
    ];
    for (const [change, expected] of cases) {
      assert.match(error(policy.add({ ...INPUT, ...change }, EMPTY)), expected, JSON.stringify(change));
    }
  });

  it('refuses a vendor token in every text field, naming its kind and never its value', () => {
    const token = ['ghp', '_', 'a1'.repeat(18)].join('');
    const refused = error(policy.add({ ...INPUT, ref: `see ${token}` }, EMPTY));
    assert.equal(refused, 'ref looks like it holds a secret (GitHub token); refer to where it is kept instead');
    assert.match(error(policy.add({ ...INPUT, title: `rotate ${token}` }, EMPTY)), /^title looks like it holds a secret \(GitHub token\)/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, note: `key ${token}` }, CTX)), /^note looks like it holds a secret/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: token, skill: 'none' }, CTX)), /^evidence looks like it holds a secret/);
    assert.match(error(policy.update(TASK, 'alpha', { title: 'Add two health checks' }, `see ${token}`, EMPTY)), /^note looks like it holds a secret/);
  });

  it('checks goals and extra secret patterns from the config', () => {
    const strict = new RegisterPolicy(testConfig({ register: { goalPattern: '^G\\d+$', secretPatterns: ['tok_[a-z0-9]{8}'] } }));
    assert.match(error(strict.add({ ...INPUT, goals: ['G1', 'roadmap'] }, EMPTY)), /goal roadmap does not match/);
    assert.match(error(strict.add({ ...INPUT, ref: 'tok_abcd1234' }, EMPTY)), /secret/);
    assert.equal(strict.add({ ...INPUT, goals: ['G1'] }, EMPTY).ok, true);
  });

  it('refuses an active task with the same title, but not a closed one', () => {
    const open = foldEvents([
      { v: 1, type: 'create', id: 'T4', at: TASK.createdAt, by: 'lead', task: { ...INPUT, ref: null, due: null, goals: [], week: null, after: [] } },
    ]);
    assert.match(error(policy.add({ ...INPUT, title: 'add a  HEALTH check' }, open)), /T4 already tracks this \(open, owner alpha\)/);
    const closed = foldEvents([
      ...[...open.tasks.values()].map((task) => ({ v: 1, type: 'create' as const, id: task.id, at: task.createdAt, by: 'lead', task })),
      { v: 1, type: 'status', id: 'T4', at: TASK.createdAt, by: 'alpha', status: 'dropped', note: 'merged', evidence: null, skill: null },
    ]);
    assert.equal(policy.add(INPUT, closed).ok, true);
  });

  it('accepts only sessions on the roster as callers', () => {
    assert.equal(policy.checkCaller('alpha'), undefined);
    assert.match(policy.checkCaller('charlie') ?? '', /charlie is not a session on this team/);
  });
});

describe('RegisterPolicy.setStatus', () => {
  const policy = new RegisterPolicy(testConfig());

  it('lets only the owner set the status', () => {
    assert.match(error(policy.setStatus(TASK, 'bravo', { status: 'waiting', waits: OWNER_DECISION, note: 'x' }, CTX)), /only the owner \(alpha\)/);
    assert.match(error(policy.setStatus(TASK, 'lead', { status: 'waiting', waits: OWNER_DECISION, note: 'x' }, CTX)), /only the owner/);
  });

  it('requires a note, evidence and a skill to close a task', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done' }, CTX)), /done needs --note/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying' }, CTX)), /^verifying needs --note$/);
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped' }, CTX)),
      'verifying needs --proof saying what will prove the shipped change works',
    );
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'the nightly run' }, CTX).ok, true);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok' }, CTX)), /needs --evidence/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234' }, CTX)), /needs --skill/);
    assert.match(
      error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'web-deploy' }, CTX)),
      /no skill named web-deploy/,
    );
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'done', note: ' ok ', evidence: 'abc1234', skill: 'none' }, CTX), {
      ok: true,
      value: { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none' },
    });
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc', skill: 'web-deploy' }, { ...CTX, skillExists: true }).ok, true);
  });

  it('accepts evidence recorded on an earlier status change', () => {
    const withEvidence: Task = { ...TASK, evidence: 'abc1234' };
    assert.equal(policy.setStatus(withEvidence, 'alpha', { status: 'done', note: 'ok', skill: 'none' }, CTX).ok, true);
  });

  it('keeps --skill for done and wants a reason to repeat a status', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, note: 'x', skill: 'none' }, CTX)), /only with done/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'in-progress' }, CTX)), /already in-progress/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'dropped' }, CTX)), /dropped needs --note/);
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'open' }, CTX).ok, true);
  });

  it('follows a relaxed config', () => {
    const relaxed = new RegisterPolicy(
      testConfig({ register: { requireEvidenceOnDone: false, requireSkillOnDone: false, requireNoteOn: [] } }),
    );
    assert.deepEqual(relaxed.setStatus(TASK, 'alpha', { status: 'done' }, CTX), {
      ok: true,
      value: { status: 'done', note: null, evidence: null, skill: null },
    });
  });
});

describe('RegisterPolicy.setStatus to verifying', () => {
  const policy = new RegisterPolicy(testConfig());
  const VERIFYING: Task = { ...TASK, status: 'verifying', note: 'shipped', proof: 'the nightly run is green' };

  it('writes the proof trimmed, only with verifying', () => {
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: ' the nightly run ' }, CTX), {
      ok: true,
      value: { status: 'verifying', note: 'shipped', evidence: null, skill: null, proof: 'the nightly run' },
    });
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'open', proof: 'x' }, CTX)), '--proof goes only with --status verifying');
  });

  it('carries the proof over when a verifying task is set verifying again, and takes a new proof as a change', () => {
    const again = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', note: 'still waiting' }, CTX);
    assert.deepEqual(again.ok ? again.value.proof : undefined, 'the nightly run is green');
    const renamed = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', proof: 'two nightly runs', note: 'shipped' }, CTX);
    assert.deepEqual(renamed.ok ? renamed.value.proof : undefined, 'two nightly runs');
    assert.match(error(policy.setStatus({ ...VERIFYING, note: null }, 'alpha', { status: 'verifying', proof: 'the nightly run is green' }, CTX)), /already verifying/);
  });

  it('moves the due date to the verify-by date, only with verifying', () => {
    const dated = policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09 18:00' }, CTX);
    assert.equal(dated.ok ? dated.value.due : undefined, '2030-01-09 18:00');
    const same = policy.setStatus({ ...TASK, due: '2030-01-09' }, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09' }, CTX);
    assert.deepEqual(same.ok ? Object.keys(same.value) : undefined, ['status', 'note', 'evidence', 'skill', 'proof'], 'the same date moves nothing');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p', due: 'friday' }, CTX)), 'due friday is not YYYY-MM-DD or YYYY-MM-DD HH:MM');
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', { status: 'open', due: '2030-01-09' }, CTX)),
      '--due goes only with --status verifying; teamrig update T1 --due sets it otherwise',
    );
    const moved = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', note: 'shipped', due: '2030-01-10' }, CTX);
    assert.equal(moved.ok ? moved.value.due : undefined, '2030-01-10', 'a new date is a change, not a repeat');
  });

  it('checks the proof like any text', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p'.repeat(301) }, CTX)), /^proof has 301 characters/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: credentialUrl() }, CTX)), /proof looks like it holds a secret/);
  });

  it('asks the note for the proof when the team does not require --proof', () => {
    const relaxed = new RegisterPolicy(testConfig({ register: { requireProofOnVerifying: false } }));
    assert.equal(error(relaxed.setStatus(TASK, 'alpha', { status: 'verifying' }, CTX)), 'verifying needs --note saying what proves it');
    assert.deepEqual(relaxed.setStatus(TASK, 'alpha', { status: 'verifying', note: 'the nightly run' }, CTX), {
      ok: true,
      value: { status: 'verifying', note: 'the nightly run', evidence: null, skill: null },
    });
  });
});

describe('RegisterPolicy.setStatus to waiting', () => {
  const policy = new RegisterPolicy(testConfig());
  const OPEN = testTask({ id: 'T2', status: 'open' });
  const DONE = testTask({ id: 'T3', status: 'done' });
  const BUSY = testTask({ id: 'T4', status: 'in-progress', owner: 'bravo' });
  const STATE = stateOf(TASK, OPEN, DONE, BUSY);
  const waiting = (task: Task, waits: readonly WaitReason[], state: RegisterState = STATE) =>
    policy.setStatus(task, 'alpha', { status: 'waiting', note: 'x', waits }, { ...CTX, state });

  it('keeps every kind of reason, each named once', () => {
    const waits: WaitReason[] = [
      { kind: 'decision', who: 'owner' },
      { kind: 'approval', who: 'bravo' },
      { kind: 'task', id: 'T4' },
      { kind: 'time', at: '2030-01-09 13:00' },
    ];
    assert.deepEqual(waiting(TASK, waits), { ok: true, value: { status: 'waiting', note: 'x', evidence: null, skill: null, waits } });
  });

  it('needs a reason, and takes reasons only with waiting', () => {
    assert.match(error(waiting(TASK, [])), /^waiting needs --waits saying what it waits for: decision:<who>/);
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', waits: OWNER_DECISION }, CTX)), '--waits goes only with --status waiting');
    assert.equal(error(waiting(TASK, [...OWNER_DECISION, ...OWNER_DECISION])), '--waits names decision:owner twice');
  });

  it('names who decides or approves: a session of the team or the owner', () => {
    assert.equal(error(waiting(TASK, [{ kind: 'approval', who: 'charlie' }])), 'approval charlie: charlie is neither a session on this team nor owner');
    assert.equal(waiting(TASK, [{ kind: 'decision', who: 'lead' }]).ok, true);
  });

  it('waits on a task only once started, and only on another live task', () => {
    assert.equal(
      error(waiting(OPEN, [{ kind: 'task', id: 'T4' }])),
      'T2 has not started, so it does not wait on T4: it stays open, planned after it (teamrig update T2 --after T4)',
    );
    assert.match(error(waiting(testTask({ id: 'T5', status: 'waiting', startedAt: null }), [{ kind: 'task', id: 'T4' }])), /T5 has not started/);
    assert.equal(waiting(testTask({ status: 'waiting', startedAt: '2030-01-07T10:00:00.000Z' }), [{ kind: 'task', id: 'T4' }]).ok, true);
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T1' }])), 'T1 cannot wait on itself');
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T9' }])), 'no task T9');
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T3' }])), 'T3 is already finished; nothing to wait on');
  });

  it('waits until a time to come, never one that passed', () => {
    assert.equal(error(waiting(TASK, [{ kind: 'time', at: '2030-01-08 11:59' }])), 'time 2030-01-08 11:59 has passed: name a time to come');
    assert.equal(waiting(TASK, [{ kind: 'time', at: '2030-01-08' }]).ok, true, 'a bare day lasts to its end');
  });

  it('takes the same status again only with a new note or new reasons', () => {
    const held = testTask({ status: 'waiting', startedAt: TASK.startedAt, waits: OWNER_DECISION });
    assert.match(error(policy.setStatus(held, 'alpha', { status: 'waiting', waits: OWNER_DECISION }, CTX)), /already waiting/);
    assert.equal(policy.setStatus(held, 'alpha', { status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], note: 'x' }, CTX).ok, true);
    const relaxed = new RegisterPolicy(testConfig({ register: { requireNoteOn: [] } }));
    const more = [...OWNER_DECISION, { kind: 'approval' as const, who: 'owner' }];
    assert.equal(relaxed.setStatus(held, 'alpha', { status: 'waiting', waits: more }, CTX).ok, true, 'new reasons need no note');
    assert.match(error(relaxed.setStatus(held, 'alpha', { status: 'waiting', waits: [...OWNER_DECISION] }, CTX)), /already waiting/);
  });
});

describe('RegisterPolicy.update', () => {
  const policy = new RegisterPolicy(testConfig());

  it('lets the owner change any field, validated like a new task', () => {
    assert.deepEqual(policy.update(TASK, 'alpha', { title: 'Add two health checks' }, ' wider ', EMPTY), {
      ok: true,
      value: { changes: { title: 'Add two health checks' }, note: 'wider' },
    });
    assert.match(error(policy.update(TASK, 'alpha', { priority: 7 }, undefined, EMPTY)), /priority p7 is not one of/);
  });

  it('lets the lead change only owner, priority, due and week', () => {
    assert.equal(policy.update(TASK, 'lead', { owner: 'bravo', due: '2030-01-10' }, undefined, EMPTY).ok, true);
    assert.match(error(policy.update(TASK, 'lead', { title: 'x', priority: 1 }, undefined, EMPTY)), /asked: title/);
  });

  it('plans an open task after others, and clears that plan on any task', () => {
    const first = testTask({ id: 'T1', status: 'in-progress' });
    const second = testTask({ id: 'T2', status: 'open', after: ['T1'] });
    const third = testTask({ id: 'T3', status: 'open' });
    const state = stateOf(first, second, third);
    assert.deepEqual(policy.update(third, 'alpha', { after: ['T1', 'T2'] }, undefined, state), {
      ok: true,
      value: { changes: { after: ['T1', 'T2'] }, note: null },
    });
    assert.equal(policy.update(first, 'alpha', { after: [] }, undefined, state).ok, true);
    assert.equal(
      error(policy.update(first, 'alpha', { after: ['T3'] }, undefined, state)),
      '--after plans a task not started yet, and T1 is in-progress; a started task waits on another with --status waiting --waits task:T3',
    );
    assert.equal(error(policy.update(third, 'alpha', { after: ['T1', 'T1'] }, undefined, state)), '--after names T1 twice');
    assert.equal(error(policy.update(third, 'alpha', { after: ['T3'] }, undefined, state)), 'T3 cannot come after itself');
    assert.equal(error(policy.update(third, 'alpha', { after: ['T4'] }, undefined, state)), 'no task T4');
    assert.equal(error(policy.update(testTask({ id: 'T1', status: 'open' }), 'alpha', { after: ['T2'] }, undefined, state)), 'T2 already comes after T1, directly or not, so T1 cannot come after T2');
  });

  it('plans a new task after others, and refuses one that does not exist yet', () => {
    const state = stateOf(testTask({ id: 'T1' }), testTask({ id: 'T2', after: ['T1'] }));
    const verdict = policy.add({ ...INPUT, title: 'Ship it', after: ['T2', 'T1'] }, state);
    assert.equal(verdict.ok && verdict.value.after.join(','), 'T2,T1');
    assert.equal(error(policy.add({ ...INPUT, title: 'Ship it', after: ['T3'] }, state)), 'T3 cannot come after itself', 'T3 is the id it gets');
    assert.equal(error(policy.add({ ...INPUT, title: 'Ship it', after: ['T4'] }, state)), 'no task T4');
  });

  it('refuses everyone else and empty changes', () => {
    assert.match(error(policy.update(TASK, 'bravo', { priority: 1 }, undefined, EMPTY)), /only the owner \(alpha\) or the lead/);
    assert.match(error(policy.update(TASK, 'alpha', {}, undefined, EMPTY)), /nothing to change/);
  });
});

describe('normaliseTitle', () => {
  it('ignores case and spacing', () => {
    assert.equal(normaliseTitle('  Add   a\tHealth check '), 'add a health check');
  });
});

describe('RegisterPolicy.addFromParent', () => {
  const policy = new RegisterPolicy(testConfig());
  const FROM_PARENT: AddInput = { ...INPUT, owner: 'lead', source: 'app/lead' };

  it('takes a task for the lead, sourced <team>/<id>, which an update keeps', () => {
    const verdict = policy.addFromParent(FROM_PARENT, EMPTY);
    assert.equal(verdict.ok && verdict.value.source, 'app/lead');
    const handed = testTask({ owner: 'lead', source: 'app/lead' });
    assert.equal(policy.update(handed, 'lead', { priority: 1 }, undefined, EMPTY).ok, true);
    assert.match(error(policy.update(handed, 'lead', { source: 'web/lead' }, undefined, EMPTY)), /source web.lead is neither a session id nor owner/);
  });

  it('refuses another owner, a bare source, and the parent address on a team add', () => {
    assert.equal(error(policy.addFromParent({ ...FROM_PARENT, owner: 'alpha' }, EMPTY)), "a task from the parent team goes to this team's lead (lead), not alpha");
    assert.equal(error(policy.addFromParent({ ...FROM_PARENT, source: 'lead' }, EMPTY)), "source lead is not the parent team lead's <team>/<id>");
    assert.match(error(policy.add({ ...INPUT, source: 'app/lead' }, EMPTY)), /source app.lead is neither a session id nor owner/);
  });
});
