import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DESCRIPTION } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { foldEvents, type RegisterState, type Task } from './fold.ts';
import type { DecisionCard } from './card.ts';
import { CARD_USAGE, DESCRIPTION_NEEDED, GITHUB_ACTOR, normaliseTitle, PROOF_WAITS_USAGE, RegisterPolicy, type AddInput, type AskInput, type ImportInput, type StatusContext, type StatusInput, type Verdict } from './policy.ts';
import type { ProblemReview } from './review.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from './tree.ts';
import type { WaitReason } from './waits.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { WATCH_USAGE } from './verify.ts';

const EMPTY: RegisterState = foldEvents([]);
const INPUT: AddInput = { title: 'Add a health check', description: 'what and why', owner: 'alpha', source: 'lead', priority: 2 };

const TASK: Task = testTask({ status: 'in-progress', startedAt: '2030-01-07T10:00:00.000Z' });
const NOW = new Date('2030-01-08T12:00:00.000Z');
/** A status change judged on an empty register at NOW, with no skill on disk. */
const CTX: StatusContext = { state: EMPTY, elsewhere: NO_TASKS_ELSEWHERE, now: NOW, zone: TimeZone.UTC, skillExists: false };

/** The tasks of the tree's other registers, all on team `web`'s. */
function elsewhereOf(...tasks: readonly Task[]): TasksElsewhere {
  return new Map(tasks.map((task) => [task.id, { team: 'web', task }]));
}
const OWNER_DECISION: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];
/** When a verifying task's proof runs: tonight, after NOW. */
const RUN_TONIGHT: readonly WaitReason[] = [{ kind: 'time', at: '2030-01-08 22:00' }];
/** The refusal of a verifying task that names no time or task its proof runs on. */
const PROOF_RUN_NEEDED = `verifying needs --waits saying when its proof runs: ${PROOF_WAITS_USAGE}; if tests or a dry run proved it and its proof is a sighting, close it done with ${WATCH_USAGE} instead`;
/** The goal tags of the team's goal records and those above it, under `register.goals` checked or required (T1730). */
const KNOWN_GOALS: ReadonlySet<string> = new Set(['A1']);
/** The refusal of goal tag Z9, which no goal record of the team or a team above holds. */
const UNKNOWN_Z9 = 'goal Z9 is not a goal record of the team or a team above: teamrig goal list lists them';

/** A register holding these tasks, its next id after the highest. */
function stateOf(...tasks: Task[]): RegisterState {
  const highest = Math.max(0, ...tasks.map((task) => Number(task.id.slice(1))));
  return { tasks: new Map(tasks.map((task) => [task.id, task])), orphans: 0, moved: new Map(), nextId: `T${highest + 1}` };
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
      value: { title: 'Add a health check', description: 'what and why', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null },
    });
  });

  it("takes teamrig's p0 beside the configured levels, a team with its own levels included", () => {
    const verdict = policy.add({ ...INPUT, priority: 0 }, EMPTY);
    assert.equal(verdict.ok ? verdict.value.priority : undefined, 0);
    const own = new RegisterPolicy(testConfig({ register: { priorities: [{ id: 2, name: 'soon' }] } }));
    assert.equal(error(own.add({ ...INPUT, priority: 0 }, EMPTY)), 'allowed');
    assert.equal(error(own.add({ ...INPUT, priority: 1 }, EMPTY)), 'priority p1 is not one of p0, p2');
  });

  it('keeps the type and critical mark it is given', () => {
    const verdict = policy.add({ ...INPUT, type: 'bug', critical: true }, EMPTY);
    assert.deepEqual(verdict.ok ? [verdict.value.type, verdict.value.critical] : undefined, ['bug', true]);
  });

  it('refuses a critical mark on an item whose type gives no review, an untyped one included', () => {
    const marked: AddInput[] = [{ ...INPUT, critical: true }, { ...INPUT, type: 'task', critical: true }];
    for (const input of marked) {
      assert.equal(error(policy.add(input, EMPTY)), 'critical marks only a bug: give --type bug too', String(input.type));
    }
  });

  it('applies the team policy', () => {
    const cases: [Partial<AddInput>, RegExp][] = [
      [{ title: ' ' }, /title is empty/],
      [{ title: 'x'.repeat(141) }, /141 characters; the limit is 140/],
      [{ owner: 'charlie' }, /owner charlie is not a session/],
      [{ source: 'The Owner' }, /neither a session id nor owner/],
      [{ priority: 9 }, /^priority p9 is not one of p0, p1, p2, p3, p4, p5$/],
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
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, card: TEST_OWNER_CARD, note: `key ${token}` }, CTX)), /^note looks like it holds a secret/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'done', note: 'ok', evidence: token, skill: 'none', followups: [] }, CTX)), /^evidence looks like it holds a secret/);
    assert.match(error(policy.update(TASK, 'alpha', { title: 'Add two health checks' }, `see ${token}`, EMPTY)), /^note looks like it holds a secret/);
  });

  it('checks goals and extra secret patterns from the config', () => {
    const strict = new RegisterPolicy(testConfig({ register: { goalPattern: '^G\\d+$', secretPatterns: ['tok_[a-z0-9]{8}'] } }));
    assert.match(error(strict.add({ ...INPUT, goals: ['G1', 'roadmap'] }, EMPTY)), /goal roadmap does not match/);
    assert.match(error(strict.add({ ...INPUT, ref: 'tok_abcd1234' }, EMPTY)), /secret/);
    assert.equal(strict.add({ ...INPUT, goals: ['G1'] }, EMPTY).ok, true);
  });

  it('keeps a task said to serve no goal, and refuses that mark beside goals (T1730)', () => {
    const verdict = policy.add({ ...INPUT, noGoal: true }, EMPTY);
    assert.deepEqual(verdict.ok ? [verdict.value.goals, verdict.value.noGoal] : undefined, [[], true]);
    assert.equal(error(policy.add({ ...INPUT, goals: ['A1'], noGoal: true }, EMPTY)), 'goals none says the task serves no goal, so it names none (asked: A1)');
  });

  it('holds goal tags to the goal records under register.goals checked or required, and any tag passes under free (T1730)', () => {
    assert.equal(error(policy.add({ ...INPUT, goals: ['Z9'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), 'allowed', 'free');
    for (const goals of ['checked', 'required'] as const) {
      const held = new RegisterPolicy(testConfig({ register: { goals } }));
      assert.equal(error(held.add({ ...INPUT, goals: ['A1', 'Z9'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), UNKNOWN_Z9, goals);
      assert.equal(error(held.add({ ...INPUT, goals: ['A1'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), 'allowed', goals);
      assert.equal(error(held.add({ ...INPUT, goals: ['A1'] }, EMPTY)), 'goal A1 is not a goal record of the team or a team above: teamrig goal list lists them', `${goals}, no records read`);
    }
  });

  it('has an owner-asked or p0/p1 task name its goal or say it serves none under register.goals required (T1730)', () => {
    const required = new RegisterPolicy(testConfig({ register: { goals: 'required' } }));
    const unnamed = (asked: string) => `${asked} task names its goal: --goals <tag>, or --goals none (register.goals is required)`;
    assert.equal(error(required.add({ ...INPUT, source: 'owner' }, EMPTY)), unnamed('an owner-asked'));
    assert.equal(error(required.add({ ...INPUT, source: 'owner', priority: 1 }, EMPTY)), unnamed('an owner-asked'), 'the source is named first');
    assert.equal(error(required.add({ ...INPUT, priority: 1 }, EMPTY)), unnamed('a p1'));
    assert.equal(error(required.add({ ...INPUT, priority: 0 }, EMPTY)), unnamed('a p0'));
    assert.equal(error(required.add({ ...INPUT, source: 'owner', priority: 1, goals: ['A1'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), 'allowed');
    assert.equal(error(required.add({ ...INPUT, source: 'owner', priority: 1, noGoal: true }, EMPTY)), 'allowed');
    assert.equal(error(required.add(INPUT, EMPTY)), 'allowed', "a session's p2 task");
    const checked = new RegisterPolicy(testConfig({ register: { goals: 'checked' } }));
    assert.equal(error(checked.add({ ...INPUT, source: 'owner', priority: 1 }, EMPTY)), 'allowed', 'checked has no task name a goal');
  });

  it('refuses an active task with the same title, but not a closed one', () => {
    const open = foldEvents([
      { v: 1, type: 'create', id: 'T4', at: TASK.createdAt, by: 'lead', task: { ...INPUT, description: null, ref: null, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null } },
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
    assert.equal(error(policy.addFromTeam({ ...BARE, owner: 'lead', source: 'app/lead' }, EMPTY)), DESCRIPTION_NEEDED);
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
    assert.equal(error(policy.update(TASK, 'lead', { description: 'Why it matters.' }, undefined, EMPTY)), 'a leader may change only owner, priority, due, week, after, size, type, critical, pin on a task it does not own (asked: description)');
    assert.equal(error(policy.update(TASK, 'bravo', { description: 'Why it matters.' }, undefined, EMPTY)), 'only the owner (alpha) or the lead (lead) changes T1');
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
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'the nightly run', followups: [] }, CTX)), PROOF_RUN_NEEDED);
    assert.equal(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'the nightly run', waits: RUN_TONIGHT, followups: [] }, CTX).ok, true);
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
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, card: TEST_OWNER_CARD, note: 'x', skill: 'none' }, CTX)), /only with done/);
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

describe('RegisterPolicy.setStatus: a done change watched for its sighting (T1306)', () => {
  const policy = new RegisterPolicy(testConfig());
  const DONE: StatusInput = { status: 'done', note: 'tests green', evidence: '6012 tests', skill: 'none', followups: [] };
  const SIGHTING = "the night's flow lists the new row";
  const WATCHED = testTask({ status: 'done', evidence: '6012 tests', watch: SIGHTING });

  it('closes a change done with the sighting left to watch for', () => {
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { ...DONE, watch: ` ${SIGHTING} ` }, CTX), {
      ok: true,
      value: { status: 'done', note: 'tests green', evidence: '6012 tests', skill: 'none', followups: [], watch: SIGHTING },
    });
  });

  it('refuses --watch on any other status', () => {
    const verifying: StatusInput = { status: 'verifying', note: 'shipped', proof: 'the nightly run', waits: RUN_TONIGHT, followups: [], watch: SIGHTING };
    assert.equal(error(policy.setStatus(TASK, 'alpha', verifying, CTX)), '--watch goes only with --status done');
    assert.equal(error(policy.setStatus(testTask(), 'alpha', { status: 'in-progress', watch: SIGHTING }, CTX)), '--watch goes only with --status done');
  });

  it('names the tests or dry run that proved it, even where done needs no evidence, or takes the evidence already recorded', () => {
    const relaxed = new RegisterPolicy(testConfig({ register: { requireEvidenceOnDone: false } }));
    const bare: StatusInput = { status: 'done', note: 'tests green', skill: 'none', followups: [], watch: SIGHTING };
    assert.equal(error(relaxed.setStatus(TASK, 'alpha', bare, CTX)), '--watch needs --evidence: the tests or dry run that proved the change');
    assert.equal(relaxed.setStatus({ ...TASK, evidence: '6012 tests' }, 'alpha', bare, CTX).ok, true);
  });

  it('refuses a watch past the length limit or holding a secret', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { ...DONE, watch: 'w'.repeat(301) }, CTX)), /^watch has 301 characters/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { ...DONE, watch: `it shows at ${credentialUrl()}` }, CTX)), /^watch looks like it holds a secret/);
  });

  it('clears the watch when set done again without one, and wants a note to repeat the same watch', () => {
    const sighted = policy.setStatus(WATCHED, 'alpha', { ...DONE, note: 'the row showed' }, CTX);
    assert.ok(sighted.ok);
    assert.equal(sighted.value.watch, undefined);
    assert.match(error(policy.setStatus(WATCHED, 'alpha', { status: 'done', watch: SIGHTING }, CTX)), /^T1 is already done; add --note/);
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
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', waits: RUN_TONIGHT }, context)), needs('verifying'));
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
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', waits: OWNER_DECISION, card: TEST_OWNER_CARD, note: 'x', followups: ['T2'] }, context)), only);
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'dropped', note: 'not needed' }, context)), 'allowed');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'dropped', note: 'moved', followups: ['T2'] }, context)), 'allowed');
  });

  it('asks on the statuses the team lists, and on none when the list is empty', () => {
    const strict = new RegisterPolicy(testConfig({ register: { requireFollowupsOn: ['dropped'] } }));
    assert.match(error(strict.setStatus(TASK, 'alpha', { status: 'dropped', note: 'moved' }, context)), /^dropped needs --followups/);
    assert.equal(error(strict.setStatus(TASK, 'alpha', DONE, context)), 'allowed');
    const off = new RegisterPolicy(testConfig({ register: { requireFollowupsOn: [] } }));
    assert.equal(error(off.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', waits: RUN_TONIGHT }, context)), 'allowed');
  });
});

