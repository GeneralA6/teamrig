import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DESCRIPTION } from '../config/defaults.ts';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { foldEvents, type RegisterState, type Task } from './fold.ts';
import { DESCRIPTION_NEEDED, GITHUB_ACTOR, normaliseTitle, RegisterPolicy, type AddInput, type AskInput, type ImportInput, type StatusContext, type Verdict } from './policy.ts';
import type { WaitReason } from './waits.ts';

const EMPTY: RegisterState = foldEvents([]);
const INPUT: AddInput = { title: 'Add a health check', description: 'what and why', owner: 'alpha', source: 'lead', priority: 2 };

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
      value: { title: 'Add a health check', description: 'what and why', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: [], size: null },
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
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: token, skill: 'none', followups: [] }, CTX)), /^evidence looks like it holds a secret/);
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
      { v: 1, type: 'create', id: 'T4', at: TASK.createdAt, by: 'lead', task: { ...INPUT, description: null, ref: null, due: null, goals: [], week: null, after: [], size: null } },
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

describe('RegisterPolicy: the description', () => {
  const policy = new RegisterPolicy(testConfig());
  const relaxed = new RegisterPolicy(testConfig({ register: { requireDescription: false } }));
  const { description: _left, ...BARE } = INPUT;
  const fieldsOf = <T>(verdict: Verdict<T>): T => {
    assert.ok(verdict.ok, error(verdict));
    return verdict.value;
  };

  it('refuses an add with no description, or a blank one, while register.requireDescription is on', () => {
    assert.equal(error(policy.add(BARE, EMPTY)), DESCRIPTION_NEEDED);
    assert.equal(error(policy.add({ ...INPUT, description: ' \n ' }, EMPTY)), DESCRIPTION_NEEDED);
    assert.equal(DESCRIPTION_NEEDED, 'add needs --description "<what and why, in plain words>"');
    assert.equal(error(policy.addFromParent({ ...BARE, owner: 'lead', source: 'app/lead' }, EMPTY)), DESCRIPTION_NEEDED);
  });

  it('takes an add with none when the team turns the demand off', () => {
    assert.equal(fieldsOf(relaxed.add(BARE, EMPTY)).description, null);
    assert.equal(fieldsOf(relaxed.add({ ...INPUT, description: '  ' }, EMPTY)).description, null);
  });

  it('trims the ends and keeps the newlines between', () => {
    assert.equal(fieldsOf(policy.add({ ...INPUT, description: '\n  Users lose saved carts.\n\n  Keep them a week.  \n' }, EMPTY)).description, 'Users lose saved carts.\n\n  Keep them a week.');
  });

  it(`holds up to ${MAX_DESCRIPTION} characters, past maxText, and refuses one more or a secret`, () => {
    const longest = 'd'.repeat(MAX_DESCRIPTION);
    assert.equal(fieldsOf(policy.add({ ...INPUT, description: longest }, EMPTY)).description, longest);
    assert.equal(error(policy.add({ ...INPUT, description: `${longest}d` }, EMPTY)), `the description has ${MAX_DESCRIPTION + 1} characters; the limit is ${MAX_DESCRIPTION}`);
    assert.match(error(policy.add({ ...INPUT, description: `log in at ${credentialUrl()}` }, EMPTY)), /^description looks like it holds a secret \(credentials in a URL\)/);
    const strict = new RegisterPolicy(testConfig({ register: { secretPatterns: ['tok_[a-z0-9]{8}'] } }));
    assert.match(error(strict.add({ ...INPUT, description: 'uses tok_abcd1234' }, EMPTY)), /^description looks like it holds a secret/);
  });

  it('lets the owner give a new description, trimmed, and refuses clearing it while the demand is on', () => {
    assert.deepEqual(fieldsOf(policy.update(TASK, 'alpha', { description: ' Why: users ask.\nWhat: one check. ' }, undefined, EMPTY)), {
      changes: { description: 'Why: users ask.\nWhat: one check.' },
      note: null,
    });
    const keeps = `${TASK.id} keeps a description while register.requireDescription is on: give a new one instead of none`;
    assert.equal(error(policy.update(TASK, 'alpha', { description: null }, undefined, EMPTY)), keeps);
    assert.equal(error(policy.update(TASK, 'alpha', { description: '   ' }, undefined, EMPTY)), keeps, 'a blank one clears it');
    assert.deepEqual(fieldsOf(relaxed.update(TASK, 'alpha', { description: ' ' }, undefined, EMPTY)).changes, { description: null });
    assert.match(error(policy.update(TASK, 'alpha', { description: 'x'.repeat(MAX_DESCRIPTION + 1) }, undefined, EMPTY)), /the limit is 2000$/);
  });

  it("leaves the description to the owner: the lead may not change it on another session's task", () => {
    assert.equal(error(policy.update(TASK, 'lead', { description: 'Why it matters.' }, undefined, EMPTY)), 'the lead may change only owner, priority, due, week, after, size on a task it does not own (asked: description)');
    assert.equal(error(policy.update(TASK, 'bravo', { description: 'Why it matters.' }, undefined, EMPTY)), 'only the owner (alpha) or the lead changes T1');
  });

  it('lets an older task with no description change another field', () => {
    assert.deepEqual(fieldsOf(policy.update(TASK, 'alpha', { priority: 1 }, undefined, EMPTY)).changes, { priority: 1 });
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
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'the nightly run', followups: [] }, CTX).ok, true);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok' }, CTX)), /needs --evidence/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234' }, CTX)), /needs --skill/);
    assert.match(
      error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'web-deploy' }, CTX)),
      /no skill named web-deploy/,
    );
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'done', note: ' ok ', evidence: 'abc1234', skill: 'none', followups: [] }, CTX), {
      ok: true,
      value: { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none', followups: [] },
    });
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc', skill: 'web-deploy', followups: [] }, { ...CTX, skillExists: true }).ok, true);
  });

  it('accepts evidence recorded on an earlier status change', () => {
    const withEvidence: Task = { ...TASK, evidence: 'abc1234' };
    assert.equal(policy.setStatus(withEvidence, 'alpha', { status: 'done', note: 'ok', skill: 'none', followups: [] }, CTX).ok, true);
  });

  it('keeps --skill for done and wants a reason to repeat a status', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, note: 'x', skill: 'none' }, CTX)), /only with done/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'in-progress' }, CTX)), /already in-progress/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'dropped' }, CTX)), /dropped needs --note/);
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'open' }, CTX).ok, true);
  });

  it('follows a relaxed config', () => {
    const relaxed = new RegisterPolicy(
      testConfig({ register: { requireEvidenceOnDone: false, requireSkillOnDone: false, requireNoteOn: [], requireFollowupsOn: [] } }),
    );
    assert.deepEqual(relaxed.setStatus(TASK, 'alpha', { status: 'done' }, CTX), {
      ok: true,
      value: { status: 'done', note: null, evidence: null, skill: null },
    });
  });
});

