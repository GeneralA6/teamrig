import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/parse.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { HireRecord } from './record.ts';
import { planRetire, type RetirePlan, type RetireRequest } from './retire.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const HANDOVER = '/kit/teams/app/handover/helper.md';

const FILE: JsonRecord = {
  sessions: ['lead', 'alpha', 'helper'],
  roles: { lead: 'lead' },
  hiring: { policy: 'lead' },
  names: { alpha: 'al', helper: 'temp' },
  launch: { helper: { model: 'sonnet' } },
  budget: { weeklyLimitW: 5000000, sessions: { alpha: { share: 2 }, helper: { share: 1 } } },
};

const HIRE: HireRecord = { kind: 'hire', session: 'helper', scope: 'x', reason: 'y', reviewBy: '2030-01-15', by: 'lead', at: NOW - 1000 };

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

  it("keeps the lead tree whole: a member leaves its sub-lead's list, a sub-lead's members go to its leader (T781)", () => {
    const tree = { sessions: ['lead', 'alpha', 'bravo', 'helper'], roles: { lead: 'lead' } };
    assert.deepEqual(planned(FILE).regrouped, { members: [], to: 'lead' }, 'a session the tree does not name moves no one');
    const member = planned({ ...tree, leads: { alpha: ['helper'] } });
    assert.equal(Object.hasOwn(member.config, 'leads'), false, 'a list left empty goes, and leads with it');
    const subLead = planned({ ...tree, leads: { alpha: ['helper'], helper: ['bravo'] } });
    assert.deepEqual(subLead.config['leads'], { alpha: ['bravo'] });
    assert.deepEqual(subLead.regrouped, { members: ['bravo'], to: 'alpha' });
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
    assert.match(problem({ ...FILE, roles: { lead: 'lead', deliveryOwner: 'helper' } }), /holds roles\.deliveryOwner/);
    const github = { repos: ['acme/app'], owners: { octo: 'helper' } };
    assert.match(problem({ ...FILE, github }), /github\.owners names helper for octo/);
    assert.match(problem({ ...FILE, github: { repos: ['acme/app'], sessions: { 'acme/app': 'helper' } } }), /github\.sessions names helper for acme\/app/);
  });

  it('refuses a config with no sessions list to take it from', () => {
    const { config } = parseConfig(FILE);
    const result = planRetire({ roles: { lead: 'lead' } }, config, [HIRE], REQUEST);
    assert.deepEqual(result, { ok: false, problem: 'the config has no sessions list to take it from' });
  });

  it('lets only a lead over the session retire it, under every policy: a hired session never retires itself', () => {
    const refusal = /^only a lead over the session retires it \(the lead, or its sub-lead\): the leader decides which workers the team needs$/;
    for (const file of [FILE, { ...FILE, hiring: { policy: 'automatic' } }]) {
      assert.match(problem(file, { by: 'helper' }), refusal);
      assert.match(problem(file, { by: 'alpha' }), refusal);
    }
  });

  it('lets a sub-lead retire a session it leads, at any depth, handing its tasks only within its group (T509)', () => {
    const tree = { ...FILE, sessions: ['lead', 'alpha', 'bravo', 'helper', 'other'], leads: { alpha: ['bravo'], bravo: ['helper'] } };
    assert.equal(planned(tree, { by: 'bravo' }).retire.by, 'bravo');
    assert.equal(planned(tree, { by: 'alpha', openTasks: ['T1'], heir: 'bravo' }).retire.heir, 'bravo', 'a session two levels down, to one in the group');
    assert.deepEqual(planned(tree, { by: 'bravo', openTasks: ['T1'], heir: 'bravo' }).handOver, ['T1'], 'to the sub-lead itself');
    assert.match(problem(tree, { by: 'bravo', id: 'alpha' }), /^only a lead over the session retires it/, 'never its own leader');
    assert.match(problem(tree, { by: 'bravo', id: 'other' }), /^only a lead over the session retires it/, 'never a session outside its group');
    assert.match(problem(tree, { by: 'bravo', openTasks: ['T1'], heir: 'other' }), /^bravo hands work only within its group: the heir other is not led by bravo; the lead \(lead\) moves work between groups$/);
    assert.equal(planned(tree, { openTasks: ['T1'], heir: 'other' }).retire.heir, 'other', 'the lead hands work anywhere');
  });
});
