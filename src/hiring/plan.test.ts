import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { HireRecord } from './log.ts';
import { planHire, type HirePlan, type HireRequest } from './plan.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

const FILE: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' }, hiring: { policy: 'lead' } };

const REQUEST: HireRequest = { id: 'helper', scope: 'port the importer', reason: 'release week', by: 'lead', now: NOW };

function hired(session: string, dailyPct = 1): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', dailyPct, reviewBy: '2030-01-15', by: 'lead', at: NOW - 1000 };
}

function plan(file: JsonRecord, request: Partial<HireRequest> = {}, active: readonly HireRecord[] = []): ReturnType<typeof planHire> {
  const { config, issues } = parseConfig(file);
  assert.deepEqual(issues, [], 'the test file must be valid');
  return planHire(file, config, active, { ...REQUEST, ...request });
}

function planned(file: JsonRecord, request: Partial<HireRequest> = {}, active: readonly HireRecord[] = []): HirePlan {
  const result = plan(file, request, active);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problem(file: JsonRecord, request: Partial<HireRequest> = {}, active: readonly HireRecord[] = []): string {
  const result = plan(file, request, active);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.problem;
}

describe('planHire', () => {
  it("writes the session, its launch and its daily budget, with the lead's model and effort and the default review day", () => {
    const result = planned({ ...FILE, launch: { lead: { model: 'opus', effort: 'high' } }, budget: { sessions: { alpha: { share: 2 } } } });
    assert.deepEqual(result.config, {
      ...FILE,
      launch: { lead: { model: 'opus', effort: 'high' }, helper: { model: 'opus', effort: 'high' } },
      budget: { sessions: { alpha: { share: 2 }, helper: { dailyPct: 1 } } },
      sessions: ['lead', 'alpha', 'helper'],
    });
    assert.deepEqual(result.hire, { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', model: 'opus', effort: 'high', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: NOW });
    assert.deepEqual([result.hired, result.hiredDailyPct], [1, 1]);
  });

  it('takes the name, model, effort, daily budget, review day and approver it is given', () => {
    const result = planned(
      { ...FILE, names: { alpha: 'al' }, hiring: { policy: 'owner' } },
      { name: 'hand', model: 'claude-opus-5-5', effort: 'xhigh', dailyPct: 0.5, reviewBy: '2030-01-09', approvedBy: ' owner ' },
    );
    assert.deepEqual(result.config['names'], { alpha: 'al', helper: 'hand' });
    assert.deepEqual(result.config['launch'], { helper: { model: 'claude-opus-5-5', effort: 'xhigh' } });
    assert.deepEqual(result.config['budget'], { sessions: { helper: { dailyPct: 0.5 } } });
    assert.equal(result.hire.approvedBy, 'owner');
    assert.equal(result.hire.reviewBy, '2030-01-09');
  });

  it("leaves the model to Claude Code when the lead's is the default", () => {
    const result = planned({ ...FILE, launch: { lead: { model: 'default' } } });
    assert.deepEqual(result.config['launch'], { lead: { model: 'default' }, helper: { effort: 'xhigh' } });
    assert.equal(result.hire.model, undefined);
  });

  it('follows hiring.policy', () => {
    assert.match(problem({ ...FILE, hiring: { policy: 'off' } }), /hiring\.policy is off/);
    assert.match(problem({ ...FILE, hiring: { policy: 'owner' } }), /--approved-by/);
    assert.match(problem({ ...FILE, hiring: { policy: 'owner' } }, { approvedBy: ' ' }), /--approved-by/);
    assert.match(problem({ sessions: ['lead'], roles: { lead: 'lead' } }), /hiring\.policy is owner/);
    assert.equal(planned({ ...FILE, hiring: { policy: 'automatic' } }).hire.session, 'helper');
  });

  it('refuses a missing job or reason, a bad or taken id, and a bad model', () => {
    assert.match(problem(FILE, { scope: ' ' }), /--scope/);
    assert.match(problem(FILE, { reason: '' }), /--reason/);
    assert.match(problem(FILE, { id: 'Helper' }), /not a session id/);
    assert.match(problem(FILE, { id: 'alpha' }), /already on the team/);
    assert.match(problem(FILE, { model: 'gpt' }), /--model gpt/);
  });

  it("stays within hiring.maxSessions, counting only hires still on the team", () => {
    const file = { ...FILE, sessions: ['lead', 'alpha', 'one', 'two'], hiring: { policy: 'lead', maxSessions: 2, maxDailyPct: 10 } };
    assert.match(problem(file, {}, [hired('one'), hired('two')]), /already has 2 hired session\(s\), the most hiring\.maxSessions allows/);
    assert.equal(planned(file, {}, [hired('one'), hired('gone')]).hired, 2);
  });

  it("stays within hiring.maxDailyPct, reading each hire's daily budget from the config", () => {
    const file = { ...FILE, sessions: ['lead', 'alpha', 'one'], hiring: { policy: 'lead', maxDailyPct: 2 }, budget: { sessions: { one: { dailyPct: 1.5 } } } };
    assert.match(problem(file, {}, [hired('one', 0.5)]), /add up to 2\.5% of the week, over hiring\.maxDailyPct 2%/);
    assert.equal(planned(file, { dailyPct: 0.5 }, [hired('one', 0.5)]).hiredDailyPct, 2);
    const tenths = { ...FILE, sessions: ['lead', 'alpha', 'one'], hiring: { policy: 'lead', dailyPct: 0.1, maxDailyPct: 0.3 } };
    assert.equal(planned(tenths, { dailyPct: 0.2 }, [hired('one', 0.1)]).hiredDailyPct, 0.3);
  });

  it('refuses a review day that is not a date or has passed', () => {
    assert.match(problem(FILE, { reviewBy: 'next week' }), /not a YYYY-MM-DD date/);
    assert.match(problem(FILE, { reviewBy: '2030-01-07' }), /has passed/);
    assert.equal(planned(FILE, { reviewBy: '2030-01-08' }).hire.reviewBy, '2030-01-08');
  });
});