describe('RegisterPolicy.setStatus: the follow-ups a closing change names', () => {
  const policy = new RegisterPolicy(testConfig());
  const LEFT = testTask({ id: 'T2', title: 'Fix the finding' });
  const context: StatusContext = { ...CTX, state: stateOf(TASK, LEFT) };
  const DONE = { status: 'done' as const, note: 'ok', evidence: 'abc1234', skill: 'none' };

  it('refuses verifying and done with no --followups, naming what to type', () => {
    const needs = (status: string): string => `${status} needs --followups T<id>,... naming the tasks this work leaves (a finding, a next step), or --followups none`;
    assert.equal(error(policy.setStatus(TASK, 'alpha', DONE, context)), needs('done'));
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p' }, context)), needs('verifying'));
  });

  it('takes none, or tasks on the list, and writes them', () => {
    const none = policy.setStatus(TASK, 'alpha', { ...DONE, followups: [] }, context);
    assert.deepEqual(none.ok ? none.value.followups : undefined, []);
    const left = policy.setStatus(TASK, 'alpha', { ...DONE, followups: ['T2'] }, context);
    assert.deepEqual(left.ok ? left.value.followups : undefined, ['T2']);
  });

  it('refuses the task itself, a task named twice and one not on the list', () => {
    assert.equal(error(policy.setStatus(TASK, 'alpha', { ...DONE, followups: ['T1'] }, context)), '--followups names T1 itself: name the tasks it leaves');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { ...DONE, followups: ['T2', 'T2'] }, context)), '--followups names T2 twice');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { ...DONE, followups: ['T9'] }, context)), '--followups names T9, which is not on the task list: add it first (teamrig add)');
  });

  it('takes --followups only while shipping, finishing or dropping a task, and on dropped asks none by default', () => {
    const only = '--followups goes only with verifying, done, dropped';
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'open', followups: [] }, context)), only);
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, note: 'x', followups: ['T2'] }, context)), only);
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'dropped', note: 'not needed' }, context)), 'allowed');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'dropped', note: 'moved', followups: ['T2'] }, context)), 'allowed');
  });

  it('asks on the statuses the team lists, and on none when the list is empty', () => {
    const strict = new RegisterPolicy(testConfig({ register: { requireFollowupsOn: ['dropped'] } }));
    assert.match(error(strict.setStatus(TASK, 'alpha', { status: 'dropped', note: 'moved' }, context)), /^dropped needs --followups/);
    assert.equal(error(strict.setStatus(TASK, 'alpha', DONE, context)), 'allowed');
    const off = new RegisterPolicy(testConfig({ register: { requireFollowupsOn: [] } }));
    assert.equal(error(off.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p' }, context)), 'allowed');
  });
});