describe("RegisterPolicy.setStatus: a bug's review", () => {
  const policy = new RegisterPolicy(testConfig());
  const BUG = testTask({ status: 'in-progress', type: 'bug' });
  const LEFT = testTask({ id: 'T2', title: 'Add a blank-row spec' });
  const context: StatusContext = { ...CTX, state: stateOf(BUG, LEFT) };
  const REVIEW = {
    cause: 'the parser skipped blank rows',
    how: 'a refactor dropped the guard',
    prevent: 'the reader now refuses blank rows',
    missedTest: 'T2 adds a spec feeding blank rows',
    missedMonitor: 'no monitor can see a skipped row',
    missedLog: 'the skip now logs a warning line',
  } satisfies ProblemReview;
  const VERIFYING: StatusInput = { status: 'verifying', note: 'shipped', proof: 'the nightly run', waits: RUN_TONIGHT, followups: [] };
  const DONE: StatusInput = { status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none', followups: [] };

  it('refuses verifying and done until every part is given, naming only the missing flags', () => {
    assert.equal(
      error(policy.setStatus(BUG, 'alpha', { ...VERIFYING, review: { cause: REVIEW.cause, how: REVIEW.how } }, context)),
      'T1 is a bug: verifying needs its review, --prevent, --missed-test, --missed-monitor and --missed-log (how it happened, what stops it and how it was missed; teamrig help set)',
    );
    assert.match(error(policy.setStatus(BUG, 'alpha', DONE, context)), /^T1 is a bug: done needs its review, --cause, --how, --prevent/);
  });

  it('lets a bug through with every part, given now or kept from an earlier set, and writes the parts given', () => {
    const given = policy.setStatus(BUG, 'alpha', { ...VERIFYING, review: REVIEW }, context);
    assert.deepEqual(given.ok ? given.value.review : undefined, REVIEW);
    const kept = testTask({ ...BUG, review: { ...REVIEW, prevent: 'an older guard text' } });
    const keptContext: StatusContext = { ...context, state: stateOf(kept, LEFT) };
    const later = policy.setStatus(kept, 'alpha', { ...DONE, review: { prevent: REVIEW.prevent } }, keptContext);
    assert.deepEqual(later.ok ? later.value.review : undefined, { prevent: REVIEW.prevent });
    assert.equal(error(policy.setStatus(kept, 'alpha', DONE, keptContext)), 'allowed');
  });

  it('asks --harden of a critical bug, marked so or owned by a critical owner', () => {
    const critical = testTask({ ...BUG, critical: true });
    assert.match(error(policy.setStatus(critical, 'alpha', { ...VERIFYING, review: REVIEW }, context)), /verifying needs its review, --harden \(/);
    const owned = new RegisterPolicy(testConfig({ register: { review: { criticalOwners: ['alpha'] } } }));
    assert.match(error(owned.setStatus(BUG, 'alpha', { ...VERIFYING, review: REVIEW }, context)), /--harden \(/);
    assert.equal(error(owned.setStatus(BUG, 'alpha', { ...VERIFYING, review: { ...REVIEW, harden: 'every reader refuses blank rows' } }, context)), 'allowed');
  });

  it('asks nothing of a task, of a dropped bug, of a status the team leaves out, or with the review off or warning', () => {
    assert.equal(error(policy.setStatus(TASK, 'alpha', DONE, context)), 'allowed');
    assert.equal(error(policy.setStatus(testTask({ ...TASK, type: 'task' }), 'alpha', DONE, context)), 'allowed', 'a typed task too');
    assert.equal(error(policy.setStatus(BUG, 'alpha', { status: 'dropped', note: 'not a bug after all' }, context)), 'allowed');
    const doneOnly = new RegisterPolicy(testConfig({ register: { review: { requireOn: ['done'] } } }));
    assert.equal(error(doneOnly.setStatus(BUG, 'alpha', VERIFYING, context)), 'allowed');
    for (const mode of ['off', 'warn']) {
      const lenient = new RegisterPolicy(testConfig({ register: { review: { mode } } }));
      assert.equal(error(lenient.setStatus(BUG, 'alpha', DONE, context)), 'allowed', mode);
    }
  });

  it('takes review parts on a bug at any status, as a change of their own', () => {
    const started = policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { cause: REVIEW.cause } }, context);
    assert.deepEqual(started.ok ? started.value.review : undefined, { cause: REVIEW.cause });
    assert.match(error(policy.setStatus(BUG, 'alpha', { status: 'in-progress' }, context)), /already in-progress/);
  });

  it('refuses review parts on an item no one typed a bug, naming how to mark it', () => {
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', { status: 'in-progress', review: { how: REVIEW.how } }, context)),
      '--how goes only with a bug: mark it first, teamrig update T1 --type bug',
    );
  });

  it('refuses a part that says too little, or that names a task not on the list', () => {
    assert.match(error(policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { missedTest: 'T2' } }, context)), /^--missed-test says "T2": give at least 3 plain words/);
    assert.equal(
      error(policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { missedLog: 'T9 adds the skip log line' } }, context)),
      'a missed part names T9, which is not on the task list: add it first (teamrig add)',
    );
  });

  it('adds the tasks the missed parts name to the follow-ups, once, never the task itself', () => {
    const closed = policy.setStatus(BUG, 'alpha', { ...DONE, followups: ['T2'], review: { ...REVIEW, missedLog: 'T1 itself logs the skip now' } }, context);
    assert.deepEqual(closed.ok ? closed.value.followups : undefined, ['T2']);
    const started = policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { missedTest: REVIEW.missedTest } }, context);
    assert.deepEqual(started.ok ? started.value.followups : undefined, ['T2']);
  });

  it('holds every part to the length limit and refuses a secret in one', () => {
    assert.equal(
      error(policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { cause: `the cause is ${'x'.repeat(300)}` } }, context)),
      'cause has 313 characters; the limit is 300',
    );
    assert.match(error(policy.setStatus(BUG, 'alpha', { status: 'in-progress', review: { how: `it leaked at ${credentialUrl()} today` } }, context)), /^how looks like it holds a secret/);
  });
});

describe('RegisterPolicy.setStatus: a start waits for the verifying tasks it needs', () => {
  const shipped = testTask({ id: 'T1', owner: 'bravo', status: 'verifying', proof: 'the nightly run' });
  const planned = testTask({ id: 'T2', after: ['T1'] });
  const context = { ...CTX, state: stateOf(shipped, planned) };

  it('refuses the start, naming the task, its proof and its owner', () => {
    assert.equal(
      error(new RegisterPolicy(testConfig()).setStatus(planned, 'alpha', { status: 'in-progress' }, context)),
      'T2 needs T1, still verifying (proof: the nightly run, owner bravo); start T2 once T1 is done, or with --met "<what shows the proof exists>"',
    );
    const both = testTask({ id: 'T3', after: ['T1', 'T2'] });
    const twoHeld = { ...CTX, state: stateOf(shipped, { ...planned, status: 'verifying', note: 'x', proof: 'p' }, both) };
    assert.match(error(new RegisterPolicy(testConfig()).setStatus(both, 'alpha', { status: 'in-progress' }, twoHeld)), /; start T3 once T1 and T2 are done, or with --met /);
  });

  it('lets a start that names what met the held proof through, writing it trimmed and apart from the evidence', () => {
    assert.deepEqual(new RegisterPolicy(testConfig()).setStatus(planned, 'alpha', { status: 'in-progress', met: ' the nightly run is green ' }, context), {
      ok: true,
      value: { status: 'in-progress', note: null, evidence: null, skill: null, met: 'the nightly run is green' },
    });
    const secrets = new RegisterPolicy(testConfig({ register: { secretPatterns: ['hunter2'] } }));
    assert.match(error(secrets.setStatus(planned, 'alpha', { status: 'in-progress', met: 'logged in with hunter2' }, context)), /^met /);
  });

  it('refuses --met on any change but a start a verifying task holds', () => {
    const only = '--met goes only with a start that a verifying task it needs holds';
    const policy = new RegisterPolicy(testConfig());
    assert.equal(error(policy.setStatus(testTask({ id: 'T5' }), 'alpha', { status: 'in-progress', met: 'x' }, context)), only, 'nothing holds it');
    assert.equal(error(policy.setStatus(planned, 'alpha', { status: 'dropped', note: 'not needed', met: 'x' }, context)), only, 'no start');
    const blank = error(policy.setStatus(planned, 'alpha', { status: 'in-progress', met: '  ' }, context));
    assert.equal(blank, error(policy.setStatus(planned, 'alpha', { status: 'in-progress' }, context)), 'a blank --met is none');
  });

  it('lets the start through in warn mode, and any other status in either mode', () => {
    const warn = new RegisterPolicy(testConfig({ register: { verifyGate: 'warn' } }));
    assert.equal(error(warn.setStatus(planned, 'alpha', { status: 'in-progress' }, context)), 'allowed');
    assert.equal(error(new RegisterPolicy(testConfig()).setStatus(planned, 'alpha', { status: 'dropped', note: 'not needed' }, context)), 'allowed');
  });
});

