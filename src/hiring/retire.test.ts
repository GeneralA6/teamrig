import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { HireRecord } from './log.ts';
import { planRetire, type RetirePlan, type RetireRequest } from './retire.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const HANDOVER = '/kit/teams/app/handover/helper.md';

const FILE: JsonRecord = {
  sessions: ['lead', 'alpha', 'helper'],
  roles: { lead: 'lead' },
  hiring: { policy: 'lead' },
  names: { alpha: 'al', helper: 'temp' },
  launch: { helper: { model: 'sonnet' } },
  budget: { weeklyLimitW: 5000000, sessions: { alpha: { share: 2 }, helper: { dailyPct: 1 } } },
};

const HIRE: HireRecord = { kind: 'hire', session: 'helper', scope: 'x', reason: 'y', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: NOW - 1000 };

const REQUEST: RetireRequest = { id: 'helper', openTasks: [], handoverPath: HANDOVER, hasHandover: true, by: 'lead', now: NOW };

function plan(file: JsonRecord, request: Partial<RetireRequest> = {}, active: readonly HireRecord[] = [HIRE]): ReturnType<typeof planRetire> {
  const { config, issues } = parseConfig(file);
  assert.deepEqual(issues, [], 'the test file must be valid');
  return planRetire(file, config, active, { ...REQUEST, ...request });
}

function planned(file: JsonRecord, request: Partial<RetireRequest> = {}, active: readonly HireRecord[] = [HIRE]): RetirePlan {
  const result = plan(file, request, active);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problem(file: JsonRecord, request: Partial<RetireRequest> = {}, active: readonly HireRecord[] = [HIRE]): string {
  const result = plan(file, request, active);
  assert.ok(!result.ok, 'expected a refusal');
  return result.problem;
}

describe('planRetire', () => {
  it("takes the session out of sessions, names, launch and budget.sessions, keeping everything else", () => {
    const result = planned(FILE);
    assert.deepEqual(result.config, {
      sessions: ['lead', 'alpha'],
      roles: { lead: 'lead' },
      hiring: { policy: 'lead' },
      names: { alpha: 'al' },
      launch: {},
      budget: { weeklyLimitW: 5000000, sessions: { alpha: { share: 2 } } },
    });
    assert.deepEqual(result.retire, { kind: 'retire', session: 'helper', reason: 'its job is done', handover: HANDOVER, by: 'lead', at: NOW });
    assert.deepEqual(result.handOver, []);
    assert.equal(result.hired, true);
  });

  it('leaves out sections the file does not have, and retires a session the team was set up with', () => {
    const bare = { sessions: ['lead', 'alpha', 'helper'], roles: { lead: 'lead' } };
    const result = planned(bare, {}, []);
    assert.deepEqual(result.config, { sessions: ['lead', 'alpha'], roles: { lead: 'lead' } });
    assert.equal(result.hired, false);
    assert.deepEqual(planned({ ...bare, budget: { weeklyLimitW: 5000000 } }, {}, []).config['budget'], { weeklyLimitW: 5000000 });
  });

  it('hands its open tasks to the heir, and records the heir, the reason and why there is no handover', () => {
    const result = planned(FILE, { openTasks: ['T1', 'T2'], heir: 'alpha', hasHandover: false, noHandover: ' nothing to hand over ' });
    assert.deepEqual(result.handOver, ['T1', 'T2']);
    assert.deepEqual(result.retire, { kind: 'retire', session: 'helper', reason: 'its job is done', noHandover: 'nothing to hand over', heir: 'alpha', by: 'lead', at: NOW });
    assert.equal(planned(FILE, { heir: 'alpha', reason: ' the job moved ' }).retire.reason, 'the job moved');
    assert.equal(planned(FILE, { heir: 'alpha', reason: ' ' }).retire.reason, 'its job is done');
    assert.deepEqual(planned(FILE, { heir: 'alpha' }).handOver, []);
  });

  it('refuses open tasks without an heir, and an heir that is itself or off the team', () => {
    assert.match(problem(FILE, { openTasks: ['T1'] }), /owns open task\(s\) T1: pass --to <heir>/);
    assert.match(problem(FILE, { openTasks: ['T1'], heir: 'helper' }), /cannot be its own heir/);
    assert.match(problem(FILE, { openTasks: ['T1'], heir: 'ghost' }), /the heir ghost is not on the team/);
  });

  it('refuses without a handover unless --no-handover says why', () => {
    assert.match(problem(FILE, { hasHandover: false }), /no handover at .*helper\.md: write it .* or pass --no-handover/);
    assert.match(problem(FILE, { hasHandover: false, noHandover: ' ' }), /--no-handover needs why/);
  });

  it('refuses a session off the team, or one a role or github still names', () => {
    assert.match(problem(FILE, { id: 'ghost' }), /ghost is not on the team/);
    assert.match(problem(FILE, { id: 'lead' }), /lead holds roles\.lead/);
    assert.match(problem({ ...FILE, roles: { lead: 'lead', coordinatorOwner: 'helper' } }), /holds roles\.coordinatorOwner/);
    const github = { repos: ['acme/app'], owners: { octo: 'helper' } };
    assert.match(problem({ ...FILE, github }), /github\.owners names helper for octo/);
    assert.match(problem({ ...FILE, github: { repos: ['acme/app'], sessions: { 'acme/app': 'helper' } } }), /github\.sessions names helper for acme\/app/);
  });

  it('refuses a config with no sessions list to take it from', () => {
    const { config } = parseConfig(FILE);
    const result = planRetire({ roles: { lead: 'lead' } }, config, [HIRE], REQUEST);
    assert.deepEqual(result, { ok: false, problem: 'the config has no sessions list to take it from' });
  });

  it('lets a hired session retire itself only under hiring.policy automatic, once its tasks are closed', () => {
    const automatic = { ...FILE, hiring: { policy: 'automatic' } };
    assert.equal(planned(automatic, { by: 'helper' }).retire.by, 'helper');
    assert.match(problem(FILE, { by: 'helper' }), /only the lead retires helper: a session retires itself only when hired, under hiring\.policy automatic/);
    assert.match(problem(automatic, { by: 'helper' }, []), /only the lead retires helper/);
    assert.match(problem(automatic, { by: 'helper', openTasks: ['T1'] }), /still owns open task\(s\) T1: close them first/);
    assert.match(problem(automatic, { by: 'helper', heir: 'alpha' }), /ask the lead to retire it with --to/);
    assert.match(problem(automatic, { by: 'alpha' }), /^only the lead retires sessions/);
  });
});