describe('RegisterPolicy.setStatus: a start waits for the verifying tasks it needs', () => {
  const shipped = testTask({ id: 'T1', owner: 'bravo', status: 'verifying', proof: 'the nightly run' });
  const planned = testTask({ id: 'T2', after: ['T1'] });
  const context = { ...CTX, state: stateOf(shipped, planned) };

  it('refuses the start, naming the task, its proof and its owner', () => {
    assert.equal(
      error(new RegisterPolicy(testConfig()).setStatus(planned, 'alpha', { status: 'in-progress' }, context)),
      'T2 needs T1, still verifying (proof: the nightly run, owner bravo); start T2 once T1 is done',
    );
    const both = testTask({ id: 'T3', after: ['T1', 'T2'] });
    const twoHeld = { ...CTX, state: stateOf(shipped, { ...planned, status: 'verifying', note: 'x', proof: 'p' }, both) };
    assert.match(error(new RegisterPolicy(testConfig()).setStatus(both, 'alpha', { status: 'in-progress' }, twoHeld)), /; start T3 once T1 and T2 are done$/);
  });

  it('lets the start through in warn mode, and any other status in either mode', () => {
    const warn = new RegisterPolicy(testConfig({ register: { verifyGate: 'warn' } }));
    assert.equal(error(warn.setStatus(planned, 'alpha', { status: 'in-progress' }, context)), 'allowed');
    assert.equal(error(new RegisterPolicy(testConfig()).setStatus(planned, 'alpha', { status: 'dropped', note: 'not needed' }, context)), 'allowed');
  });
});

