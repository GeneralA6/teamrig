import { basename, dirname, join } from 'node:path';
import type { Roster } from '../../config/roster.ts';
import type { BudgetConfig, KitConfig } from '../../config/types.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { formatUtcDay } from '../../core/time.ts';
import { activeBurst, withBurst } from '../../budget/burst.ts';
import { surplusHintOf } from '../../budget/burst-lines.ts';
import { BurstLog } from '../../budget/burst-log.ts';
import type { TranscriptFolders } from '../../budget/discover.ts';
import { activeLift, LiftLog } from '../../budget/lift.ts';
import { OUTSIDE_ID } from '../../budget/measure.ts';
import { runMeter } from '../../budget/meter.ts';
import { sessionBudgetPct } from '../../budget/pace.ts';
import { readSnapshots, weekUseOf } from '../../budget/snapshot.ts';
import { UsageStore, type UsageState } from '../../budget/store.ts';
import { helperGate, promptWarning, stopWarning, type BudgetFacts } from '../../budget/warn.ts';
import { WarnStore } from '../../budget/warn-store.ts';
import { readWeek } from '../../budget/week.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { snapshotDirOf } from './budget.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * The budget's part of the hooks: a session's use today against its daily budget and the team's pace,
 * read cheaply at a hook. Only the hook's own tab is metered (its transcript and its subagents', at
 * most `budget.maxBytesPerHook` bytes); every other session's use is read as last stored. Nothing here
 * runs with the budget off or before the week's use is known.
 */

/** The team session a hook runs for. */
export interface BudgetScope {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly id: string;
}

const TRANSCRIPT = '.jsonl';

/** A tab's subagent transcripts, `<project>/<claude session>/subagents/*.jsonl`, by name so each run reads them in the same order. */
async function subagentsOf(folders: TranscriptFolders, transcript: string): Promise<string[]> {
  const dir = join(dirname(transcript), basename(transcript, TRANSCRIPT), 'subagents');
  const entries = await folders.entries(dir);
  return entries
    .filter((entry) => !entry.folder && entry.name.endsWith(TRANSCRIPT))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** One meter run over the tab's own transcripts; a run that lost a save race is left for the next hook. */
async function meterTab(runtime: CliRuntime, store: UsageStore, id: string, transcript: string, budget: BudgetConfig): Promise<void> {
  const transcripts = { main: [transcript], subagents: await subagentsOf(runtime.transcripts, transcript) };
  await runMeter(
    { bytes: runtime.transcripts, store, clock: runtime.clock },
    { session: id, transcripts, subagentWeight: budget.subagentWeight, maxBytes: budget.maxBytesPerHook },
  );
}

/**
 * The session's budget now, after metering the tab whose transcript is given; undefined with the
 * budget off, before the week's use or W per % is known, or without a daily budget for the session.
 * A lift sets the daily budget; a burst the session is in raises it to at least the burst's. The lead,
 * with no burst in force, also gets the week's surplus when it is worth one.
 */
export async function budgetFactsOf(runtime: CliRuntime, scope: BudgetScope, transcript: string | undefined): Promise<BudgetFacts | undefined> {
  const { kit, config, roster, id } = scope;
  const { budget } = config;
  if (!budget.enabled) {
    return undefined;
  }
  const { files } = runtime;
  const team = new UsageStore(files, kit.paths.usage);
  if (transcript !== undefined) {
    await meterTab(runtime, team, id, transcript, budget);
  }
  const now = runtime.clock.now();
  const byId = new Map<string, UsageState>();
  for (const each of roster.ids) {
    byId.set(each, (await team.load(each)).state);
  }
  const outside = (await new UsageStore(files, join(kit.paths.usage, 'outside')).load(OUTSIDE_ID)).state;
  const snapshots = await readSnapshots(files, snapshotDirOf(budget, kit.paths));
  const week = readWeek({ budget, now, statusUse: weekUseOf(snapshots, now), states: [...byId.values(), outside] });
  if (week.usedPct === undefined || week.wPerPct === undefined) {
    return undefined;
  }
  const lift = activeLift((await new LiftLog(files, kit.paths.lifts).read()).lifts, id, now, week.usedPct);
  const shared = week.allowancePct === undefined ? budget.sessions[id]?.dailyPct : sessionBudgetPct(week.allowancePct, id, roster.ids, budget.sessions);
  const inForce = activeBurst((await new BurstLog(files, kit.paths.bursts).read()).records, now, week.usedPct);
  const burst = inForce !== undefined && inForce.sessions.includes(id) ? inForce : undefined;
  const budgetPct = lift?.toPct ?? withBurst(shared, burst, id);
  if (budgetPct === undefined) {
    return undefined;
  }
  const todayW = byId.get(id)?.byDay[formatUtcDay(new Date(now))]?.w ?? 0;
  const isLead = id === config.roles.lead;
  const surplus =
    isLead && inForce === undefined ? surplusHintOf({ config: config.burst, window: week.window, now, usedPct: week.usedPct, targetPct: budget.targetPct }) : undefined;
  return {
    now,
    id,
    name: roster.nameOf(id) ?? id,
    usedTodayPct: todayW / week.wPerPct,
    budgetPct,
    lift,
    burst,
    surplus,
    weekUsedPct: week.usedPct,
    pace: week.pace,
    isLead,
  };
}

/** The lead's inbox line about the session; a refusal (a secret pattern, a bad id) comes back as a line for the person. */
async function tellLead(runtime: CliRuntime, scope: BudgetScope, text: string, now: number): Promise<string | undefined> {
  const { kit, config, id } = scope;
  const problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), {
    to: config.roles.lead,
    from: id,
    text,
    now: new Date(now),
  });
  return problem === undefined ? undefined : `Budget: the lead's inbox line was not posted: ${problem}`;
}