describe('RegisterPolicy.setStatus to verifying', () => {
  const policy = new RegisterPolicy(testConfig());
  const VERIFYING: Task = { ...TASK, status: 'verifying', note: 'shipped', proof: 'the nightly run is green', waits: RUN_TONIGHT };

  it('writes the proof trimmed, only with verifying', () => {
    assert.deepEqual(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: ' the nightly run ', waits: RUN_TONIGHT, followups: [] }, CTX), {
      ok: true,
      value: { status: 'verifying', note: 'shipped', evidence: null, skill: null, waits: RUN_TONIGHT, proof: 'the nightly run', followups: [] },
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
    const dated = policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09 18:00', waits: RUN_TONIGHT, followups: [] }, CTX);
    assert.equal(dated.ok ? dated.value.due : undefined, '2030-01-09 18:00');
    const same = policy.setStatus({ ...TASK, due: '2030-01-09' }, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', due: '2030-01-09', waits: RUN_TONIGHT, followups: [] }, CTX);
    assert.deepEqual(same.ok ? Object.keys(same.value) : undefined, ['status', 'note', 'evidence', 'skill', 'waits', 'proof', 'followups'], 'the same date moves nothing');
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p', due: 'friday' }, CTX)), 'due friday is not YYYY-MM-DD or YYYY-MM-DD HH:MM');
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', { status: 'open', due: '2030-01-09' }, CTX)),
      '--due goes only with --status verifying; teamrig update T1 --due sets it otherwise',
    );
    const moved = policy.setStatus(VERIFYING, 'alpha', { status: 'verifying', note: 'shipped', due: '2030-01-10', followups: [] }, CTX);
    assert.equal(moved.ok ? moved.value.due : undefined, '2030-01-10', 'a new date is a change, not a repeat');
  });

  it('checks the proof like any text', () => {
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: 'p'.repeat(301), waits: RUN_TONIGHT, followups: [] }, CTX)), /^proof has 301 characters/);
    assert.match(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'x', proof: credentialUrl(), waits: RUN_TONIGHT, followups: [] }, CTX)), /proof looks like it holds a secret/);
  });

  it('names what the proof waits for, each reason judged like a waiting one', () => {
    const context = { ...CTX, state: stateOf(testTask({ id: 'T4', owner: 'bravo', status: 'in-progress' })) };
    const waits: WaitReason[] = [
      { kind: 'task', id: 'T4' },
      { kind: 'time', at: '2030-01-09 09:00' },
    ];
    const asked = policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', waits, followups: [] }, context);
    assert.deepEqual(asked.ok ? asked.value.waits : undefined, waits);
    const passed = { status: 'verifying' as const, note: 'x', proof: 'p', waits: [{ kind: 'time' as const, at: '2030-01-08 09:00' }], followups: [] };
    assert.equal(error(policy.setStatus(TASK, 'alpha', passed, CTX)), 'time 01-08 09:00 UTC has passed: name a time to come');
  });

  it('refuses a proof that names no time or task it runs on, and lets an approval stand beside one', () => {
    const verifying = (waits: readonly WaitReason[]): StatusInput => ({ status: 'verifying', note: 'shipped', proof: 'p', waits, followups: [] });
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'verifying', note: 'shipped', proof: 'p', followups: [] }, CTX)), PROOF_RUN_NEEDED);
    const approval: WaitReason[] = [{ kind: 'approval', who: 'lead' }];
    assert.equal(error(policy.setStatus(TASK, 'alpha', verifying(approval), CTX)), PROOF_RUN_NEEDED, 'an approval says who acts, not when the proof runs');
    assert.equal(policy.setStatus(TASK, 'alpha', verifying([...approval, ...RUN_TONIGHT]), CTX).ok, true);
  });

  it('waits a proof only on a task in progress or verifying, whose end runs it', () => {
    const started = '2030-01-07T10:00:00.000Z';
    const tasks = [
      testTask({ id: 'T4', owner: 'bravo', status: 'open' }),
      testTask({ id: 'T5', owner: 'bravo', status: 'waiting', startedAt: started, waits: OWNER_DECISION }),
      testTask({ id: 'T6', owner: 'bravo', status: 'in-progress', startedAt: started }),
      testTask({ id: 'T7', owner: 'bravo', status: 'verifying', startedAt: started, proof: 'the nightly run' }),
    ];
    const context = { ...CTX, state: stateOf(TASK, ...tasks) };
    const onTask = (id: string): StatusInput => ({ status: 'verifying', note: 'shipped', proof: 'p', waits: [{ kind: 'task', id }], followups: [] });
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', onTask('T4'), context)),
      'T4 is open: a proof waits only on a task in progress or verifying; until it starts, set T1 waiting on it (--status waiting --waits task:T4)',
    );
    assert.match(error(policy.setStatus(TASK, 'alpha', onTask('T5'), context)), /^T5 is waiting: a proof waits only on a task in progress or verifying;/);
    assert.equal(policy.setStatus(TASK, 'alpha', onTask('T6'), context).ok, true);
    assert.equal(policy.setStatus(TASK, 'alpha', onTask('T7'), context).ok, true);
    const waiting = policy.setStatus(TASK, 'alpha', { status: 'waiting', note: 'needs the schema', waits: [{ kind: 'task', id: 'T4' }] }, context);
    assert.equal(waiting.ok, true, 'a waiting task may wait on one not started');
  });

  it("refuses a peer's approval of the proof, naming the ask that makes it the peer's task", () => {
    const peer = { status: 'verifying' as const, note: 'x', proof: 'p', waits: [{ kind: 'approval' as const, who: 'bravo' }], followups: [] };
    assert.equal(
      error(policy.setStatus(TASK, 'alpha', peer, CTX)),
      `approval bravo: approval waits are for the lead (lead) and owner; wait on bravo's work by its task: teamrig set T1 --status waiting --ask bravo --text "<the work you need>"`,
    );
  });

  it('keeps what the proof waits for when set verifying again without --waits, and drops it on another status', () => {
    const held: Task = { ...VERIFYING, waits: [{ kind: 'approval', who: 'lead' }, ...RUN_TONIGHT] };
    const redated = policy.setStatus(held, 'alpha', { status: 'verifying', note: 'the run moved', due: '2030-01-11', followups: [] }, CTX);
    assert.deepEqual(redated.ok ? redated.value.waits : undefined, held.waits, 'a new verify-by date leaves the waits in place');
    const replaced = policy.setStatus(held, 'alpha', { status: 'verifying', note: 'x', waits: [{ kind: 'time', at: '2030-01-10' }], followups: [] }, CTX);
    assert.deepEqual(replaced.ok ? replaced.value.waits : undefined, [{ kind: 'time', at: '2030-01-10' }]);
    const reopened = policy.setStatus(held, 'alpha', { status: 'in-progress', note: 'the proof failed' }, CTX);
    assert.equal(reopened.ok && 'waits' in reopened.value, false);
    const waiting: Task = { ...TASK, status: 'waiting', waits: OWNER_DECISION };
    const shipped = { status: 'verifying' as const, note: 'shipped', proof: 'p', followups: [] };
    assert.equal(error(policy.setStatus(waiting, 'alpha', shipped, CTX)), PROOF_RUN_NEEDED, "a waiting task's reasons are not its proof's");
    const fromWaiting = policy.setStatus(waiting, 'alpha', { ...shipped, waits: RUN_TONIGHT }, CTX);
    assert.deepEqual(fromWaiting.ok ? fromWaiting.value.waits : undefined, RUN_TONIGHT);
  });

  it('refuses keeping a proof wait that cleared, and keeps it unjudged when the team does not require --proof', () => {
    const finished = testTask({ id: 'T4', owner: 'bravo', status: 'done' });
    const context = { ...CTX, state: stateOf(finished) };
    const again = { status: 'verifying' as const, note: 'still to run', followups: [] };
    const passed: Task = { ...VERIFYING, waits: [{ kind: 'time', at: '2030-01-08 09:00' }] };
    assert.equal(
      error(policy.setStatus(passed, 'alpha', again, context)),
      `T1's proof waited on time:2030-01-08 09:00, which has cleared: run the proof now and set it done, or name when it runs with --waits (${PROOF_WAITS_USAGE})`,
    );
    assert.match(error(policy.setStatus({ ...VERIFYING, waits: [{ kind: 'task', id: 'T4' }] }, 'alpha', again, context)), /^T1's proof waited on task:T4, which has cleared:/);
    const named = policy.setStatus(passed, 'alpha', { ...again, waits: RUN_TONIGHT }, context);
    assert.deepEqual(named.ok ? named.value.waits : undefined, RUN_TONIGHT, 'a new time names when it runs');
    const relaxed = new RegisterPolicy(testConfig({ register: { requireProofOnVerifying: false } }));
    const kept = relaxed.setStatus(passed, 'alpha', again, context);
    assert.deepEqual(kept.ok ? kept.value.waits : undefined, passed.waits);
  });

  it('refuses putting the proof off to other waits past register.maxReparks, and lets the same waits or a reopen through', () => {
    const parked: Task = { ...VERIFYING, waits: [{ kind: 'time', at: '2030-01-09 02:00' }], reparks: 2 };
    const later = { status: 'verifying' as const, note: 'the run moved', waits: [{ kind: 'time' as const, at: '2030-01-10 02:00' }], followups: [] };
    assert.equal(
      error(policy.setStatus(parked, 'alpha', later, CTX)),
      `T1's proof was put off to other waits 2 times [register.maxReparks]: run the proof now and set it done, close it done with ${WATCH_USAGE} if tests or a dry run proved it, or reopen it (teamrig set T1 --status in-progress)`,
    );
    assert.equal(policy.setStatus({ ...parked, reparks: 1 }, 'alpha', later, CTX).ok, true, 'under the limit');
    assert.equal(policy.setStatus(parked, 'alpha', { status: 'verifying', note: 'still tonight', followups: [] }, CTX).ok, true, 'the same waits kept');
    assert.equal(policy.setStatus(parked, 'alpha', { status: 'in-progress', note: 'the proof failed' }, CTX).ok, true);
    const unlimited = new RegisterPolicy(testConfig({ register: { maxReparks: 0 } }));
    assert.equal(unlimited.setStatus({ ...parked, reparks: 9 }, 'alpha', later, CTX).ok, true, '0 turns the limit off');
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
  /** A wait set with a card when it asks a decision or an approval, as one on the owner must (cardFor). */
  const waiting = (task: Task, waits: readonly WaitReason[], state: RegisterState = STATE) =>
    policy.setStatus(task, 'alpha', { status: 'waiting', note: 'x', waits, ...(asksPerson(waits) ? { card: cardFor(waits) } : {}) }, { ...CTX, state });

  it('keeps every kind of reason, each named once', () => {
    const waits: WaitReason[] = [
      { kind: 'decision', who: 'owner' },
      { kind: 'approval', who: 'lead' },
      { kind: 'task', id: 'T4' },
      { kind: 'time', at: '2030-01-09 13:00' },
    ];
    assert.deepEqual(waiting(TASK, waits), { ok: true, value: { status: 'waiting', note: 'x', evidence: null, skill: null, waits, card: TEST_OWNER_CARD } });
  });

  it('needs a reason, and takes reasons only with waiting or verifying', () => {
    assert.match(error(waiting(TASK, [])), /^waiting needs --waits saying what it waits for: decision:<who>/);
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'in-progress', note: 'x', waits: OWNER_DECISION }, CTX)), '--waits goes only with --status waiting or verifying');
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
      `approval bravo: approval waits are for the lead (lead) and owner; wait on bravo's work by its task: teamrig set T1 --status waiting --ask bravo --text "<the work you need>"`,
    );
    assert.match(error(waiting(TASK, [{ kind: 'task', id: 'T4' }, { kind: 'decision', who: 'alpha' }])), /^decision alpha: decision waits are for the lead/);
    const led = new RegisterPolicy(testConfig({ roles: { lead: 'bravo' } }));
    assert.equal(led.setStatus(TASK, 'alpha', { status: 'waiting', note: 'x', waits: [{ kind: 'approval', who: 'bravo' }] }, CTX).ok, true, 'the lead is whoever roles.lead names');
  });

  it("takes a wait on a leader above the owner, refusing another group's sub-lead (T781)", () => {
    const tree = new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], leads: { alpha: ['bravo'], charlie: ['delta'] } }));
    const bravos = testTask({ id: 'T9', owner: 'bravo', status: 'in-progress' });
    const wait = (who: string) =>
      tree.setStatus(bravos, 'bravo', { status: 'waiting', note: 'x', waits: [{ kind: 'approval', who }], card: TEST_CARD }, { ...CTX, state: stateOf(bravos) });
    assert.equal(wait('alpha').ok, true, "bravo's sub-lead approves");
    assert.equal(wait('lead').ok, true, 'the lead above the sub-lead still does');
    assert.equal(
      error(wait('charlie')),
      `approval charlie: approval waits are for a leader above bravo (alpha or lead) and owner; wait on charlie's work by its task: teamrig set T9 --status waiting --ask charlie --text "<the work you need>"`,
    );
  });

  it("has a child team's lead wait on the parent team's lead, its members still on theirs (T1140)", () => {
    const child = new RegisterPolicy(testConfig(), { team: 'app', id: 'boss' });
    const leads = testTask({ owner: 'lead', status: 'in-progress', startedAt: TASK.startedAt });
    const wait = (on: RegisterPolicy, task: Task, who: string) =>
      on.setStatus(task, task.owner, { status: 'waiting', note: 'x', waits: [{ kind: 'approval', who }], card: TEST_CARD }, { ...CTX, state: stateOf(task) });
    assert.equal(wait(child, leads, 'app/boss').ok, true, "the parent team's lead approves the child lead's work");
    assert.equal(error(wait(child, leads, 'lead')), "approval lead: approval waits are for the parent team's lead (app/boss) and owner; wait on lead's work by its task: teamrig set T1 --status waiting --ask lead --text \"<the work you need>\"");
    assert.equal(error(wait(policy, leads, 'app/boss')), 'approval app/boss: app/boss is neither the lead (lead) nor owner', 'a root team has no lead above');
    assert.equal(error(wait(child, TASK, 'app/boss')), 'approval app/boss: app/boss is neither the lead (lead) nor owner', 'a member waits on its own leaders');
    assert.equal(wait(child, TASK, 'lead').ok, true);
  });

  it('waits on a task only once started, and only on another live task', () => {
    assert.equal(
      error(waiting(OPEN, [{ kind: 'task', id: 'T4' }])),
      'T2 has not started, so it does not wait on T4: it stays open, planned after it (teamrig update T2 --after T4)',
    );
    assert.match(error(waiting(testTask({ id: 'T5', status: 'waiting', startedAt: null }), [{ kind: 'task', id: 'T4' }])), /T5 has not started/);
    assert.equal(
      error(waiting(DONE, [{ kind: 'task', id: 'T4' }])),
      'T3 is done, so it waits on nothing: reopen it (teamrig set T3 --status in-progress), then set it waiting on T4',
      'a finished task is named as finished, not as one that never started',
    );
    const dropped = testTask({ id: 'T5', status: 'dropped', startedAt: '2030-01-07T10:00:00.000Z' });
    assert.match(error(waiting(dropped, [{ kind: 'task', id: 'T4' }], stateOf(TASK, OPEN, DONE, BUSY, dropped))), /^T5 is dropped, so it waits on nothing: reopen it/);
    assert.equal(waiting(testTask({ status: 'waiting', startedAt: '2030-01-07T10:00:00.000Z' }), [{ kind: 'task', id: 'T4' }]).ok, true);
    const shipped = testTask({ status: 'verifying', startedAt: null, note: 'shipped', proof: 'the nightly run' });
    const proofWait = policy.setStatus(shipped, 'alpha', { status: 'verifying', note: 'x', waits: [{ kind: 'task', id: 'T4' }], followups: [] }, { ...CTX, state: STATE });
    assert.deepEqual(proofWait.ok ? proofWait.value.waits : undefined, [{ kind: 'task', id: 'T4' }], 'a verifying task has started, whatever its row says, and its proof waits on T4');
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T1' }])), 'T1 cannot wait on itself');
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T9' }])), 'no task T9');
    assert.equal(error(waiting(TASK, [{ kind: 'task', id: 'T3' }])), 'T3 is already finished; nothing to wait on');
  });

  it('sends a waiting task that never started to a plan, which update --after then takes', () => {
    const approval = testTask({ id: 'T5', status: 'waiting', startedAt: null, waits: [{ kind: 'approval', who: 'owner' }] });
    const state = stateOf(TASK, OPEN, DONE, BUSY, approval);
    assert.equal(
      error(waiting(approval, [...approval.waits, { kind: 'task', id: 'T4' }], state)),
      'T5 has not started, so it does not wait on T4: it stays waiting, planned after it (teamrig update T5 --after T4)',
    );
    assert.deepEqual(policy.update(approval, 'alpha', { after: ['T4'] }, undefined, state), { ok: true, value: { changes: { after: ['T4'] }, note: null } });
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

  it("waits on another register's task of the team tree, judged as one of its own (T1139)", () => {
    const own = stateOf(TASK);
    const onWeb = (elsewhere: TasksElsewhere, id: string) =>
      policy.setStatus(TASK, 'alpha', { status: 'waiting', note: 'x', waits: [{ kind: 'task', id }] }, { ...CTX, state: own, elsewhere });
    const web = elsewhereOf(
      testTask({ id: 'T7', owner: 'front', status: 'in-progress' }),
      testTask({ id: 'T8', owner: 'front', status: 'done' }),
      testTask({ id: 'T9', owner: 'front', status: 'waiting', startedAt: TASK.startedAt, waits: [{ kind: 'task', id: 'T1' }] }),
    );
    assert.equal(onWeb(web, 'T7').ok, true, 'above its own next number');
    assert.equal(error(onWeb(NO_TASKS_ELSEWHERE, 'T7')), 'no task T7', 'not without the other registers');
    assert.equal(error(onWeb(web, 'T8')), 'T8 is already finished; nothing to wait on');
    assert.equal(error(onWeb(web, 'T12')), 'no task T12');
    assert.match(error(onWeb(web, 'T9')), /^T1 -> T9 -> T1 would be a loop, .* --ask front /, 'a loop through the other register');
    const below = elsewhereOf(testTask({ id: 'T1', owner: 'front' }));
    assert.equal(error(onWeb(below, 'T1')), 'T1 cannot wait on itself', 'its own id is its own task, whatever another register holds');
  });

  it("reads an id below its next number that no register holds as finished", () => {
    const own = stateOf(TASK, testTask({ id: 'T4' }));
    const state: RegisterState = { ...own, tasks: new Map([[TASK.id, TASK]]) };
    assert.equal(error(policy.setStatus(TASK, 'alpha', { status: 'waiting', note: 'x', waits: [{ kind: 'task', id: 'T3' }] }, { ...CTX, state })), 'T3 is already finished; nothing to wait on');
  });

  it("takes a follow-up another register of the team tree holds", () => {
    const done = { status: 'done' as const, note: 'ok', evidence: 'abc1234', skill: 'none', followups: ['T7'] };
    const elsewhere = elsewhereOf(testTask({ id: 'T7', owner: 'front' }));
    const left = policy.setStatus(TASK, 'alpha', done, { ...CTX, state: stateOf(TASK), elsewhere });
    assert.deepEqual(left.ok ? left.value.followups : undefined, ['T7']);
    assert.equal(error(policy.setStatus(TASK, 'alpha', done, { ...CTX, state: stateOf(TASK) })), '--followups names T7, which is not on the task list: add it first (teamrig add)');
  });

  it('waits until a time to come, never one that passed', () => {
    assert.equal(error(waiting(TASK, [{ kind: 'time', at: '2030-01-08 11:59' }])), 'time 01-08 11:59 UTC has passed: name a time to come');
    assert.equal(waiting(TASK, [{ kind: 'time', at: '2030-01-08' }]).ok, true, 'a bare day lasts to its end');
  });

  it('takes the same status again only with a new note or new reasons', () => {
    const held = testTask({ status: 'waiting', startedAt: TASK.startedAt, waits: OWNER_DECISION, card: TEST_OWNER_CARD });
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
        noGoal: false,
        week: null,
        after: [],
        size: null,
        type: null,
        critical: false,
        pin: null,
      },
    });
    const undated = asking(PLANNED, 'alpha', { owner: 'alpha', title: 'Write the migration' });
    assert.equal(undated.ok && undated.value.due, null, 'no --due leaves the task undated; a session may ask itself');
  });

  it('copies the no-goal mark of a task said to serve no goal (T1730)', () => {
    const offPlan = testTask({ ...PLANNED, goals: [], noGoal: true });
    const asked = asking(offPlan);
    assert.deepEqual(asked.ok ? [asked.value.goals, asked.value.noGoal] : undefined, [[], true]);
  });

  it('copies the goals of the waiting task without holding them to the goal records again (T1730)', () => {
    const checked = new RegisterPolicy(testConfig({ register: { goals: 'checked' } }));
    const asked = checked.ask(PLANNED, 'alpha', ASK, WAITING, stateOf(PLANNED));
    assert.deepEqual(asked.ok ? asked.value.goals : error(asked), ['launch'], 'a tag named before register.goals was checked');
  });

  it('asks only for its own started task, and only to wait on it', () => {
    assert.equal(error(asking(PLANNED, 'bravo')), 'only the owner (alpha) sets the status of T1');
    assert.equal(error(policy.ask(PLANNED, 'alpha', ASK, { status: 'done' }, stateOf(PLANNED))), '--ask goes only with --status waiting');
    assert.equal(
      error(policy.ask(PLANNED, 'alpha', ASK, { status: 'verifying' }, stateOf(PLANNED))),
      '--ask goes only with --status waiting: the asked task starts open, and a proof waits only on a task in progress or verifying, so T1 waits on it until it starts (teamrig set T1 --status waiting --ask bravo --text "Land the schema change")',
    );
    const shipped = testTask({ status: 'verifying', startedAt: null, proof: 'the nightly run' });
    assert.match(error(policy.ask(shipped, 'alpha', ASK, { status: 'verifying' }, stateOf(shipped))), /^--ask goes only with --status waiting: /, 'one already verifying waits on the asked work too');
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

  it('lets the lead change only owner, priority, due, week, after, size, type, critical and pin', () => {
    assert.equal(policy.update(TASK, 'lead', { owner: 'bravo', due: '2030-01-10' }, undefined, EMPTY).ok, true);
    assert.equal(policy.update(TASK, 'lead', { after: [] }, undefined, EMPTY).ok, true);
    assert.deepEqual(policy.update(TASK, 'lead', { size: 2.5 }, undefined, EMPTY), { ok: true, value: { changes: { size: 2.5 }, note: null } });
    assert.equal(policy.update(TASK, 'lead', { size: null }, undefined, EMPTY).ok, true);
    assert.deepEqual(policy.update(TASK, 'lead', { type: 'bug', critical: true }, undefined, EMPTY), { ok: true, value: { changes: { type: 'bug', critical: true }, note: null } });
    assert.deepEqual(policy.update(TASK, 'lead', { pin: 'lead' }, undefined, EMPTY), { ok: true, value: { changes: { pin: 'lead' }, note: null } });
    assert.equal(error(policy.update(TASK, 'bravo', { size: 2 }, undefined, EMPTY)), 'only the owner (alpha) or the lead (lead) changes T1');
    assert.equal(error(policy.update(TASK, 'bravo', { type: 'bug' }, undefined, EMPTY)), 'only the owner (alpha) or the lead (lead) changes T1');
    assert.match(error(policy.update(TASK, 'lead', { title: 'x', priority: 1 }, undefined, EMPTY)), /asked: title/);
  });

  it('refuses a critical mark on a task, and clears the mark when a critical bug becomes a task (T1252)', () => {
    assert.equal(error(policy.update(TASK, 'alpha', { critical: true }, undefined, EMPTY)), 'critical marks only a bug: give --type bug too');
    assert.equal(error(policy.update(testTask({ ...TASK, type: 'task' }), 'alpha', { critical: true }, undefined, EMPTY)), 'critical marks only a bug: give --type bug too');
    const criticalBug = testTask({ ...TASK, type: 'bug', critical: true });
    assert.deepEqual(policy.update(criticalBug, 'alpha', { type: 'task' }, undefined, EMPTY), { ok: true, value: { changes: { type: 'task', critical: false }, note: null } });
    assert.deepEqual(policy.update(criticalBug, 'alpha', { critical: false }, undefined, EMPTY), { ok: true, value: { changes: { critical: false }, note: null } });
    assert.equal(error(policy.update(criticalBug, 'alpha', { type: 'task', critical: true }, undefined, EMPTY)), 'critical marks only a bug: give --type bug too', 'an asked mark is never cleared');
  });

  it('clears the no-goal mark when goals are named, and refuses goals beside the mark (T1730)', () => {
    const offPlan = testTask({ ...TASK, noGoal: true });
    assert.deepEqual(policy.update(offPlan, 'alpha', { goals: ['A1'] }, undefined, EMPTY), { ok: true, value: { changes: { goals: ['A1'], noGoal: false }, note: null } });
    assert.deepEqual(policy.update(TASK, 'alpha', { goals: ['A1'] }, undefined, EMPTY), { ok: true, value: { changes: { goals: ['A1'] }, note: null } }, 'a task without the mark changes only its goals');
    assert.deepEqual(policy.update(TASK, 'alpha', { goals: [], noGoal: true }, undefined, EMPTY), { ok: true, value: { changes: { goals: [], noGoal: true }, note: null } });
    assert.equal(error(policy.update(TASK, 'alpha', { goals: ['A1'], noGoal: true }, undefined, EMPTY)), 'goals none says the task serves no goal, so it names none (asked: A1)');
  });

  it('holds only the goals an update names to the goal records, so a tag the task had blocks no other change (T1730)', () => {
    const checked = new RegisterPolicy(testConfig({ register: { goals: 'checked' } }));
    const tagged = testTask({ ...TASK, goals: ['Z9'] });
    assert.equal(error(checked.update(tagged, 'alpha', { priority: 1 }, undefined, EMPTY)), 'allowed');
    assert.equal(error(checked.update(tagged, 'alpha', { goals: ['A1', 'Z9'] }, undefined, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), UNKNOWN_Z9);
    assert.equal(error(checked.update(tagged, 'alpha', { goals: ['A1'] }, undefined, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), 'allowed');
    assert.equal(error(checked.update(tagged, 'alpha', { goals: [], noGoal: true }, undefined, EMPTY)), 'allowed', 'goals none names no tag');
    const required = new RegisterPolicy(testConfig({ register: { goals: 'required' } }));
    assert.equal(error(required.update(TASK, 'alpha', { priority: 1 }, undefined, EMPTY)), 'allowed', 'required asks a goal only of a new task');
  });

  it("lets a sub-lead set its group's work order and keep the work in its group, never another group's (T782)", () => {
    const tree = new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta', 'echo'], leads: { alpha: ['bravo', 'charlie'], charlie: ['delta'] } }));
    const deltas = testTask({ id: 'T9', owner: 'delta' });
    assert.equal(tree.update(deltas, 'charlie', { priority: 1, due: '2030-01-10', after: [] }, undefined, EMPTY).ok, true, "delta's sub-lead orders its work");
    assert.equal(tree.update(deltas, 'alpha', { size: 2 }, undefined, EMPTY).ok, true, "charlie's sub-lead leads delta too");
    assert.equal(tree.update(deltas, 'alpha', { owner: 'bravo' }, undefined, EMPTY).ok, true, 'to a session in its group');
    assert.equal(tree.update(deltas, 'charlie', { owner: 'charlie' }, undefined, EMPTY).ok, true, 'to itself');
    assert.equal(
      error(tree.update(deltas, 'charlie', { owner: 'bravo' }, undefined, EMPTY)),
      'charlie hands T9 only to itself or a session it leads (delta); the lead (lead) moves work between groups',
    );
    assert.equal(tree.update(deltas, 'lead', { owner: 'echo' }, undefined, EMPTY).ok, true, 'the lead moves work anywhere');
    assert.equal(error(tree.update(deltas, 'bravo', { priority: 1 }, undefined, EMPTY)), 'only the owner (delta) or a leader above delta (charlie or alpha or lead) changes T9');
    assert.equal(error(tree.update(testTask({ owner: 'alpha' }), 'charlie', { priority: 1 }, undefined, EMPTY)), 'only the owner (alpha) or the lead (lead) changes T1', 'not its own leader');
    assert.equal(error(tree.update(testTask({ owner: 'echo' }), 'alpha', { priority: 1 }, undefined, EMPTY)), 'only the owner (echo) or the lead (lead) changes T1', 'nor a session outside its group');
    assert.match(error(tree.update(deltas, 'charlie', { title: 'x' }, undefined, EMPTY)), /^a leader may change only owner, .* \(asked: title\)$/);
  });

  it("lets only the owner's leaders pin its task, each pin naming who set it, and the lead its own tasks too (T637)", () => {
    const tree = new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], leads: { alpha: ['bravo', 'charlie'], charlie: ['delta'] } }));
    const deltas = testTask({ id: 'T9', owner: 'delta' });
    assert.equal(tree.update(deltas, 'charlie', { pin: 'charlie' }, undefined, EMPTY).ok, true, "delta's sub-lead pins");
    assert.equal(tree.update(deltas, 'alpha', { pin: null }, undefined, EMPTY).ok, true, 'a leader above unpins');
    const own = "delta does not pin its own T9: a leader above delta (charlie or alpha or lead) pins a task above its owner's order";
    assert.equal(error(tree.update(deltas, 'delta', { pin: 'delta' }, undefined, EMPTY)), own);
    assert.equal(error(tree.update(deltas, 'delta', { pin: null }, undefined, EMPTY)), own, 'nor unpins it');
    assert.equal(
      error(tree.update(deltas, 'charlie', { owner: 'charlie', pin: 'charlie' }, undefined, EMPTY)),
      "charlie does not pin its own T9: a leader above charlie (alpha or lead) pins a task above its owner's order",
      'nor a task it takes in the same change',
    );
    assert.equal(error(tree.update(deltas, 'charlie', { pin: 'alpha' }, undefined, EMPTY)), 'a pin names the session that sets it (charlie), not alpha');
    assert.equal(tree.update(testTask({ owner: 'lead' }), 'lead', { pin: 'lead' }, undefined, EMPTY).ok, true, 'the lead pins its own');
    assert.equal(error(tree.update(deltas, 'bravo', { pin: 'bravo' }, undefined, EMPTY)), 'only the owner (delta) or a leader above delta (charlie or alpha or lead) changes T9');
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
    assert.equal(
      error(policy.update({ ...first, status: 'verifying' }, 'alpha', { after: ['T3'] }, undefined, state)),
      '--after plans a task not started yet, and T1 is verifying; a started task waits on another with --status verifying --waits task:T3',
    );
    const started = testTask({ id: 'T4', status: 'waiting', startedAt: '2030-01-07T10:00:00.000Z' });
    assert.match(error(policy.update(started, 'alpha', { after: ['T3'] }, undefined, state)), /T4 is waiting; a started task waits on another/);
    assert.equal(error(policy.update(testTask({ id: 'T4', status: 'done' }), 'alpha', { after: ['T3'] }, undefined, state)), '--after plans a task not started yet, and T4 is done');
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
    assert.equal(error(policy.add({ ...INPUT, title: 'Ship it', after: ['T3'] }, state)), 'no task T3', 'the id it may get is no task yet');
    assert.equal(error(policy.add({ ...INPUT, title: 'Ship it', after: ['T4'] }, state)), 'no task T4');
  });

  it("plans a task after another register's of the team tree, which this register's next number may name", () => {
    const state = stateOf(testTask({ id: 'T1' }));
    const elsewhere = elsewhereOf(testTask({ id: 'T2', owner: 'front' }), testTask({ id: 'T5', owner: 'front', status: 'done' }));
    const added = policy.add({ ...INPUT, title: 'Ship it', after: ['T2', 'T5'] }, state, elsewhere);
    assert.equal(added.ok && added.value.after.join(','), 'T2,T5', 'a finished one too, as on its own register');
    assert.equal(error(policy.add({ ...INPUT, title: 'Ship it', after: ['T6'] }, state, elsewhere)), 'no task T6');
    const open = testTask({ id: 'T1', status: 'open' });
    assert.deepEqual(policy.update(open, 'alpha', { after: ['T2'] }, undefined, state, elsewhere), { ok: true, value: { changes: { after: ['T2'] }, note: null } });
    assert.equal(error(policy.update(open, 'alpha', { after: ['T2'] }, undefined, state)), 'no task T2', 'not without the other registers');
  });

  it("refuses a plan dependency that closes a loop through another register's task", () => {
    const open = testTask({ id: 'T1', status: 'open' });
    const elsewhere = elsewhereOf(testTask({ id: 'T2', owner: 'front', after: ['T1'] }));
    assert.match(error(policy.update(open, 'alpha', { after: ['T2'] }, undefined, stateOf(open), elsewhere)), /^T1 -> T2 -> T1 would be a loop, .* teamrig add --owner front /);
  });

  it('refuses everyone else and empty changes', () => {
    assert.match(error(policy.update(TASK, 'bravo', { priority: 1 }, undefined, EMPTY)), /only the owner \(alpha\) or the lead \(lead\)/);
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

describe('RegisterPolicy.addFromTeam', () => {
  const policy = new RegisterPolicy(testConfig());
  const FROM_TEAM: AddInput = { ...INPUT, owner: 'lead', source: 'app/lead' };

  it('takes a task for the lead, sourced <team>/<id>, which an update keeps', () => {
    const verdict = policy.addFromTeam(FROM_TEAM, EMPTY);
    assert.equal(verdict.ok && verdict.value.source, 'app/lead');
    const handed = testTask({ owner: 'lead', source: 'app/lead' });
    assert.equal(policy.update(handed, 'lead', { priority: 1 }, undefined, EMPTY).ok, true);
    assert.match(error(policy.update(handed, 'lead', { source: 'web/lead' }, undefined, EMPTY)), /source web.lead is neither a session id nor owner/);
  });

  it('gives the task to any session of the team, as asked', () => {
    const verdict = policy.addFromTeam({ ...FROM_TEAM, owner: 'alpha', source: 'ops/run' }, EMPTY);
    assert.deepEqual(verdict.ok && [verdict.value.owner, verdict.value.source], ['alpha', 'ops/run']);
  });

  it('refuses an owner off the roster, a bare source, and an address on a team add', () => {
    assert.equal(error(policy.addFromTeam({ ...FROM_TEAM, owner: 'zulu' }, EMPTY)), 'owner zulu is not a session on this team');
    assert.equal(error(policy.addFromTeam({ ...FROM_TEAM, source: 'lead' }, EMPTY)), "source lead is not the asking session's <team>/<id>");
    assert.match(error(policy.add({ ...INPUT, source: 'app/lead' }, EMPTY)), /source app.lead is neither a session id nor owner/);
  });

  it("holds its goal tags to this team's goal records, and leaves naming a goal to the asking team (T1730)", () => {
    const required = new RegisterPolicy(testConfig({ register: { goals: 'required' } }));
    assert.equal(error(required.addFromTeam({ ...FROM_TEAM, goals: ['Z9'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), UNKNOWN_Z9);
    assert.equal(error(required.addFromTeam({ ...FROM_TEAM, goals: ['A1'] }, EMPTY, NO_TASKS_ELSEWHERE, KNOWN_GOALS)), 'allowed');
    assert.equal(error(required.addFromTeam({ ...FROM_TEAM, priority: 1 }, EMPTY)), 'allowed', 'a p1 ask without goals');
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
      value: { title: 'Fix login', description: null, owner: 'bravo', source: 'github', ref: 'gh:acme/web#7', priority: 1, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null },
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
    assert.equal(error(policy.importUpdate(IMPORTED, { priority: 9 }, 'p9')), 'priority p9 is not one of p0, p1, p2, p3, p4, p5');
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
/** True when the reasons ask a decision or an approval, which take a card. */
function asksPerson(waits: readonly WaitReason[]): boolean {
  return waits.some((reason) => reason.kind === 'decision' || reason.kind === 'approval');
}

/** The card a wait asking a person takes: naming its gate on the owner's decision (T1194). */
function cardFor(waits: readonly WaitReason[]): DecisionCard {
  return waits.some((reason) => reason.kind === 'decision' && reason.who === 'owner') ? TEST_OWNER_CARD : TEST_CARD;
}

/** How `--gate` is typed under the default owner gates. */
const GATE_USAGE = '--gate "<destructive data operations, product and design decisions, permissions, budget, resource changes or business>"';

describe('RegisterPolicy.setStatus: the decision card', () => {
  const policy = new RegisterPolicy(testConfig());
  const ASKED = testTask({ status: 'waiting', startedAt: TASK.startedAt, waits: OWNER_DECISION, card: TEST_OWNER_CARD });
  const set = (task: Task, input: Omit<StatusInput, 'status'>, on: RegisterPolicy = policy) => on.setStatus(task, 'alpha', { status: 'waiting', note: 'x', ...input }, CTX);

  it("needs a card on a wait on the owner's decision or approval, so the owner decides from it alone", () => {
    assert.equal(error(set(TASK, { waits: OWNER_DECISION })), `a wait on owner's decision needs a card, so owner decides from it alone: ${CARD_USAGE} ${GATE_USAGE}`);
    assert.match(error(set(TASK, { waits: [{ kind: 'approval', who: 'owner' }, ...OWNER_DECISION] })), /^a wait on owner's approval and decision needs a card/);
    assert.equal(error(set(TASK, { waits: [{ kind: 'approval', who: 'owner' }] })), `a wait on owner's approval needs a card, so owner decides from it alone: ${CARD_USAGE}`);
    assert.deepEqual(set(TASK, { waits: OWNER_DECISION, card: TEST_OWNER_CARD }), {
      ok: true,
      value: { status: 'waiting', note: 'x', evidence: null, skill: null, waits: OWNER_DECISION, card: TEST_OWNER_CARD },
    });
  });

  it("asks the owner to decide only an owner gate or a business decision, else refers it to the leader (T1194)", () => {
    const refusal = `only an owner gate or a business decision is owner's to decide: give ${GATE_USAGE}; any other question is yours however many good answers it has: decide it, or wait on your leader (--waits decision:lead)`;
    assert.equal(error(set(TASK, { waits: OWNER_DECISION, card: TEST_CARD })), refusal, 'a new card');
    assert.equal(error(set({ ...ASKED, card: TEST_CARD }, { waits: OWNER_DECISION, note: 'asked again' })), refusal, 'a card kept from an older row');
    const lead = testTask({ status: 'in-progress', startedAt: TASK.startedAt, owner: 'lead' });
    assert.match(
      error(policy.setStatus(lead, 'lead', { status: 'waiting', note: 'x', waits: OWNER_DECISION, card: TEST_CARD }, CTX)),
      /good answers it has: decide it$/,
      'the lead has no leader to wait on',
    );
    const child = new RegisterPolicy(testConfig(), { team: 'app', id: 'boss' });
    assert.match(
      error(child.setStatus(lead, 'lead', { status: 'waiting', note: 'x', waits: OWNER_DECISION, card: TEST_CARD }, CTX)),
      /good answers it has: decide it, or wait on your leader \(--waits decision:app\/boss\)$/,
      "a child team's lead waits on the parent team's lead (T1140)",
    );
    const business = set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, gate: 'Business ' } });
    assert.deepEqual(business.ok ? business.value.card : undefined, { ...TEST_CARD, gate: 'business' }, 'named as configured');
    assert.equal(set(TASK, { waits: [{ kind: 'approval', who: 'owner' }], card: { ...TEST_CARD, options: [] } }).ok, true, "an approval on the owner needs no gate");
    assert.equal(set(TASK, { waits: [{ kind: 'decision', who: 'lead' }], card: TEST_CARD }).ok, true, "a decision of the lead's needs no gate");
    const relaxed = new RegisterPolicy(testConfig({ register: { requireDecisionCard: false } }));
    assert.equal(set(TASK, { waits: OWNER_DECISION, card: TEST_CARD }, relaxed).ok, true, 'requireDecisionCard off');
  });

  it('takes --gate only on a wait on the owner\'s decision, naming an owner gate or business, and keeps it only while it waits on one (T1194)', () => {
    assert.equal(
      error(set(TASK, { waits: [{ kind: 'approval', who: 'owner' }], card: { ...TEST_OWNER_CARD, options: [] } })),
      "--gate names the owner gate or business decision that makes a question owner's: it goes only with a wait on owner's decision",
    );
    assert.equal(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, gate: 'staffing' } })), `--gate "staffing" is no owner gate [ownerGates] and no business decision: ${GATE_USAGE}`);
    const changed = set(ASKED, { waits: OWNER_DECISION, card: { gate: 'permissions' } });
    assert.deepEqual(changed.ok ? changed.value.card : undefined, { ...TEST_CARD, gate: 'permissions' }, 'a later set changes the gate alone');
    const toLead = set(ASKED, { waits: [{ kind: 'decision', who: 'lead' }] });
    assert.deepEqual(toLead.ok ? toLead.value.card : undefined, TEST_CARD, "a wait moved to the lead's decision drops it");
    const gated = new RegisterPolicy(testConfig({ ownerGates: ['hiring'] }));
    assert.equal(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, gate: 'hiring' } }, gated).ok, true, 'the team names its own gates');
    assert.match(error(set(TASK, { waits: OWNER_DECISION, card: TEST_OWNER_CARD }, gated)), /^--gate "budget" is no owner gate \[ownerGates\] and no business decision: --gate "<hiring or business>"$/);
  });

  it("takes a card on the lead's wait without needing one, and needs none while requireDecisionCard is off", () => {
    const lead: WaitReason[] = [{ kind: 'approval', who: 'lead' }];
    assert.deepEqual(set(TASK, { waits: lead }), { ok: true, value: { status: 'waiting', note: 'x', evidence: null, skill: null, waits: lead } });
    assert.equal(set(TASK, { waits: lead, card: { ...TEST_CARD, options: [] } }).ok, true, 'an approval lists no options');
    const relaxed = new RegisterPolicy(testConfig({ register: { requireDecisionCard: false } }));
    assert.equal(set(TASK, { waits: OWNER_DECISION }, relaxed).ok, true);
  });

  it('refuses the card flags without a wait on a decision or an approval', () => {
    const refusal = '--question, --options, --recommend and --default go only with --status waiting or verifying on a decision or an approval';
    assert.equal(error(set(TASK, { waits: [{ kind: 'time', at: '2030-01-09' }], card: TEST_CARD })), refusal);
    assert.equal(error(policy.setStatus(testTask({ id: 'T2' }), 'alpha', { status: 'in-progress', card: { question: TEST_CARD.question } }, CTX)), refusal);
  });

  it('builds a new card from all its parts, each reading on its own', () => {
    assert.equal(
      error(set(TASK, { waits: OWNER_DECISION, card: { question: TEST_CARD.question } })),
      `a card needs --question, --options, --recommend and --default (--options for a decision): ${CARD_USAGE}`,
    );
    assert.match(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, options: [] } })), /^--options lists 0: a decision lists at least 2/);
    assert.match(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, recommend: 'T378 option 2' } })), /^--recommend says "T378 option 2": give at least 3 plain words/);
  });

  it('keeps the card a waiting task had, and changes one part alone', () => {
    const kept = set(ASKED, { waits: OWNER_DECISION, note: 'asked again' });
    assert.deepEqual(kept.ok ? kept.value.card : undefined, TEST_OWNER_CARD);
    const later = 'Pro, since the launch is late';
    const changed = set(ASKED, { waits: OWNER_DECISION, card: { recommend: later } });
    assert.deepEqual(changed.ok ? changed.value.card : undefined, { ...TEST_OWNER_CARD, recommend: later });
    const resumed = testTask({ status: 'in-progress', startedAt: TASK.startedAt, card: TEST_CARD });
    assert.match(error(set(resumed, { waits: OWNER_DECISION, card: { recommend: later } })), /^a card needs/, 'only a waiting task has a card to build on');
  });

  it('takes --why-ask only on an owner order waiting on the owner, and keeps it only while it does (T802)', () => {
    const whyAsk = 'the ordered tier cannot ship at that price';
    const ordered: Task = { ...TASK, source: 'owner' };
    const asked = set(ordered, { waits: OWNER_DECISION, card: { ...TEST_OWNER_CARD, whyAsk } });
    assert.deepEqual(asked.ok ? asked.value.card : undefined, { ...TEST_OWNER_CARD, whyAsk });
    const refusal = "--why-ask says why owner is asked about what owner ordered: it goes only with a wait on owner's decision or approval of a task from owner";
    assert.equal(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_CARD, whyAsk } })), refusal, 'a task the lead made');
    assert.equal(error(set(ordered, { waits: [{ kind: 'approval', who: 'lead' }], card: { ...TEST_CARD, options: [], whyAsk } })), refusal, "a wait on the lead's approval");
    const waiting: Task = { ...ordered, status: 'waiting', waits: OWNER_DECISION, card: { ...TEST_OWNER_CARD, whyAsk } };
    const again = set(waiting, { waits: OWNER_DECISION, note: 'asked again' });
    assert.deepEqual(again.ok ? again.value.card : undefined, { ...TEST_OWNER_CARD, whyAsk });
    const toLead = set(waiting, { waits: [{ kind: 'decision', who: 'lead' }] });
    assert.deepEqual(toLead.ok ? toLead.value.card : undefined, TEST_CARD, "a wait moved to the lead's decision drops it");
  });

  it("refuses an owner order waiting on the owner with no --why-ask while cards are required (T802)", () => {
    const ordered: Task = { ...TASK, source: 'owner' };
    const refusal = `owner ordered ${TASK.id}, and an order approves its own work and proof: drop the wait on owner's decision, or give --why-ask "<how the order must change, what new it needs, or why only owner can see the result>"`;
    assert.equal(error(set(ordered, { waits: OWNER_DECISION, card: TEST_OWNER_CARD })), refusal, 'a new card');
    assert.equal(error(set(ordered, { waits: OWNER_DECISION, card: TEST_CARD })), refusal, 'before its gate');
    assert.equal(error(set({ ...ordered, status: 'waiting', waits: OWNER_DECISION, card: TEST_OWNER_CARD }, { waits: OWNER_DECISION, note: 'asked again' })), refusal, 'a card kept from an older row');
    assert.equal(error(set(ordered, { waits: OWNER_DECISION })), `${refusal} with ${CARD_USAGE}`, 'no card');
    const lead: WaitReason[] = [{ kind: 'approval', who: 'lead' }];
    assert.equal(set(ordered, { waits: lead }).ok, true, "a wait on the lead's approval asks no owner");
    const relaxed = new RegisterPolicy(testConfig({ register: { requireDecisionCard: false } }));
    assert.equal(set(ordered, { waits: OWNER_DECISION }, relaxed).ok, true, 'requireDecisionCard off');
  });

  it('takes the same card again only with a new note', () => {
    const relaxed = new RegisterPolicy(testConfig({ register: { requireNoteOn: [] } }));
    const again = (card: Partial<DecisionCard>) => relaxed.setStatus(ASKED, 'alpha', { status: 'waiting', waits: OWNER_DECISION, card }, CTX);
    assert.match(error(again(TEST_CARD)), /already waiting/);
    assert.equal(again({ byDefault: 'Pro ships on the due date' }).ok, true, 'a new part is a change');
  });

  it('checks each part like any text', () => {
    assert.match(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_OWNER_CARD, question: credentialUrl() } })), /card looks like it holds a secret/);
    assert.match(error(set(TASK, { waits: OWNER_DECISION, card: { ...TEST_OWNER_CARD, byDefault: 'x '.repeat(200) } })), /^card has 400 characters/);
  });
});

