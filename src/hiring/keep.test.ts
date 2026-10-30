import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import { planKeep, type KeepPlan, type KeepRequest } from './keep.ts';
import type { HireRecord } from './record.ts';

const NOW = Date.parse('2030-01-16T10:00:00Z');

const FILE: JsonRecord = { sessions: ['lead', 'alpha', 'bravo', 'helper'], roles: { lead: 'lead' }, leads: { alpha: ['bravo', 'helper'] }, hiring: { policy: 'off' } };

const HIRE: HireRecord = { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'alpha', at: NOW - 8 * 86_400_000 };

const REQUEST: KeepRequest = { id: 'helper', reviewBy: '2030-02-01', reason: ' the importer grew ', by: 'lead', now: NOW };

function plan(request: Partial<KeepRequest> = {}, active: readonly HireRecord[] = [HIRE]): ReturnType<typeof planKeep> {
  const { config, issues } = parseConfig(FILE);
  assert.deepEqual(issues, [], 'the test file must be valid');
  return planKeep(config, active, { ...REQUEST, ...request });
}

function planned(request: Partial<KeepRequest> = {}): KeepPlan {
  const result = plan(request);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problem(request: Partial<KeepRequest> = {}, active: readonly HireRecord[] = [HIRE]): string {
  const result = plan(request, active);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.problem;
}

describe('planKeep', () => {
  it('logs the new review day and why, beside the hire it keeps, even under hiring.policy off', () => {
    assert.deepEqual(planned(), {
      keep: { kind: 'keep', session: 'helper', reviewBy: '2030-02-01', reason: 'the importer grew', by: 'lead', at: NOW },
      hire: HIRE,
    });
  });

  it('is for a lead over the session: the lead, or its sub-lead, never another session', () => {
    assert.equal(planned({ by: 'alpha' }).keep.by, 'alpha');
    const refused = 'only a lead over the session keeps it (the lead, or its sub-lead): the leader decides which workers the team needs';
    assert.equal(problem({ by: 'bravo' }), refused);
    assert.equal(problem({ by: 'helper' }), refused, 'a hire never keeps itself');
  });

  it('refuses a session the team was set up with: it has no review day', () => {
    assert.equal(problem({ id: 'bravo' }), 'bravo is set up with the team, not hired: it has no review day to keep');
    assert.equal(problem({}, []), 'helper is set up with the team, not hired: it has no review day to keep');
  });

  it('refuses a keep with no reason, and a review day that is not a date or has passed', () => {
    assert.match(problem({ reason: ' ' }), /--reason/);
    assert.match(problem({ reviewBy: 'next month' }), /not a YYYY-MM-DD date/);
    assert.match(problem({ reviewBy: '2030-01-15' }), /has passed/);
    assert.equal(planned({ reviewBy: '2030-01-16' }).keep.reviewBy, '2030-01-16');
  });
});
