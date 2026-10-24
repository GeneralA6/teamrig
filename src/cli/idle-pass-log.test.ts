import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import type { PassStep } from './idle-pass.ts';
import {
  actsToStart,
  changedSteps,
  failedState,
  formatIdlePassRecord,
  formatIdlePassState,
  formatIdlePassTrouble,
  heldActs,
  IDLE_ACT_HOLD_MS,
  IDLE_PASS_EVERY_MS,
  IDLE_PASS_STALE_MS,
  idlePassTrouble,
  isPassDue,
  parseIdlePassState,
  passedState,
} from './idle-pass-log.ts';

const AT = Date.parse('2030-01-08T10:00:00.000Z');
const APP = resolve('/', 'work', 'app');
const KEEP_LEAD: PassStep = { kind: 'keep', id: 'lead', why: 'app-lead (session lead) holds the lead role: teamrig never closes it' };
const STEPS: readonly PassStep[] = [KEEP_LEAD, { kind: 'closed', id: 'alpha' }, { kind: 'away', id: 'bravo' }];

describe('the idle pass state', () => {
  it('reads back what it wrote, a failing pass with its error', () => {
    const passed = passedState(AT, STEPS);
    assert.deepEqual(passed, { at: AT, kinds: { lead: 'keep', alpha: 'closed', bravo: 'away' } });
    assert.deepEqual(parseIdlePassState(formatIdlePassState(passed)), passed);
    const failed = failedState(passed, AT + IDLE_PASS_EVERY_MS, 'EACCES');
    assert.deepEqual(failed, { at: AT + IDLE_PASS_EVERY_MS, kinds: passed.kinds, failed: 'EACCES' });
    assert.deepEqual(parseIdlePassState(formatIdlePassState(failed)), failed);
    assert.deepEqual(failedState(undefined, AT, 'EACCES'), { at: AT, kinds: {}, failed: 'EACCES' });
  });

  it('reads back the pending acts, and writes none while nothing is pending', () => {
    const pending = { alpha: { act: 'close', at: AT }, bravo: { act: 'reopen', at: AT - 1 } } as const;
    const passed = passedState(AT, STEPS, pending);
    assert.deepEqual(passed, { at: AT, kinds: { lead: 'keep', alpha: 'closed', bravo: 'away' }, pending });
    assert.deepEqual(parseIdlePassState(formatIdlePassState(passed)), passed);
    assert.deepEqual(failedState(passed, AT + 1, 'EACCES').pending, pending, 'a failed pass lets none go');
    assert.equal(formatIdlePassState(passedState(AT, STEPS, {})).includes('pending'), false);
  });

  it('reads back the hookless reopens told of, keeps them through a failed pass, and writes none while none is hookless', () => {
    const told = { bravo: AT - 6 * 60_000 };
    const passed = passedState(AT, STEPS, {}, told);
    assert.deepEqual(passed, { at: AT, kinds: { lead: 'keep', alpha: 'closed', bravo: 'away' }, told });
    assert.deepEqual(parseIdlePassState(formatIdlePassState(passed)), passed);
    assert.deepEqual(failedState(passed, AT + 1, 'EACCES').told, told);
    assert.equal(formatIdlePassState(passedState(AT, STEPS, {}, {})).includes('told'), false);
    assert.deepEqual(parseIdlePassState('{"v":1,"at":1,"kinds":{}}'), { at: 1, kinds: {} }, 'a file from before the marks');
  });

  it('reads a damaged file, another format, an unknown step kind or a damaged pending act as no pass yet', () => {
    const damaged = [
      '',
      '{',
      '{"v":2,"at":1,"kinds":{}}',
      '{"v":1,"at":"x","kinds":{}}',
      '{"v":1,"at":1,"kinds":{"alpha":"gone"}}',
      '{"v":1,"at":1,"kinds":{},"failed":7}',
      '{"v":1,"at":1,"kinds":{},"pending":[]}',
      '{"v":1,"at":1,"kinds":{},"pending":{"alpha":{"act":"end","at":1}}}',
      '{"v":1,"at":1,"kinds":{},"pending":{"alpha":{"act":"close"}}}',
      '{"v":1,"at":1,"kinds":{},"told":[]}',
      '{"v":1,"at":1,"kinds":{},"told":{"bravo":"10:00"}}',
    ];
    for (const text of damaged) {
      assert.equal(parseIdlePassState(text), undefined, text);
    }
  });

  it('is due with no pass yet, a minute after the last, or when the clock went back', () => {
    const last = passedState(AT, STEPS);
    assert.equal(isPassDue(undefined, AT), true);
    assert.equal(isPassDue(last, AT + IDLE_PASS_EVERY_MS - 1), false);
    assert.equal(isPassDue(last, AT + IDLE_PASS_EVERY_MS), true);
    assert.equal(isPassDue(last, AT - 1), true);
  });

  it('names every step at the first pass, then only those whose kind changed', () => {
    assert.deepEqual(changedSteps(undefined, STEPS), STEPS);
    const reopen: PassStep = { kind: 'reopen', id: 'alpha', reopening: { kind: 'handed', tasks: [] }, project: APP };
    assert.deepEqual(changedSteps(passedState(AT, STEPS), [KEEP_LEAD, reopen, { kind: 'away', id: 'bravo' }]), [reopen]);
  });
});