describe("RegisterPolicy.setStatus: a time wait in the team's zone", () => {
  const policy = new RegisterPolicy(testConfig());
  const day: readonly WaitReason[] = [{ kind: 'time', at: '2030-01-08' }];
  const late: StatusContext = { ...CTX, state: foldEvents([]), now: new Date('2030-01-08T22:30:00.000Z') };
  const wait = (context: StatusContext) => policy.setStatus(TASK, 'alpha', { status: 'waiting', note: 'x', waits: day }, context);

  it('refuses a bare day that has ended there', () => {
    assert.equal(wait({ ...late, zone: TimeZone.UTC }).ok, true, 'UTC is at 01-08 22:30');
    assert.deepEqual(wait({ ...late, zone: JERUSALEM }), { ok: false, error: 'time 01-08 has passed: name a time to come' }, 'Jerusalem is at 01-09 00:30');
  });
});

describe('RegisterPolicy.setStatus: new work waits for its owner\'s verify steps that are due', () => {
  const overdue = testTask({ id: 'T1', status: 'verifying', proof: 'the nightly run', due: '2030-01-08', startedAt: '2030-01-07T10:00:00.000Z' });
  const fresh = testTask({ id: 'T2' });
  const context = { ...CTX, state: stateOf(overdue, fresh) };

  it('refuses a first start while one is due, and lets a task already started go on', () => {
    const policy = new RegisterPolicy(testConfig());
    assert.match(error(policy.setStatus(fresh, 'alpha', { status: 'in-progress' }, context)), /^T2 is new work; T1 \(verify by 01-08\) is due to verify first \(teamrig verify\): /);
    const started = testTask({ id: 'T3', startedAt: '2030-01-07T11:00:00.000Z' });
    assert.equal(error(policy.setStatus(started, 'alpha', { status: 'in-progress' }, { ...CTX, state: stateOf(overdue, fresh, started) })), 'allowed');
  });

  it('lets the first start through once the verify step is re-dated, and in warn mode', () => {
    const redated = { ...context, state: stateOf({ ...overdue, due: '2030-01-10' }, fresh) };
    assert.equal(error(new RegisterPolicy(testConfig()).setStatus(fresh, 'alpha', { status: 'in-progress' }, redated)), 'allowed');
    const warn = new RegisterPolicy(testConfig({ register: { verifyGate: 'warn' } }));
    assert.equal(error(warn.setStatus(fresh, 'alpha', { status: 'in-progress' }, context)), 'allowed');
  });
});