describe('RegisterPolicy.setStatus to verifying', () => {
  const policy = new RegisterPolicy(testConfig());
  const VERIFYING: Task = { ...TASK, status: 'verifying', note: 'shipped', proof: 'the nightly run is green' };

  it('writes the proof trimmed, only with verifying', () => {
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: ' the nightly run ', followups: [] }, CTX), {
      ok: true,
      value: { status: 'verifying', note: 'shipped', evidence: null, skill: null, proof: 'the nightly run', followups: [] },
    });
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'open', proof: 'x' }, CTX)), '--proof goes only with --status verifying');
  });

  it('carries the proof over when a verifying task is set verifying again, and takes a new proof as a change', () => {
    const again = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', note: 'still waiting', followups: [] }, CTX);
    assert.deepEqual(again.ok ? again.value.proof : undefined, 'the nightly run is green');
    const renamed = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', proof: 'two nightly runs', note: 'shipped', followups: [] }, CTX);
    assert.deepEqual(renamed.ok ? renamed.value.proof : undefined, 'two nightly runs');
    assert.match(error(policy.setStatus({ ...VERIFYING, note: null }, 'alpha', { status: 'verifying', proof: 'the nightly run is green' }, CTX)), /already verifying/);
  });

  it('moves the due date to the verify-by date, only with verifying', () => {
    const dated = policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09 18:00', followups: [] }, CTX);
    assert.equal(dated.ok ? dated.value.due : undefined, '2030-01-09 18:00');
    const same = policy.setStatus({ ...TASK, due: '2030-01-09' }, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09', followups: [] }, CTX);
    assert.deepEqual(same.ok ? Object.keys(same.value) : undefined, ['status', 'note', 'evidence', 'skill', 'proof', 'followups'], 'the same date moves nothing');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p', due: 'friday' }, CTX)), 'due friday is not YYYY-MM-DD or YYYY-MM-DD HH:MM');
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', { status: 'open', due: '2030-01-09' }, CTX)),
      '--due goes only with --status verifying; teamrig update T1 --due sets it otherwise',
    );
    const moved = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', note: 'shipped', due: '2030-01-10', followups: [] }, CTX);
    assert.equal(moved.ok ? moved.value.due : undefined, '2030-01-10', 'a new date is a change, not a repeat');
  });

  it('checks the proof like any text', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p'.repeat(301), followups: [] }, CTX)), /^proof has 301 characters/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: credentialUrl(), followups: [] }, CTX)), /proof looks like it holds a secret/);
  });

  it('asks the note for the proof when the team does not require --proof', () => {
    const relaxed = new RegisterPolicy(testConfig({ register: { requireProofOnVerifying: false } }));
    assert.equal(error(relaxed.setStatus(TASK, 'alpha', { status: 'verifying' }, CTX)), 'verifying needs --note saying what proves it');
    assert.deepEqual(relaxed.setStatus(TASK, 'alpha', { status: 'verifying', note: 'the nightly run', followups: [] }, CTX), {
      ok: true,
      value: { status: 'verifying', note: 'the nightly run', evidence: null, skill: null, followups: [] },
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
      { kind: 'approval', who: 'lead' },
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

  it('names who decides or approves: the lead or the owner', () => {
    assert.equal(error(waiting(TASK, [{ kind: 'approval', who: 'charlie' }])), 'approval charlie: charlie is neither the lead (lead) nor owner');
    assert.equal(waiting(TASK, [{ kind: 'decision', who: 'lead' }]).ok, true);
    assert.equal(waiting(TASK, [{ kind: 'approval', who: 'owner' }]).ok, true);
  });

  it("refuses a peer's decision or approval, naming the task to wait on instead", () => {
    assert.equal(
      error(waiting(TASK, [{ kind: 'approval', who: 'bravo' }])),
      `approval bravo: decision and approval waits are for the lead (lead) and owner; wait on bravo's work by its task: teamrig set T1 --status waiting --ask bravo --text "<the work you need>"`,
    );
    assert.match(error(waiting(TASK, [{ kind: 'task', id: 'T4' }, { kind: 'decision', who: 'alpha' }])), /^decision alpha: decision and approval waits are for the lead/);
    const led = new RegisterPolicy(testConfig({ roles: { lead: 'bravo' } }));
    assert.equal(led.setStatus(TASK, 'alpha', { status: 'waiting', note: 'x', waits: [{ kind: 'approval', who: 'bravo' }] }, CTX).ok, true, 'the lead is whoever roles.lead names');
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

  it('refuses a task wait that closes a loop, naming the chain and the step to ask for as its own task', () => {
    const needing = testTask({ id: 'T5', owner: 'bravo', status: 'open', after: ['T6'] });
    const between = testTask({ id: 'T6', owner: 'bravo', status: 'waiting', startedAt: TASK.startedAt, waits: [{ kind: 'task', id: 'T1' }] });
    const state = stateOf(TASK, needing, between);
    assert.equal(
      error(waiting(TASK, [{ kind: 'task', id: 'T5' }], state)),
      'T1 -> T5 -> T6 -> T1 would be a loop, and no task in a loop can finish: make the step T1 needs from T5 its own task: teamrig set T1 --status waiting --ask bravo --text "<the step>"',
    );
    const finished = stateOf(TASK, needing, { ...between, status: 'done', waits: [] });
    assert.equal(waiting(TASK, [{ kind: 'task', id: 'T5' }], finished).ok, true, 'a finished task needs nothing any more');
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

describe('RegisterPolicy.ask', () => {
  const policy = new RegisterPolicy(testConfig());
  const PLANNED = testTask({ status: 'in-progress', startedAt: '2030-01-07T10:00:00.000Z', priority: 1, goals: ['launch'], week: '2030-01-07', title: 'Ship the release' });
  const ASK: AskInput = { owner: 'bravo', title: 'Land the schema change', due: '2030-01-10' };
  const WAITING = { status: 'waiting' as const };
  const asking = (task: Task, caller = 'alpha', ask: AskInput = ASK, state: RegisterState = stateOf(task)) => policy.ask(task, caller, ask, WAITING, state);

  it("drafts the asked session's task: from the caller, at the task's priority, with its goals, naming it", () => {
    assert.deepEqual(asking(PLANNED), {
      ok: true,
      value: {
        title: 'Land the schema change',
        description: 'Asked by alpha for T1 (Ship the release), which waits on this task.',
        owner: 'bravo',
        source: 'alpha',
        ref: null,
        priority: 1,
        due: '2030-01-10',
        goals: ['launch'],
        week: null,
        after: [],
        size: null,
      },
    });
    const undated = asking(PLANNED, 'alpha', { owner: 'alpha', title: 'Write the migration' });
    assert.equal(undated.ok && undated.value.due, null, 'no --due leaves the task undated; a session may ask itself');
  });

  it('asks only for its own started task, and only to wait on it', () => {
    assert.equal(error(asking(PLANNED, 'bravo')), 'only the owner (alpha) sets the status of T1');
    assert.equal(error(policy.ask(PLANNED, 'alpha', ASK, { status: 'done' }, stateOf(PLANNED))), '--ask goes only with --status waiting');
    assert.equal(
      error(asking(testTask({ status: 'open' }))),
      'T1 has not started, so it does not wait: ask with teamrig add --owner bravo --title "Land the schema change", then plan T1 after that task (teamrig update T1 --after <its id>)',
    );
  });

  it('waits on an active task of the same title instead of adding it twice', () => {
    const tracked = testTask({ id: 'T2', status: 'open', owner: 'bravo', title: 'land the  schema change' });
    assert.equal(
      error(asking(PLANNED, 'alpha', ASK, stateOf(PLANNED, tracked))),
      'T2 already tracks this (open, owner bravo): wait on it with --waits task:T2',
    );
    assert.equal(asking(PLANNED, 'alpha', ASK, stateOf(PLANNED, { ...tracked, status: 'done' })).ok, true, 'a finished one is no duplicate');
  });

  it('judges the asked task as add does', () => {
    assert.match(error(asking(PLANNED, 'alpha', { ...ASK, owner: 'charlie' })), /owner charlie is not a session/);
    assert.match(error(asking(PLANNED, 'alpha', { ...ASK, due: 'friday' })), /due friday is not/);
    assert.match(error(asking(PLANNED, 'alpha', { ...ASK, title: 'x'.repeat(141) })), /141 characters; the limit is 140/);
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

  it('lets the lead change only owner, priority, due, week, after and size', () => {
    assert.equal(policy.update(TASK, 'lead', { owner: 'bravo', due: '2030-01-10' }, undefined, EMPTY).ok, true);
    assert.equal(policy.update(TASK, 'lead', { after: [] }, undefined, EMPTY).ok, true);
    assert.deepEqual(policy.update(TASK, 'lead', { size: 2.5 }, undefined, EMPTY), { ok: true, value: { changes: { size: 2.5 }, note: null } });
    assert.equal(policy.update(TASK, 'lead', { size: null }, undefined, EMPTY).ok, true);
    assert.equal(error(policy.update(TASK, 'bravo', { size: 2 }, undefined, EMPTY)), 'only the owner (alpha) or the lead changes T1');
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
    assert.equal(
      error(policy.update(testTask({ id: 'T1', status: 'open' }), 'alpha', { after: ['T2'] }, undefined, state)),
      'T1 -> T2 -> T1 would be a loop, and no task in a loop can finish: make the step T1 needs from T2 its own task: teamrig add --owner alpha --title "<the step>", then teamrig update T1 --after <its id>',
    );
  });

  it('refuses a plan dependency on a task that waits on it, directly or not', () => {
    const planned = testTask({ id: 'T1', status: 'open' });
    const waitingOn = testTask({ id: 'T2', owner: 'bravo', status: 'waiting', startedAt: '2030-01-07T10:00:00.000Z', waits: [{ kind: 'task', id: 'T3' }] });
    const between = testTask({ id: 'T3', status: 'open', after: ['T1'] });
    const state = stateOf(planned, waitingOn, between);
    assert.match(error(policy.update(planned, 'alpha', { after: ['T2'] }, undefined, state)), /^T1 -> T2 -> T3 -> T1 would be a loop, .* teamrig add --owner bravo /);
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
    assert.equal(error(policy.update(TASK, 'alpha', {}, undefined, EMPTY)), 'nothing to change: give a field or a --note');
  });

  it('lets any session add a note alone, as context on a task it does not own', () => {
    assert.deepEqual(policy.update(TASK, 'bravo', {}, ' 72 of 75 wakes were cold ', EMPTY), { ok: true, value: { changes: {}, note: '72 of 75 wakes were cold' } });
    assert.equal(error(policy.update(TASK, 'bravo', {}, '   ', EMPTY)), 'nothing to change: give a field or a --note');
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

describe('RegisterPolicy, the GitHub import', () => {
  const policy = new RegisterPolicy(testConfig());
  const ISSUE: ImportInput = { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 };
  const IMPORTED: Task = testTask({ id: 'T2', title: 'Fix login', owner: 'bravo', source: 'github', ref: 'gh:acme/web#7', priority: 1 });
  const URL = 'https://github.com/acme/web/issues/7';

  it('adds a task sourced github, keyed by its ref, even under a title the team already tracks', () => {
    const team = testTask({ title: 'Fix login', ref: 'gh:acme/web#7' });
    assert.deepEqual(policy.importAdd(ISSUE, stateOf(team)), {
      ok: true,
      value: { title: 'Fix login', description: null, owner: 'bravo', source: 'github', ref: 'gh:acme/web#7', priority: 1, due: null, goals: [], week: null, after: [], size: null },
    });
    assert.equal(error(policy.importAdd(ISSUE, stateOf(team, IMPORTED))), 'T2 already has ref gh:acme/web#7');
    assert.equal(error(policy.importAdd({ ...ISSUE, owner: 'octocat' }, EMPTY)), 'owner octocat is not a session on this team');
  });

  it('keeps the github source for the import: a session can neither add nor move a task to it', () => {
    assert.equal(error(policy.add({ ...INPUT, source: 'github' }, EMPTY)), 'source github is kept for the tasks teamrig gh sync imports');
    assert.equal(error(policy.update(TASK, 'alpha', { source: 'github' }, undefined, EMPTY)), 'source github is kept for the tasks teamrig gh sync imports');
    assert.equal(policy.update(IMPORTED, 'bravo', { due: '2030-02-01' }, 'planned', EMPTY).ok, true);
  });

  it('updates only the title and priority that differ, on its own tasks only', () => {
    assert.deepEqual(policy.importUpdate(IMPORTED, { title: 'Fix the login', priority: 1 }, 'title changed on GitHub'), {
      ok: true,
      value: { changes: { title: 'Fix the login' }, note: 'title changed on GitHub' },
    });
    assert.equal(error(policy.importUpdate(IMPORTED, { title: 'Fix login', priority: 1 }, 'again')), 'nothing to change');
    assert.equal(error(policy.importUpdate(IMPORTED, { priority: 9 }, 'p9')), 'priority p9 is not one of p1, p2, p3, p4, p5');
    assert.equal(error(policy.importUpdate(TASK, { title: 'Other' }, 'x')), 'T1 is not a GitHub task (source lead): the import changes only its own');
  });

  it('carries the issue body as the description, and follows it, emptied too, whatever the add demands', () => {
    const added = policy.importAdd({ ...ISSUE, description: 'Steps:\n1. log in' }, EMPTY);
    assert.equal(added.ok && added.value.description, 'Steps:\n1. log in');
    assert.deepEqual(policy.importUpdate(IMPORTED, { description: 'Now with steps.' }, 'description as on GitHub'), {
      ok: true,
      value: { changes: { description: 'Now with steps.' }, note: 'description as on GitHub' },
    });
    const described = testTask({ ...IMPORTED, description: 'Now with steps.' });
    assert.deepEqual(policy.importUpdate(described, { description: null }, 'description as on GitHub'), {
      ok: true,
      value: { changes: { description: null }, note: 'description as on GitHub' },
    });
    assert.equal(error(policy.importUpdate(described, { description: 'Now with steps.' }, 'again')), 'nothing to change');
  });

  it('opens, finishes or drops its own tasks, a done with the issue url and no skill', () => {
    const working = testTask({ ...IMPORTED, status: 'in-progress' });
    assert.deepEqual(policy.importStatus(working, { status: 'done', note: 'closed on GitHub as completed', evidence: URL }), {
      ok: true,
      value: { status: 'done', note: 'closed on GitHub as completed', evidence: URL, skill: null },
    });
    assert.equal(policy.importStatus({ ...IMPORTED, status: 'done' }, { status: 'open', note: 'reopened on GitHub' }).ok, true);
    assert.equal(policy.importStatus(IMPORTED, { status: 'dropped', note: 'closed on GitHub as not planned' }).ok, true);
    assert.equal(error(policy.importStatus(IMPORTED, { status: 'done', note: 'closed' })), 'done needs evidence: the issue url');
    assert.equal(error(policy.importStatus(IMPORTED, { status: 'open', note: 'again' })), 'T2 is already open');
    assert.equal(error(policy.importStatus(IMPORTED, { status: 'in-progress' })), 'the GitHub import sets only open, done, dropped, not in-progress');
  });

  it('refuses the github actor on any task that is not the import own, on both status paths', () => {
    assert.equal(error(policy.importStatus(TASK, { status: 'done', evidence: URL })), 'T1 is not a GitHub task (source lead): the import changes only its own');
    assert.equal(error(policy.setStatus(TASK, GITHUB_ACTOR, { status: 'done', evidence: URL, skill: 'none' }, CTX)), 'only the owner (alpha) sets the status of T1');
    assert.equal(error(policy.setStatus(IMPORTED, GITHUB_ACTOR, { status: 'done', evidence: URL, skill: 'none' }, CTX)), 'only the owner (bravo) sets the status of T2');
  });
});
