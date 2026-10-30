import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import { planHire, type HirePlan, type HireRequest } from './plan.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

const FILE: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' }, hiring: { policy: 'lead' } };

const REQUEST: HireRequest = { id: 'helper', scope: 'port the importer', reason: 'release week', by: 'lead', now: NOW };

function plan(file: JsonRecord, request: Partial<HireRequest> = {}): ReturnType<typeof planHire> {
  const { config, issues } = parseConfig(file);
  assert.deepEqual(issues, [], 'the test file must be valid');
  return planHire(file, config, { ...REQUEST, ...request });
}

function planned(file: JsonRecord, request: Partial<HireRequest> = {}): HirePlan {
  const result = plan(file, request);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problem(file: JsonRecord, request: Partial<HireRequest> = {}): string {
  const result = plan(file, request);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.problem;
}

describe('planHire', () => {
  it("writes the session and its launch, with the lead's model and effort and the default review day, and no daily budget", () => {
    const result = planned({ ...FILE, launch: { lead: { model: 'opus', effort: 'high' } }, budget: { sessions: { alpha: { share: 2 } } } });
    assert.deepEqual(result.config, {
      ...FILE,
      launch: { lead: { model: 'opus', effort: 'high' }, helper: { model: 'opus', effort: 'high' } },
      budget: { sessions: { alpha: { share: 2 } } },
      sessions: ['lead', 'alpha', 'helper'],
    });
    assert.deepEqual(result.hire, { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', model: 'opus', effort: 'high', reviewBy: '2030-01-15', by: 'lead', at: NOW });
  });

  it('takes the name, model, effort, review day and approver it is given', () => {
    const result = planned(
      { ...FILE, names: { alpha: 'al' }, hiring: { policy: 'owner' } },
      { name: 'hand', model: 'claude-opus-5-5', effort: 'xhigh', reviewBy: '2030-01-09', approvedBy: ' owner ' },
    );
    assert.deepEqual(result.config['names'], { alpha: 'al', helper: 'hand' });
    assert.deepEqual(result.config['launch'], { helper: { model: 'claude-opus-5-5', effort: 'xhigh' } });
    assert.equal(result.config['budget'], undefined);
    assert.equal(result.hire.approvedBy, 'owner');
    assert.equal(result.hire.reviewBy, '2030-01-09');
  });

  it("leaves the model to Claude Code when the lead's is the default", () => {
    const result = planned({ ...FILE, launch: { lead: { model: 'default' } } });
    assert.deepEqual(result.config['launch'], { lead: { model: 'default' }, helper: { effort: 'xhigh' } });
    assert.equal(result.hire.model, undefined);
  });

  it("lets a sub-lead hire into its own group, on the lead's launch, and no one else but the lead (T509)", () => {
    const tree = { ...FILE, sessions: ['lead', 'alpha', 'bravo'], leads: { alpha: ['bravo'] }, launch: { lead: { model: 'opus', effort: 'high' }, alpha: { model: 'sonnet' } } };
    const result = planned(tree, { by: 'alpha' });
    assert.deepEqual(result.config['leads'], { alpha: ['bravo', 'helper'] });
    assert.deepEqual(result.config['sessions'], ['lead', 'alpha', 'bravo', 'helper']);
    assert.deepEqual(result.hire, { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', model: 'opus', effort: 'high', reviewBy: '2030-01-15', by: 'alpha', at: NOW });
    assert.equal(result.leader, 'alpha');
    assert.equal(planned(tree).leader, 'lead');
    assert.deepEqual(planned(tree).config['leads'], { alpha: ['bravo'] }, "the lead's hire joins no sub-lead's group");
    assert.equal(problem(tree, { by: 'bravo' }), 'only a lead hires sessions: the lead (lead), or a sub-lead into its own group');
    assert.match(problem({ ...tree, hiring: { policy: 'owner' } }, { by: 'alpha' }), /the owner approves each hire; ask lead, your leader, who takes it to the owner, then pass --approved-by/);
  });

  it('ties the hire to the burst it is for', () => {
    assert.equal(planned(FILE, { burst: NOW - 1000 }).hire.burst, NOW - 1000);
    assert.equal('burst' in planned(FILE).hire, false);
  });

  it('follows hiring.policy', () => {
    assert.match(problem({ ...FILE, hiring: { policy: 'off' } }), /hiring\.policy is off/);
    assert.match(problem({ ...FILE, hiring: { policy: 'owner' } }), /--approved-by/);
    assert.match(problem({ ...FILE, hiring: { policy: 'owner' } }, { approvedBy: ' ' }), /--approved-by/);
    assert.match(problem({ sessions: ['lead'], roles: { lead: 'lead' } }), /hiring\.policy is owner/);
    assert.match(problem({ ...FILE, hiring: { policy: 'owner' } }), /the owner approves each hire; ask the owner, then pass --approved-by/);
    const child = { ...FILE, team: { id: 'ui', parent: 'web' }, hiring: { policy: 'owner' } };
    assert.match(problem(child), /the owner approves each hire; ask the lead of team web, who takes it to the owner, then pass --approved-by/);
    assert.equal(planned({ ...FILE, hiring: { policy: 'automatic' } }).hire.session, 'helper');
  });

  it('refuses a hirer that leads no one, a missing job or reason, a bad or taken id, and a bad model', () => {
    assert.match(problem(FILE, { by: 'alpha' }), /^only a lead hires sessions/);
    assert.match(problem(FILE, { scope: ' ' }), /--scope/);
    assert.match(problem(FILE, { reason: '' }), /--reason/);
    assert.match(problem(FILE, { id: 'Helper' }), /not a session id/);
    assert.match(problem(FILE, { id: 'alpha' }), /already on the team/);
    assert.match(problem(FILE, { model: 'gpt' }), /--model gpt/);
  });

  it('hires past any count of sessions: no cap bounds hiring, the host room and the leader do', () => {
    const file = { ...FILE, sessions: ['lead', 'alpha', 'one', 'two', 'three'] };
    assert.deepEqual(planned(file).config['sessions'], ['lead', 'alpha', 'one', 'two', 'three', 'helper']);
  });

  it('refuses a review day that is not a date or has passed', () => {
    assert.match(problem(FILE, { reviewBy: 'next week' }), /not a YYYY-MM-DD date/);
    assert.match(problem(FILE, { reviewBy: '2030-01-07' }), /has passed/);
    assert.equal(planned(FILE, { reviewBy: '2030-01-08' }).hire.reviewBy, '2030-01-08');
  });
});
