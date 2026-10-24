import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PassStep } from './idle-pass.ts';
import {
  changedSteps,
  failedState,
  formatIdlePassRecord,
  formatIdlePassState,
  formatIdlePassTrouble,
  IDLE_PASS_EVERY_MS,
  IDLE_PASS_STALE_MS,
  idlePassTrouble,
  isPassDue,
  parseIdlePassState,
  passedState,
} from './idle-pass-log.ts';

const AT = Date.parse('2030-01-08T10:00:00.000Z');
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

  it('reads a damaged file, another format or an unknown step kind as no pass yet', () => {
    for (const text of ['', '{', '{"v":2,"at":1,"kinds":{}}', '{"v":1,"at":"x","kinds":{}}', '{"v":1,"at":1,"kinds":{"alpha":"gone"}}', '{"v":1,"at":1,"kinds":{},"failed":7}']) {
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
    const reopen: PassStep = { kind: 'reopen', id: 'alpha', reopening: { kind: 'handed', tasks: [] } };
    assert.deepEqual(changedSteps(passedState(AT, STEPS), [KEEP_LEAD, reopen, { kind: 'away', id: 'bravo' }]), [reopen]);
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
});
