import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BURST } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Burst } from './burst.ts';
import { burstPromptLines, burstStopLines, burstText, surplusHintOf, type BurstFacts, type BurstMarks, type SurplusHint } from './burst-lines.ts';
import { weekWindow } from './pace.ts';
import type { BudgetSplit, TeamsOnAccount } from './parts.ts';

const HOUR = 3_600_000;
const RESET = Date.parse('2030-01-09T01:00:00Z');
const PACE_END = Date.parse('2030-01-09T00:00:00Z');
const NOW = Date.parse('2030-01-08T10:00:00Z');

const SURPLUS_BURST: Burst = {
  kind: 'surplus',
  sessions: ['alpha', 'bravo'],
  helpers: 3,
  hires: 0,
  dailyPct: 19.75,
  stopPct: 99.5,
  endsAt: PACE_END,
  tasks: [],
  reason: 'week-end surplus',
  by: 'lead',
  at: NOW,
};
const DEADLINE_BURST: Burst = {
  ...SURPLUS_BURST,
  kind: 'deadline',
  helpers: 1,
  hires: 1,
  stopPct: 80,
  endsAt: Date.parse('2030-01-08T20:00:00Z'),
  deadline: Date.parse('2030-01-08T20:00:00Z'),
  tasks: ['T1', 'T2'],
};
const HINT: SurplusHint = { sparePct: 34, accountSparePct: undefined, paceEnd: PACE_END, reset: RESET, ownerAsk: 'the owner' };

/** A team of `ids` at the default share, with no queued work or lift. */
function plainTeam(team: string, ids: readonly string[]): BudgetSplit {
  return { team, ids, sessions: {}, work: new Map(), leads: {}, lifted: new Map(), liftedGroups: new Map(), pausable: new Set(), funded: new Map() };
}

/** The team alone on its account, and beside a team of the same weight, which takes half the account's spare. */
const ALONE: TeamsOnAccount = { split: plainTeam('app', ['lead', 'alpha', 'bravo']), others: [] };
const SHARED: TeamsOnAccount = { ...ALONE, others: [plainTeam('web', ['lead', 'front', 'back'])] };
const NONE: BurstMarks = { burstAt: undefined, modelBurstAt: undefined, surplusShown: undefined };

function facts(extra: Partial<BurstFacts> = {}): BurstFacts {
  return { name: 'alpha', budgetPct: 2, burst: undefined, surplus: undefined, zone: TimeZone.UTC, ...extra };
}

describe('burstText', () => {
  it("names the kind, its tasks and deadline, its end, the floor it is given and the caps", () => {
    assert.equal(
      burstText(SURPLUS_BURST, ['alpha'], TimeZone.UTC, 6),
      "a surplus burst until Wed 01-09 00:00 UTC or 99.5% of the week: alpha's daily budget is at least 6.0%, up to 3 helpers at once.",
    );
    assert.equal(
      burstText(DEADLINE_BURST, ['alpha'], TimeZone.UTC, DEADLINE_BURST.dailyPct),
      "a deadline burst for T1, T2 (due Tue 01-08 20:00 UTC) until Tue 01-08 20:00 UTC or 80.0% of the week: alpha's daily budget is at least 19.8%, up to 1 helper at once, 1 hire for the team.",
    );
    const { deadline: _deadline, ...undated } = DEADLINE_BURST;
    assert.match(burstText({ ...undated, hires: 2 }, ['alpha'], TimeZone.UTC, 6), /^a deadline burst for T1, T2 until .*, 2 hires for the team\.$/);
  });

  it("prints its deadline and end on the team's clock", () => {
    assert.match(burstText(DEADLINE_BURST, ['alpha'], JERUSALEM, 6), /^a deadline burst for T1, T2 \(due Tue 01-08 22:00 IST\) until Tue 01-08 22:00 IST or 80\.0% of the week: /);
  });
});

describe('burstStopLines', () => {
  it("shows the person a burst's start once, with the session's budget now, and its end once", () => {
    const start = burstStopLines(facts({ burst: SURPLUS_BURST }), NONE);
    assert.deepEqual(start.lines, [`Budget: the lead started ${burstText(SURPLUS_BURST, ['alpha'], TimeZone.UTC, 2)} More: teamrig burst`]);
    assert.equal(start.burstAt, NOW);
    const again = burstStopLines(facts({ burst: SURPLUS_BURST }), { ...NONE, burstAt: NOW });
    assert.deepEqual(again, { lines: [], burstAt: NOW });
    const ended = burstStopLines(facts(), { ...NONE, burstAt: NOW });
    assert.deepEqual(ended, { lines: ["Budget: alpha's burst has ended; its daily budget is 2.0% again."], burstAt: undefined });
    assert.deepEqual(burstStopLines(facts(), NONE), { lines: [], burstAt: undefined });
  });

  it('shows a new burst that started while an older one was marked', () => {
    assert.equal(burstStopLines(facts({ burst: { ...SURPLUS_BURST, at: NOW + 1 } }), { ...NONE, burstAt: NOW }).lines.length, 1);
  });
});

