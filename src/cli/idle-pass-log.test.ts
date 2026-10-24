import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PassStep } from './idle-pass.ts';
import {
  changedSteps,
  failedState,
  formatIdlePassRecord,
  formatIdlePassState,
  IDLE_PASS_EVERY_MS,
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
