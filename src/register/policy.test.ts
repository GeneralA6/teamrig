import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { foldEvents, type RegisterState, type Task } from './fold.ts';
import { normaliseTitle, RegisterPolicy, type AddInput, type Verdict } from './policy.ts';

const EMPTY: RegisterState = foldEvents([]);
const INPUT: AddInput = { title: 'Add a health check', owner: 'alpha', source: 'lead', priority: 2 };

const TASK: Task = testTask({ status: 'in-progress' });

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
      value: { title: 'Add a health check', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null },
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
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'blocked', note: `key ${token}` }, false)), /^note looks like it holds a secret/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: token, skill: 'none' }, false)), /^evidence looks like it holds a secret/);
    assert.match(error(policy.update(TASK, 'alpha', { title: 'Add two health checks' }, `see ${token}`)), /^note looks like it holds a secret/);
  });

  it('checks goals and extra secret patterns from the config', () => {
    const strict = new RegisterPolicy(testConfig({ register: { goalPattern: '^G\\d+$', secretPatterns: ['tok_[a-z0-9]{8}'] } }));
    assert.match(error(strict.add({ ...INPUT, goals: ['G1', 'roadmap'] }, EMPTY)), /goal roadmap does not match/);
    assert.match(error(strict.add({ ...INPUT, ref: 'tok_abcd1234' }, EMPTY)), /secret/);
    assert.equal(strict.add({ ...INPUT, goals: ['G1'] }, EMPTY).ok, true);
  });

  it('refuses an active task with the same title, but not a closed one', () => {
    const open = foldEvents([
      { v: 1, type: 'create', id: 'T4', at: TASK.createdAt, by: 'lead', task: { ...INPUT, ref: null, due: null, goals: [], week: null } },
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
    assert.match(error(policy.setStatus(TASK, 'bravo', { status: 'blocked', note: 'x' }, false)), /only the owner \(alpha\)/);
    assert.match(error(policy.setStatus(TASK, 'lead', { status: 'blocked', note: 'x' }, false)), /only the owner/);
  });

  it('requires a note, evidence and a skill to close a task', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done' }, false)), /done needs --note/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying' }, false)), /^verifying needs --note saying what proves it$/);
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'the nightly run' }, false).ok, true);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok' }, false)), /needs --evidence/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234' }, false)), /needs --skill/);
    assert.match(
      error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'web-deploy' }, false)),
      /no skill named web-deploy/,
    );
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'done', note: ' ok ', evidence: 'abc1234', skill: 'none' }, false), {
      ok: true,
      value: { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none' },
    });
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: 'abc', skill: 'web-deploy' }, true).ok, true);
  });

  it('accepts evidence recorded on an earlier status change', () => {
    const withEvidence: Task = { ...TASK, evidence: 'abc1234' };
    assert.equal(policy.setStatus(withEvidence, 'alpha', { status: 'done', note: 'ok', skill: 'none' }, false).ok, true);
  });

  it('keeps --skill for done and wants a reason to repeat a status', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'blocked', note: 'x', skill: 'none' }, false)), /only with done/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'in-progress' }, false)), /already in-progress/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'dropped' }, false)), /dropped needs --note/);
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'open' }, false).ok, true);
  });

  it('follows a relaxed config', () => {
    const relaxed = new RegisterPolicy(
      testConfig({ register: { requireEvidenceOnDone: false, requireSkillOnDone: false, requireNoteOn: [] } }),
    );
    assert.deepEqual(relaxed.setStatus(TASK, 'alpha', { status: 'done' }, false), {
      ok: true,
      value: { status: 'done', note: null, evidence: null, skill: null },
    });
  });
});

describe('RegisterPolicy.update', () => {
  const policy = new RegisterPolicy(testConfig());

  it('lets the owner change any field, validated like a new task', () => {
    assert.deepEqual(policy.update(TASK, 'alpha', { title: 'Add two health checks' }, ' wider '), {
      ok: true,
      value: { changes: { title: 'Add two health checks' }, note: 'wider' },
    });
    assert.match(error(policy.update(TASK, 'alpha', { priority: 7 }, undefined)), /priority p7 is not one of/);
  });

  it('lets the lead change only owner, priority, due and week', () => {
    assert.equal(policy.update(TASK, 'lead', { owner: 'bravo', due: '2030-01-10' }, undefined).ok, true);
    assert.match(error(policy.update(TASK, 'lead', { title: 'x', priority: 1 }, undefined)), /asked: title/);
  });

  it('refuses everyone else and empty changes', () => {
    assert.match(error(policy.update(TASK, 'bravo', { priority: 1 }, undefined)), /only the owner \(alpha\) or the lead/);
    assert.match(error(policy.update(TASK, 'alpha', {}, undefined)), /nothing to change/);
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
    assert.equal(policy.update(handed, 'lead', { priority: 1 }, undefined).ok, true);
    assert.match(error(policy.update(handed, 'lead', { source: 'web/lead' }, undefined)), /source web.lead is neither a session id nor owner/);
  });

  it('refuses another owner, a bare source, and the parent address on a team add', () => {
    assert.equal(error(policy.addFromParent({ ...FROM_PARENT, owner: 'alpha' }, EMPTY)), "a task from the parent team goes to this team's lead (lead), not alpha");
    assert.equal(error(policy.addFromParent({ ...FROM_PARENT, source: 'lead' }, EMPTY)), "source lead is not the parent team lead's <team>/<id>");
    assert.match(error(policy.add({ ...INPUT, source: 'app/lead' }, EMPTY)), /source app.lead is neither a session id nor owner/);
  });
});
