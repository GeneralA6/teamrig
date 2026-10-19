import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { planBudgetSetup, SETUP_KEYS, type BudgetChoices, type BudgetSetupPlan } from './setup.ts';

const TEAM: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' } };

function planned(config: JsonRecord, choices: BudgetChoices): BudgetSetupPlan {
  const plan = planBudgetSetup(config, choices);
  assert.ok(plan.ok, plan.ok ? '' : plan.problem);
  return plan.value;
}

function budgetOf(plan: BudgetSetupPlan): unknown {
  return plan.config['budget'];
}

function changedKeys(plan: BudgetSetupPlan): string[] {
  return plan.keys.filter((key) => key.changed).map((key) => key.key);
}

describe('planBudgetSetup', () => {
  it('turns the budget on with the chosen policy, keeping the rest of the file', () => {
    const plan = planned(TEAM, {
      enabled: true,
      overAction: 'ask-lead',
      escalate: 'session-and-fleet',
      quiet: { startUtc: '22:00', endUtc: '06:00' },
      quietAction: 'ask',
    });
    assert.deepEqual(budgetOf(plan), {
      enabled: true,
      overAction: 'ask-lead',
      escalate: 'session-and-fleet',
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
    });
    assert.deepEqual(plan.config['sessions'], TEAM['sessions']);
    assert.deepEqual(changedKeys(plan), ['enabled', 'overAction', 'escalate', 'quietHours']);
  });

  it('lists every policy key once, in order, with what it was and becomes', () => {
    const plan = planned({ ...TEAM, budget: { overAction: 'warn' } }, { enabled: true, overAction: 'ask' });
    assert.deepEqual(
      plan.keys.map((key) => key.key),
      [...SETUP_KEYS],
    );
    assert.deepEqual(
      plan.keys.find((key) => key.key === 'overAction'),
      { key: 'overAction', from: 'warn', to: 'ask', changed: true },
    );
    assert.deepEqual(
      plan.keys.find((key) => key.key === 'escalate'),
      { key: 'escalate', from: undefined, to: undefined, changed: false },
    );
  });

  it('keeps every key a choice leaves out, including other budget keys', () => {
    const budget = { enabled: true, weeklyLimitW: 5_000_000, targetPct: 99, sessions: { alpha: { share: 2 } }, quietHours: { startUtc: '23:00', endUtc: '07:00', action: 'warn' } };
    const plan = planned({ ...TEAM, budget }, { enabled: true });
    assert.deepEqual(budgetOf(plan), budget);
    assert.deepEqual(changedKeys(plan), []);
  });

  it('turns the budget off, keeping its policy for later', () => {
    const plan = planned({ ...TEAM, budget: { enabled: true, overAction: 'ask' } }, { enabled: false });
    assert.deepEqual(budgetOf(plan), { enabled: false, overAction: 'ask' });
  });

  it('changes only the quiet hours window, or only its action, of quiet hours already set', () => {
    const set = { ...TEAM, budget: { quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } } };
    assert.deepEqual(budgetOf(planned(set, { enabled: true, quiet: { startUtc: '21:00', endUtc: '05:00' } })), {
      quietHours: { startUtc: '21:00', endUtc: '05:00', action: 'ask' },
      enabled: true,
    });
    assert.deepEqual(budgetOf(planned(set, { enabled: true, quietAction: 'block' })), {
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'block' },
      enabled: true,
    });
  });

  it('removes the quiet hours with off', () => {
    const set = { ...TEAM, budget: { quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } } };
    assert.deepEqual(budgetOf(planned(set, { enabled: true, quiet: 'off' })), { enabled: true });
  });

  it('refuses new quiet hours without both a window and an action, and an action with off', () => {
    const cases: readonly [BudgetChoices, RegExp][] = [
      [{ enabled: true, quiet: { startUtc: '22:00', endUtc: '06:00' } }, /--quiet needs --quiet-action/],
      [{ enabled: true, quietAction: 'ask' }, /--quiet-action needs --quiet <HH:MM-HH:MM>/],
      [{ enabled: true, quiet: 'off', quietAction: 'ask' }, /not --quiet off/],
    ];
    for (const [choices, problem] of cases) {
      const plan = planBudgetSetup(TEAM, choices);
      assert.equal(plan.ok, false);
      assert.match(plan.ok ? '' : plan.problem, problem);
    }
  });

  it('replaces a budget block that is not an object', () => {
    assert.deepEqual(budgetOf(planned({ ...TEAM, budget: 'on' }, { enabled: true })), { enabled: true });
  });
});
