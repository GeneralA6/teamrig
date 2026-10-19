import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Burst } from '../budget/burst.ts';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import { burstHireOf } from './burst-hire.ts';
import type { HireRecord } from './log.ts';
import type { HireRequest } from './plan.ts';

const AT = Date.parse('2030-01-08T10:00:00Z');
const FILE: JsonRecord = { sessions: ['lead', 'alpha', 'helper'], roles: { lead: 'lead' }, launch: { lead: { model: 'opus', effort: 'high' } } };
const REQUEST: HireRequest = { id: 'second', scope: 'port the importer', reason: 'the burst', by: 'lead', now: AT };
const BURST: Burst = { kind: 'surplus', sessions: ['lead', 'alpha'], helpers: 3, hires: 1, dailyPct: 10, stopPct: 99.5, endsAt: AT + 86_400_000, tasks: [], reason: 'surplus', approvedBy: 'the owner', by: 'lead', at: AT };

function hired(session: string, burst?: number): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', reviewBy: '2030-01-15', by: 'lead', at: AT, ...(burst === undefined ? {} : { burst }) };
}

/** `burst` null checks a hire with no burst in force. */
function check(request: Partial<HireRequest> = {}, burst: Burst | null = BURST, active: readonly HireRecord[] = [], file: JsonRecord = FILE): ReturnType<typeof burstHireOf> {
  const { config, issues } = parseConfig(file);
  assert.deepEqual(issues, [], 'the test file must be valid');
  return burstHireOf({ ...REQUEST, ...request }, burst ?? undefined, active, config);
}

function problem(...args: Parameters<typeof check>): string {
  const result = check(...args);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.problem;
}

describe('burstHireOf', () => {
  it("ties the hire to the burst, approved by the burst's approver unless the line names one", () => {
    assert.deepEqual(check(), { ok: true, value: { ...REQUEST, approvedBy: 'the owner', burst: AT } });
    assert.deepEqual(check({ approvedBy: 'the CTO' }), { ok: true, value: { ...REQUEST, approvedBy: 'the CTO', burst: AT } });
    const { approvedBy: _approvedBy, ...byLead } = BURST;
    assert.deepEqual(check({}, byLead), { ok: true, value: { ...REQUEST, burst: AT } });
  });

  it('refuses with no burst in force, and past its hires, counting only its own hires still on the team', () => {
    assert.equal(problem({}, null), 'no burst is in force: hire --burst hires for one (teamrig burst)');
    assert.equal(problem({}, BURST, [hired('helper', AT)]), 'the burst allows 1 hire, and 1 is on the team');
    assert.equal(problem({}, { ...BURST, hires: 0 }), 'the burst allows 0 hires, and 0 are on the team');
    assert.equal(check({}, BURST, [hired('helper'), hired('helper', AT - 1), hired('gone', AT)]).ok, true);
  });

  it("keeps the lead's model and never lowers its effort", () => {
    assert.equal(problem({ model: 'haiku' }), "--model haiku: a burst hire runs on the lead's model (opus), never another");
    assert.equal(check({ model: 'opus' }).ok, true);
    assert.equal(problem({ effort: 'medium' }), "--effort medium is below the lead's high: a burst never lowers effort");
    assert.equal(check({ effort: 'max' }).ok, true);
    const plain: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' }, launch: { lead: { model: 'default' } } };
    assert.equal(check({ model: 'default', effort: 'xhigh' }, BURST, [], plain).ok, true);
    assert.equal(problem({ model: 'opus' }, BURST, [], plain), "--model opus: a burst hire runs on the lead's model (default), never another");
  });
});