describe('burstPromptLines', () => {
  it('tells the model how to work in the burst once: caps, independent tasks, worktrees, one merge at a time, same model and effort', () => {
    const start = burstPromptLines(facts({ burst: SURPLUS_BURST }), NONE);
    assert.deepEqual(start.lines, [
      'teamrig burst: a surplus burst runs until Wed 01-09 00:00 UTC or 99.5% of the week. ' +
        'Run up to 3 helpers at once, on independent tasks only; give each edit in a repo its own worktree, and merge one change at a time. ' +
        'Helpers run on your model and effort, never a cheaper model or lower effort, and never skip a test or check. More: teamrig burst',
    ]);
    assert.equal(start.modelBurstAt, NOW);
    assert.deepEqual(burstPromptLines(facts({ burst: SURPLUS_BURST }), { ...NONE, modelBurstAt: NOW }).lines, []);
  });

  it("puts a deadline burst's tasks first and names its hires", () => {
    const [line] = burstPromptLines(facts({ burst: DEADLINE_BURST }), NONE).lines;
    assert.match(line ?? '', /Work its tasks first: T1, T2\. Run up to 1 helper at once/);
    assert.match(line ?? '', /The lead may hire up to 1 session for it \(teamrig hire --burst\)\./);
  });

  it("tells the model the burst's end and the pace end on the team's clock", () => {
    assert.match(burstPromptLines(facts({ burst: SURPLUS_BURST, zone: JERUSALEM }), NONE).lines[0] ?? '', /^teamrig burst: a surplus burst runs until Wed 01-09 02:00 IST or 99\.5% of the week\. /);
    assert.match(burstPromptLines(facts({ surplus: HINT, zone: JERUSALEM }), NONE).lines[0] ?? '', /unused at the pace end \(Wed 01-09 02:00 IST\)\. /);
  });

  it('tells the model once that the burst ended: wind down, its hires are due to retire', () => {
    const ended = burstPromptLines(facts(), { ...NONE, modelBurstAt: NOW });
    assert.deepEqual(ended.lines, [
      "teamrig burst: the burst has ended. Finish the step in hand and start no new helpers; the burst's hires are due to retire (teamrig check lists them). More: teamrig burst",
    ]);
    assert.equal(ended.modelBurstAt, undefined);
  });

  it('suggests a surplus burst to the lead once a week, naming the approval it needs', () => {
    const first = burstPromptLines(facts({ surplus: HINT }), NONE);
    assert.deepEqual(first.lines, [
      'teamrig burst: about 34.0% of the week is projected unused at the pace end (Wed 01-09 00:00 UTC). ' +
        'A surplus burst can spend it on independent tasks; preview one: teamrig burst start surplus --reason "<why>". ' +
        'burst.policy is owner, so first ask the owner, then add --approved-by "<who>". More: teamrig burst',
    ]);
    assert.equal(first.surplusShown, RESET);
    assert.deepEqual(burstPromptLines(facts({ surplus: HINT }), { ...NONE, surplusShown: RESET }).lines, []);
    assert.equal(burstPromptLines(facts({ surplus: { ...HINT, reset: RESET + 7 * 24 * HOUR } }), { ...NONE, surplusShown: RESET }).lines.length, 1);
    const [byLead] = burstPromptLines(facts({ surplus: { ...HINT, ownerAsk: undefined } }), NONE).lines;
    assert.ok(byLead !== undefined && !byLead.includes('--approved-by'));
    const [child] = burstPromptLines(facts({ surplus: { ...HINT, ownerAsk: 'the lead of team app, who takes it to the owner' } }), NONE).lines;
    assert.ok(child?.includes(' so first ask the lead of team app, who takes it to the owner, then add --approved-by "<who>".'), child);
    assert.equal(burstPromptLines(facts({ surplus: HINT, burst: SURPLUS_BURST }), { ...NONE, modelBurstAt: NOW }).surplusShown, undefined);
  });

  it("names the account's spare beside the team's part when other teams share the account", () => {
    const [line] = burstPromptLines(facts({ surplus: { ...HINT, sparePct: 17, accountSparePct: 34 } }), NONE).lines;
    assert.match(line ?? '', /^teamrig burst: about 17\.0% of the week, this team's part of the account's 34\.0%, is projected unused at the pace end \(Wed 01-09 00:00 UTC\)\. /);
  });
});

describe('surplusHintOf', () => {
  const input = { config: DEFAULT_BURST, window: weekWindow(RESET, 1), now: NOW, usedPct: 60, targetPct: 99.5, teams: ALONE, ownerAsk: 'the owner' };

  it('reads a surplus worth a burst, and whom to ask when the owner approves it', () => {
    const hint = surplusHintOf(input);
    assert.ok(hint !== undefined);
    assert.equal(hint.reset, RESET);
    assert.equal(hint.paceEnd, PACE_END);
    assert.equal(hint.ownerAsk, 'the owner');
    assert.ok(hint.sparePct > 30);
    const byLead = surplusHintOf({ ...input, config: { ...DEFAULT_BURST, policy: 'lead' } });
    assert.ok(byLead !== undefined);
    assert.equal(byLead.ownerAsk, undefined);
  });

  it('is undefined with burst.policy off, an unknown week, too little spare or outside the window', () => {
    assert.equal(surplusHintOf({ ...input, config: { ...DEFAULT_BURST, policy: 'off' } }), undefined);
    assert.equal(surplusHintOf({ ...input, window: undefined }), undefined);
    assert.equal(surplusHintOf({ ...input, usedPct: 95 }), undefined);
    assert.equal(surplusHintOf({ ...input, now: RESET - 72 * HOUR }), undefined);
    assert.equal(surplusHintOf({ ...input, now: RESET - 7 * 24 * HOUR }), undefined);
  });

  it("reads the team's part of the account's spare, and none when that part is too little", () => {
    const shared = surplusHintOf({ ...input, teams: SHARED });
    const alone = surplusHintOf(input);
    assert.ok(shared !== undefined && alone !== undefined);
    assert.equal(alone.accountSparePct, undefined);
    assert.equal(shared.accountSparePct, alone.sparePct);
    assert.ok(Math.abs(shared.sparePct - alone.sparePct / 2) < 1e-9);
    assert.equal(surplusHintOf({ ...input, usedPct: 84, teams: SHARED }), undefined);
    assert.notEqual(surplusHintOf({ ...input, usedPct: 84 }), undefined);
  });
});