/** The budget lines for the person at this turn's end (`stopWarning`), after metering the tab; posts the lead's inbox line when it is due. */
export async function stopBudgetLines(runtime: CliRuntime, scope: BudgetScope, transcript: string | undefined): Promise<readonly string[]> {
  const facts = await budgetFactsOf(runtime, scope, transcript);
  if (facts === undefined) {
    return [];
  }
  const store = new WarnStore(runtime.files, scope.kit.paths.warn);
  const result = stopWarning(facts, scope.config.budget, await store.read(scope.id));
  // Saved before anything goes out: an unsaved state would repeat the lines, and the lead's line, at every stop.
  await store.write(scope.id, result.state);
  const refused = result.leadLine === undefined ? undefined : await tellLead(runtime, scope, result.leadLine, facts.now);
  return refused === undefined ? result.lines : [...result.lines, refused];
}

/** The model's line with the next prompt (`promptWarning`), from the use as last stored: the turn's end metered it. */
export async function promptBudgetLine(runtime: CliRuntime, scope: BudgetScope): Promise<string | undefined> {
  const facts = await budgetFactsOf(runtime, scope, undefined);
  if (facts === undefined) {
    return undefined;
  }
  const store = new WarnStore(runtime.files, scope.kit.paths.warn);
  const result = promptWarning(facts, scope.config.budget, await store.read(scope.id));
  if (result.line !== undefined) {
    await store.write(scope.id, result.state);
  }
  return result.line;
}

/** The PreToolUse output that asks the person before a helper launch or refuses it (`helperGate`); undefined lets it go. */
export async function helperGateOutput(runtime: CliRuntime, scope: BudgetScope, transcript: string | undefined): Promise<string | undefined> {
  const facts = await budgetFactsOf(runtime, scope, transcript);
  if (facts === undefined) {
    return undefined;
  }
  const gate = helperGate(facts, scope.config.budget);
  if (gate.kind === 'allow') {
    return undefined;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: gate.kind, permissionDecisionReason: gate.reason } });
}