describe('RegisterPolicy.approve (T684)', () => {
  const policy = new RegisterPolicy(testConfig());
  const asking = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }] });

  it('lets the lead answer a task waiting on its approval, the note trimmed', () => {
    assert.deepEqual(policy.approve(asking, 'lead', 'approved', ' tests green '), { ok: true, value: { changes: {}, note: 'tests green', verdict: 'approved' } });
    assert.deepEqual(policy.approve(asking, 'lead', 'declined', 'no tests added'), { ok: true, value: { changes: {}, note: 'no tests added', verdict: 'declined' } });
  });

  it("refuses any other session, the task's owner too", () => {
    assert.match(error(policy.approve(asking, 'alpha', 'approved', 'mine')), /only the lead \(lead\) answers an approval/);
  });

  it("refuses a task that does not wait on the lead's approval: the owner's approval stays the owner's", () => {
    assert.match(error(policy.approve(TASK, 'lead', 'approved', 'ok')), /T1 does not wait on the lead's approval \(approval:lead\)/);
    const owners = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] });
    assert.match(error(policy.approve(owners, 'lead', 'approved', 'ok')), /does not wait on the lead's approval/);
  });

  it("lets a sub-lead above the owner answer its own approval wait, never another group's sub-lead nor its own task's (T781)", () => {
    const tree = new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], leads: { alpha: ['bravo'], charlie: ['delta'] } }));
    const bravos = (who: string) => testTask({ owner: 'bravo', status: 'waiting', waits: [{ kind: 'approval', who }] });
    assert.equal(tree.approve(bravos('alpha'), 'alpha', 'approved', 'ok').ok, true);
    assert.equal(tree.approve(bravos('lead'), 'lead', 'approved', 'ok').ok, true);
    assert.equal(error(tree.approve(bravos('alpha'), 'charlie', 'approved', 'ok')), "only a leader above bravo (alpha or lead) answers an approval of bravo's");
    assert.match(error(tree.approve(bravos('alpha'), 'lead', 'approved', 'ok')), /T1 does not wait on the lead's approval \(approval:lead\)/);
    assert.match(error(tree.approve(bravos('lead'), 'alpha', 'approved', 'ok')), /T1 does not wait on alpha's approval \(approval:alpha\)/);
    const alphas = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'alpha' }] });
    assert.equal(error(tree.approve(alphas, 'alpha', 'approved', 'ok')), "only the lead (lead) answers an approval of alpha's");
  });

  it("lets only the parent team's lead answer a child team's lead, and not a member's wait (T1140)", () => {
    const child = new RegisterPolicy(testConfig(), { team: 'app', id: 'boss' });
    const leads = testTask({ owner: 'lead', status: 'waiting', waits: [{ kind: 'approval', who: 'app/boss' }] });
    assert.deepEqual(child.approve(leads, 'app/boss', 'approved', 'ok'), { ok: true, value: { changes: {}, note: 'ok', verdict: 'approved' } });
    assert.equal(error(child.approve(leads, 'lead', 'approved', 'mine')), "only the parent team's lead (app/boss) answers an approval of lead's");
    assert.equal(error(child.approve(asking, 'app/boss', 'approved', 'ok')), "only the lead (lead) answers an approval of alpha's");
    assert.match(error(child.approve({ ...leads, waits: [{ kind: 'approval', who: 'owner' }] }, 'app/boss', 'approved', 'ok')), /T1 does not wait on app\/boss's approval \(approval:app\/boss\)/);
  });

  it('needs a note, checked like any other', () => {
    assert.match(error(policy.approve(asking, 'lead', 'approved', undefined)), /an answer needs --note/);
    assert.match(error(policy.approve(asking, 'lead', 'declined', '   ')), /an answer needs --note/);
    assert.notEqual(error(policy.approve(asking, 'lead', 'approved', credentialUrl())), 'allowed');
  });
});