describe('the idle pass acts', () => {
  const CLOSABLE = {
    record: { claudePid: 8100, claudeSession: 'c1', at: '2030-01-08T08:00:00.000Z' },
    claude: { pid: 8100, parentPid: 8000, name: 'claude.exe', commandLine: 'claude --resume c1' },
    heldMb: 1300,
    committedMb: undefined,
    idleMinutes: 75,
  };
  const BRAVO = resolve('/', 'work', 'bravo');
  const CLOSE_ALPHA: PassStep = { kind: 'close', id: 'alpha', closable: CLOSABLE, project: APP };
  const REOPEN_BRAVO: PassStep = { kind: 'reopen', id: 'bravo', reopening: { kind: 'handed', tasks: [] }, project: BRAVO };

  it('starts the close and the reopen the steps ask for in the folder each was read in, but none on a session with one pending', () => {
    assert.deepEqual(actsToStart([KEEP_LEAD, CLOSE_ALPHA, REOPEN_BRAVO], {}), [
      { act: 'close', id: 'alpha', project: APP },
      { act: 'reopen', id: 'bravo', project: BRAVO },
    ]);
    assert.deepEqual(actsToStart([KEEP_LEAD, CLOSE_ALPHA, REOPEN_BRAVO], { alpha: { act: 'close', at: AT } }), [{ act: 'reopen', id: 'bravo', project: BRAVO }]);
    const later: PassStep = { kind: 'later', id: 'bravo', reopening: { kind: 'handed', tasks: [] }, why: 'no room' };
    assert.deepEqual(actsToStart([KEEP_LEAD, later], {}), [], 'a kept or a later step starts nothing');
  });

  it('holds an act while its session still asks for it, under IDLE_ACT_HOLD_MS', () => {
    const pending = { alpha: { act: 'close', at: AT }, bravo: { act: 'reopen', at: AT } } as const;
    const later: PassStep = { kind: 'later', id: 'bravo', reopening: { kind: 'handed', tasks: [] }, why: 'no room' };
    assert.deepEqual(heldActs(pending, [KEEP_LEAD, CLOSE_ALPHA, REOPEN_BRAVO], AT + IDLE_ACT_HOLD_MS - 1), pending);
    assert.deepEqual(heldActs(pending, [KEEP_LEAD, CLOSE_ALPHA, later], AT), pending, 'a reopen held back still wants one');
  });

  it('lets an act go once done, kept, too old, from a clock gone back, or of a session gone from the roster', () => {
    const pending = { alpha: { act: 'close', at: AT }, bravo: { act: 'reopen', at: AT } } as const;
    assert.deepEqual(heldActs(pending, [{ kind: 'closed', id: 'alpha' }, { kind: 'keep', id: 'bravo', why: 'busy' }], AT), {}, 'done');
    assert.deepEqual(heldActs(pending, [{ kind: 'keep', id: 'alpha', why: 'busy' }, { kind: 'closed', id: 'bravo' }], AT), {}, 'kept');
    assert.deepEqual(heldActs(pending, [CLOSE_ALPHA, REOPEN_BRAVO], AT + IDLE_ACT_HOLD_MS), {}, 'too old');
    assert.deepEqual(heldActs(pending, [CLOSE_ALPHA, REOPEN_BRAVO], AT - 1), {}, 'the clock went back');
    assert.deepEqual(heldActs(pending, [KEEP_LEAD], AT), {}, 'gone from the roster');
    assert.deepEqual(heldActs(undefined, [CLOSE_ALPHA], AT), {});
  });
});

