import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS } from '../config/limits.ts';
import { testConfig } from '../testing/config.ts';
import {
  CONTEXT_MAX_CHARS,
  CORE_PACK_MAX_CHARS,
  renderCorePack,
  renderSessionContext,
  TEAM_RULES_MAX_CHARS,
  type TeamRules,
} from './pack.ts';

const COMMAND = 'teamrig';
const longest = (letter: string, length: number) => letter.repeat(length);
const filled = (limit: { readonly maxItems: number; readonly maxLength: number }, letter: string) =>
  Array.from({ length: limit.maxItems }, () => longest(letter, limit.maxLength));

/** Every printed value at its longest: names, lists, numbers and the optional rules all on. */
function worstCaseConfig() {
  const lead = longest('l', 32);
  const coordinator = longest('c', 32);
  return testConfig({
    sessions: [lead, coordinator],
    roles: { lead, coordinatorOwner: coordinator },
    ownerGates: filled(CONFIG_LIMITS.ownerGates, 'g'),
    messages: { maxLines: CONFIG_LIMITS.maxLines.max },
    register: {
      requireNoteOn: Array.from({ length: CONFIG_LIMITS.requireNoteOn.maxItems }, () => 'in-progress'),
      requireEvidenceOnDone: true,
      requireSkillOnDone: true,
    },
    skills: {
      sharedPrefix: longest('s', 32),
      maxDescriptionWords: CONFIG_LIMITS.maxDescriptionWords.max,
      maxPerArea: CONFIG_LIMITS.maxPerArea.max,
      maxVerifiedAgeDays: CONFIG_LIMITS.maxVerifiedAgeDays.max,
      forbidFrontmatter: filled(CONFIG_LIMITS.forbidFrontmatter, 'k'),
    },
    pushGuard: { protectedBranches: filled(CONFIG_LIMITS.protectedBranches, 'b') },
    coordinator: {
      schedule: { heavyCutoffUtc: '22:30' },
      // Both round to their longest two-decimal form.
      budget: { enabled: true, targetPct: 99.98765432109876, reservePct: 49.98765432109876 },
    },
    alerts: { persistentFailureHours: CONFIG_LIMITS.persistentFailureHours.max },
  });
}

describe('renderCorePack', () => {
  it('fits its budget with every printed value at its worst case', () => {
    const pack = renderCorePack(worstCaseConfig(), COMMAND);
    assert.ok(pack.length <= CORE_PACK_MAX_CHARS, `${pack.length} > ${CORE_PACK_MAX_CHARS}`);
  });

  it('fills values from the config and names their keys', () => {
    const pack = renderCorePack(testConfig({ messages: { maxLines: 7 }, ownerGates: ['money', 'deletes'] }), COMMAND);
    assert.match(pack, /^1\. Roles, by session id \(`teamrig who` gives the name to message each by\): lead is the lead/m);
    assert.match(pack, /At most 7 lines \[messages\.maxLines\]/);
    assert.match(pack, /never for owner-gated decisions: money; deletes \[ownerGates\]/);
    assert.match(pack, /with a note on blocked, done, dropped \[register\.requireNoteOn\]/);
    assert.match(pack, /`teamrig inbox read --session <you>`/);
    assert.doesNotMatch(pack, /coordinatorOwner|heavyCutoffUtc|coordinator\.budget/);
  });

  it('adds the coordinator owner, heavy cutoff and budget pacing only when configured', () => {
    const pack = renderCorePack(
      testConfig({
        roles: { lead: 'lead', coordinatorOwner: 'bravo' },
        coordinator: { schedule: { heavyCutoffUtc: '22:30' }, budget: { enabled: true } },
      }),
      COMMAND,
    );
    assert.match(pack, /bravo owns deploy coordination and fleet health \[roles\.coordinatorOwner\]/);
    assert.match(pack, /starts after 22:30 UTC/);
    assert.match(pack, /Pace the week to 99\.5% of the weekly limit and keep 0\.5% for incidents/);
  });

  it('prints budget percentages with at most two decimals', () => {
    const pack = renderCorePack(
      testConfig({ coordinator: { budget: { enabled: true, targetPct: 1.0000000000000002, reservePct: 1e-7 } } }),
      COMMAND,
    );
    assert.match(pack, /Pace the week to 1% of the weekly limit and keep 0% for incidents/);
  });

  it('drops status demands the team turned off', () => {
    const pack = renderCorePack(
      testConfig({ register: { requireNoteOn: [], requireEvidenceOnDone: false, requireSkillOnDone: false } }),
      COMMAND,
    );
    assert.match(pack, /only the owning session sets its status \(`teamrig set`\)\.$/m);
  });
});

describe('renderSessionContext', () => {
  const core = renderCorePack(testConfig(), COMMAND);
  const context = (team?: TeamRules) => renderSessionContext(core, team, COMMAND);

  it('is the core pack alone without team rules', () => {
    assert.equal(context(), core);
    assert.equal(context({ path: 'rules.md', text: ' \n' }), core);
  });

  it("appends the team's rules when they fit", () => {
    assert.equal(context({ path: 'rules.md', text: '- Ship on Fridays.\n' }), `${core}\n\n# Your team's rules\n- Ship on Fridays.`);
  });

  it('points to rules that are too long, and stays inside the context cap', () => {
    const text = 'x'.repeat(TEAM_RULES_MAX_CHARS + 1);
    assert.equal(
      context({ path: 'home/rules.md', text }),
      `${core}\n\nYour team's rules are in home/rules.md (${text.length} characters, more than the ${TEAM_RULES_MAX_CHARS} shown here): read them now.`,
    );
    const capped = context({ path: `/${'p'.repeat(CONTEXT_MAX_CHARS)}`, text });
    assert.ok(capped.length <= CONTEXT_MAX_CHARS);
    assert.match(capped, /run `teamrig doctor`/);
  });
});