describe('RegisterPolicy.defer: a Later (T1295)', () => {
  const policy = new RegisterPolicy(testConfig());
  const at = { now: NOW, zone: TimeZone.UTC };
  const asking = testTask({ status: 'waiting', waits: OWNER_DECISION });
  const tomorrow: WaitReason = { kind: 'time', at: '2030-01-09 09:00' };
  const putOff = testTask({ status: 'waiting', waits: [...OWNER_DECISION, { kind: 'time', at: '2030-01-08 22:00' }] });

  it('puts a card waiting on the owner off to a time to come, as a time wait beside it, the note trimmed', () => {
    assert.deepEqual(policy.defer(asking, 'alpha', '2030-01-09 09:00', ' after the demo ', at), { ok: true, value: { changes: {}, note: 'after the demo', waits: [...OWNER_DECISION, tomorrow] } });
    const proof = testTask({ status: 'verifying', waits: [{ kind: 'approval', who: 'owner' }] });
    assert.equal(error(policy.defer(proof, 'alpha', '2030-01-09 09:00', 'next week', at)), 'allowed', "a verifying task whose proof waits on the owner's approval");
  });

  it('replaces the time wait it had, and brings it back with none, keeping the other waits', () => {
    assert.deepEqual(policy.defer(putOff, 'alpha', '2030-01-09 09:00', 'later still', at), { ok: true, value: { changes: {}, note: 'later still', waits: [...OWNER_DECISION, tomorrow] } });
    assert.deepEqual(policy.defer(putOff, 'alpha', null, 'asks now', at), { ok: true, value: { changes: {}, note: 'asks now', waits: OWNER_DECISION } });
  });

  it('lets the owner of the task or a leader above it record one, no peer', () => {
    assert.equal(error(policy.defer(asking, 'lead', '2030-01-09 09:00', 'after the demo', at)), 'allowed');
    assert.equal(error(policy.defer(asking, 'bravo', '2030-01-09 09:00', 'after the demo', at)), 'only the owner (alpha) or the lead (lead) puts T1 off');
    const tree = new RegisterPolicy(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], leads: { alpha: ['bravo'], charlie: ['delta'] } }));
    const bravos = testTask({ owner: 'bravo', status: 'waiting', waits: OWNER_DECISION });
    assert.equal(error(tree.defer(bravos, 'alpha', '2030-01-09 09:00', 'n', at)), 'allowed', 'its sub-lead');
    assert.equal(error(tree.defer(bravos, 'charlie', '2030-01-09 09:00', 'n', at)), 'only the owner (bravo) or a leader above bravo (alpha or lead) puts T1 off');
  });

  it("refuses a task that waits on no decision or approval of the owner's", () => {
    const refusal = 'T1 waits on no decision or approval of owner: only such a card is put off';
    assert.equal(error(policy.defer(TASK, 'alpha', '2030-01-09 09:00', 'n', at)), refusal);
    const leads = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }, tomorrow] });
    assert.equal(error(policy.defer(leads, 'alpha', null, 'n', at)), refusal, "the lead's approval is no owner card");
  });

  it('needs a note, checked like any other, a time still to come, and a time to drop to bring one back', () => {
    assert.equal(error(policy.defer(asking, 'alpha', '2030-01-09 09:00', undefined, at)), 'a Later needs --note: what owner said');
    assert.equal(error(policy.defer(asking, 'alpha', '2030-01-09 09:00', '  ', at)), 'a Later needs --note: what owner said');
    assert.notEqual(error(policy.defer(asking, 'alpha', '2030-01-09 09:00', credentialUrl(), at)), 'allowed');
    assert.match(error(policy.defer(asking, 'alpha', '2030-01-08 11:00', 'n', at)), /^time .* has passed: name a time to come$/);
    assert.equal(error(policy.defer(asking, 'alpha', null, 'n', at)), 'T1 is not put off: no time to drop');
  });

  it('judges a bare day as its end in the team zone', () => {
    const late = { now: new Date('2030-01-08T22:30:00.000Z'), zone: JERUSALEM };
    assert.match(error(policy.defer(asking, 'alpha', '2030-01-08', 'n', late)), /has passed/, 'Jerusalem is at 01-09 00:30');
    assert.equal(error(policy.defer(asking, 'alpha', '2030-01-08', 'n', { ...late, zone: TimeZone.UTC })), 'allowed', 'UTC is at 01-08 22:30');
  });
});