describe('idlePassTrouble', () => {
  it('finds none while the pass ran within IDLE_PASS_STALE_MS and went through, or the clock went back', () => {
    const last = passedState(AT, STEPS);
    assert.equal(idlePassTrouble(last, AT + IDLE_PASS_STALE_MS), undefined);
    assert.equal(idlePassTrouble(last, AT - IDLE_PASS_STALE_MS), undefined);
  });

  it('is stale with no pass yet or past IDLE_PASS_STALE_MS, a failure then included', () => {
    assert.deepEqual(idlePassTrouble(undefined, AT), { kind: 'stale', at: undefined });
    assert.deepEqual(idlePassTrouble(passedState(AT, STEPS), AT + IDLE_PASS_STALE_MS + 1), { kind: 'stale', at: AT });
    assert.deepEqual(idlePassTrouble(failedState(undefined, AT, 'EACCES'), AT + IDLE_PASS_STALE_MS + 1), { kind: 'stale', at: AT });
  });

  it('finds a fresh pass that failed, which its time alone misses', () => {
    assert.deepEqual(idlePassTrouble(failedState(passedState(AT, STEPS), AT + IDLE_PASS_EVERY_MS, 'EACCES'), AT + IDLE_PASS_EVERY_MS), {
      kind: 'failed',
      at: AT + IDLE_PASS_EVERY_MS,
      error: 'EACCES',
    });
  });

  it('says how long ago the pass ran or failed, and what to look at', () => {
    const later = AT + 16 * 60_000 + 59_000;
    assert.equal(
      formatIdlePassTrouble({ kind: 'stale', at: AT }, 'dry-run', later),
      "FLEET-STALE the idle pass (open.idle.mode dry-run) last ran 16 min ago: an idle tab's hook wake-check runs it once a minute, so check wake.enabled and that the tabs' teamrig hooks run",
    );
    assert.match(formatIdlePassTrouble({ kind: 'stale', at: undefined }, 'dry-run', later), /^FLEET-STALE the idle pass \(open\.idle\.mode dry-run\) has not run yet: /);
    assert.equal(
      formatIdlePassTrouble({ kind: 'failed', at: AT, error: 'EACCES: permission denied' }, 'dry-run', AT + 2 * 60_000),
      'FLEET-STALE the idle pass (open.idle.mode dry-run) failed at its last run, 2 min ago: EACCES: permission denied; state/idle-pass.jsonl logs each new failure',
    );
  });
});

describe('formatIdlePassRecord', () => {
  it('logs the changed steps with the commit charge where known, or the error', () => {
    const steps = [{ kind: 'closed' as const, id: 'alpha', line: 'CLOSED app-alpha (session alpha): nothing it can start' }];
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ kind: 'pass', at: AT, mode: 'dry-run', commit: { usedMb: 85_300, limitMb: 100_700 }, steps })), {
      v: 1,
      at: '2030-01-08T10:00:00.000Z',
      kind: 'pass',
      mode: 'dry-run',
      commit: { usedMb: 85_300, limitMb: 100_700 },
      steps,
    });
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ kind: 'pass', at: AT, mode: 'dry-run', commit: undefined, steps })), { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'pass', mode: 'dry-run', steps });
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ kind: 'failed', at: AT, mode: 'dry-run', error: 'EACCES' })), { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'failed', mode: 'dry-run', error: 'EACCES' });
  });

  it("logs an act with its outcome and line, and the commit charge before and after where known", () => {
    const act = { kind: 'act', at: AT, mode: 'dry-run', act: 'close', id: 'alpha', line: 'CLOSED app-alpha (session alpha): quiet 75 min' } as const;
    const before = { usedMb: 85_300, limitMb: 100_700 };
    const after = { usedMb: 84_000, limitMb: 100_700 };
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ ...act, outcome: 'done', before, after })), { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'act', mode: 'dry-run', act: 'close', id: 'alpha', outcome: 'done', line: act.line, before, after });
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ ...act, outcome: 'kept', before: undefined, after: undefined })), { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'act', mode: 'dry-run', act: 'close', id: 'alpha', outcome: 'kept', line: act.line });
  });

  it('logs a hookless reopen with its line, and why the line was not posted where it was not', () => {
    const hookless = { kind: 'hookless', at: AT, mode: 'on', id: 'bravo', line: 'HOOKLESS app-bravo (session bravo): reopened 01-08 09:54 UTC' } as const;
    const base = { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'hookless', mode: 'on', id: 'bravo', line: hookless.line };
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ ...hookless, problem: undefined })), base);
    assert.deepEqual(JSON.parse(formatIdlePassRecord({ ...hookless, problem: 'not posted: EACCES' })), { ...base, problem: 'not posted: EACCES' });
  });
});