describe("RegisterPolicy: the owner's Note and Next from the pane (T1298)", () => {
  const policy = new RegisterPolicy(testConfig());

  it('writes a Note as the owner on a task still to finish, changing no field, the text trimmed', () => {
    assert.deepEqual(policy.ownerNote(testTask(), ' after the demo '), { ok: true, value: { by: 'owner', changes: {}, note: 'after the demo' } });
    for (const status of ['in-progress', 'waiting', 'verifying'] as const) {
      assert.equal(error(policy.ownerNote(testTask({ status }), 'n')), 'allowed', status);
    }
  });

  it('refuses a Note on a finished task, one with no text, and text the scan refuses', () => {
    assert.equal(error(policy.ownerNote(testTask({ status: 'done' }), 'n')), "T1 is done: owner's Note goes to a task still to finish");
    assert.equal(error(policy.ownerNote(testTask({ status: 'dropped' }), 'n')), "T1 is dropped: owner's Note goes to a task still to finish");
    assert.equal(error(policy.ownerNote(testTask(), undefined)), 'a Note needs --text: what owner tells alpha');
    assert.equal(error(policy.ownerNote(testTask(), '  ')), 'a Note needs --text: what owner tells alpha');
    assert.notEqual(error(policy.ownerNote(testTask(), credentialUrl())), 'allowed');
  });

  it("pins a task as the owner's with Next, moving a leader's pin, on an open, waiting or verifying task", () => {
    assert.deepEqual(policy.ownerNext(testTask()), { ok: true, value: { by: 'owner', changes: { pin: 'owner' }, note: null } });
    assert.equal(error(policy.ownerNext(testTask({ pin: 'lead' }))), 'allowed', "a leader's pin");
    for (const status of ['waiting', 'verifying'] as const) {
      assert.equal(error(policy.ownerNext(testTask({ status }))), 'allowed', status);
    }
  });

  it('refuses Next on a finished task, one in hand already, and one the owner put next already', () => {
    assert.equal(error(policy.ownerNext(testTask({ status: 'done' }))), 'T1 is done: only a task still to finish goes next');
    assert.equal(error(policy.ownerNext(testTask({ status: 'dropped' }))), 'T1 is dropped: only a task still to finish goes next');
    assert.equal(error(policy.ownerNext(TASK)), 'T1 is in progress: alpha has it in hand already');
    assert.equal(error(policy.ownerNext(testTask({ pin: 'owner' }))), 'T1 is next already: owner put it there; a Note tells alpha more');
  });

  it("acts as the team's own ownerSource", () => {
    const named = new RegisterPolicy(testConfig({ register: { ownerSource: 'human' } }));
    assert.deepEqual(named.ownerNext(testTask()), { ok: true, value: { by: 'human', changes: { pin: 'human' }, note: null } });
    assert.equal(error(named.ownerNote(testTask(), undefined)), 'a Note needs --text: what human tells alpha');
  });
});
