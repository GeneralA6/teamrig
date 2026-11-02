import { basename, dirname, join } from 'node:path';
import { LeadTree } from "../../config/lead-tree.js";
import { ownerAsk } from "../../config/tree.js";
import { SecretScanner } from "../../core/secrets.js";
import { activeBurst, burstFloorOf, withBurst } from "../../budget/burst.js";
import { surplusHintOf } from "../../budget/burst-lines.js";
import { BurstLog } from "../../budget/burst-log.js";
import { activeCut, CutLog } from "../../budget/cut.js";
import { activeLift, LiftLog } from "../../budget/lift.js";
import { OUTSIDE_ID } from "../../budget/measure.js";
import { runMeter } from "../../budget/meter.js";
import { budgetSplitOf, dailyBudgetOf } from "../../budget/parts.js";
import { fundForDay, isPaused, pausableOf } from "../../budget/pause.js";
import { keepSessionsWeek, sessionsWeekOf } from "../../budget/session-week-file.js";
import { UsageStore } from "../../budget/store.js";
import { teamWeekOf } from "../../budget/team-week.js";
import { keepTeamWeek, teamWeekSummaryOf } from "../../budget/team-week-file.js";
import { helperGate, promptWarning, stopWarning } from "../../budget/warn.js";
import { WarnStore } from "../../budget/warn-store.js";
import { wSince } from "../../budget/week.js";
import { cachedWork, WORK_CACHE_FILE } from "../../budget/work.js";
import { postLine } from "../../inbox/inbox.js";
import { holdBack } from "../../hooks/permission.js";
import { helperLaunchReminder } from "../../rules/helper-default.js";
import { accountWeekOn, otherTeamsOnAccount } from "../account-teams.js";
import { teamZone } from "../kit.js";
import { meterScaleOf } from "../stored-week.js";
import { liftNamesOf } from "./budget.js";
import { inboxDepsOf } from "./inbox.js";
const TRANSCRIPT = '.jsonl';
/** A tab's subagent transcripts, `<project>/<claude session>/subagents/*.jsonl`, by name so each run reads them in the same order. */
async function subagentsOf(folders, transcript) {
    const dir = join(dirname(transcript), basename(transcript, TRANSCRIPT), 'subagents');
    const entries = await folders.entries(dir);
    return entries
        .filter((entry) => !entry.folder && entry.name.endsWith(TRANSCRIPT))
        .map((entry) => join(dir, entry.name))
        .sort();
}
/** One meter run over the tab's own transcripts; a run that lost a save race is left for the next hook. */
async function meterTab(runtime, store, id, transcript, budget) {
    const transcripts = { main: [transcript], subagents: await subagentsOf(runtime.transcripts, transcript) };
    await runMeter({ bytes: runtime.transcripts, store, clock: runtime.clock }, { session: id, transcripts, subagentWeight: budget.subagentWeight, maxBytes: budget.maxBytesPerHook });
}
/**
 * The session's budget now, after metering the tab whose transcript is given; undefined with the
 * budget off, before the week's use, W per % and reset are known, or without a daily budget for the session.
 * Its part of its team's part of the account's daily budget (the other teams on the account read each call,
 * `otherTeamsOnAccount`) is weighed by its queued work in the register, replayed only when the register
 * changed since the last reading (`cachedWork`), or set by a lift; a burst the session is in raises it to at least
 * the burst's. Everyone's use today against the team's in-day pace
 * (`teamDay`) says whether a session past its part is held, unless a leader's cut of it is in force (`activeCut`):
 * then it is held past its part whatever room the team has. The lead,
 * with no burst in force, also gets the week's surplus when it is worth one. On the way, it keeps the team's week
 * summary and its sessions' week for readers that show them (budget/team-week-file.ts, budget/session-week-file.ts),
 * each written when that changes it.
 */
export async function budgetFactsOf(runtime, scope, transcript) {
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
    const byId = new Map();
    for (const each of roster.ids) {
        byId.set(each, (await team.load(each)).state);
    }
    const outside = (await new UsageStore(files, join(kit.paths.usage, 'outside')).load(OUTSIDE_ID)).state;
    const account = await accountWeekOn(runtime, budget, kit.paths, now);
    const states = [...byId.values(), outside];
    const week = await teamWeekOf(files, account.paths, meterScaleOf(runtime, kit.paths.team, account), { budget, now, statusUse: account.statusUse, states });
    const { teamDay, todayWPerPct } = week;
    if (week.usedPct === undefined || todayWPerPct === undefined || teamDay === undefined) {
        return undefined;
    }
    const { lifts } = await new LiftLog(files, kit.paths.lifts).read();
    const lift = activeLift(lifts, id, now, week.usedPct);
    const { cuts } = await new CutLog(files, kit.paths.cuts).read();
    const cut = activeCut(cuts, lifts, id, now);
    const work = await cachedWork(files, kit.paths.events, join(kit.paths.usage, WORK_CACHE_FILE), config.register.priorities);
    const split = budgetSplitOf({ team: kit.paths.team, ids: roster.ids, sessions: budget.sessions, leads: config.leads, work: work.weights, pausable: pausableOf(config, kit.paths.team, roster.ids), lifts, now, usedPct: week.usedPct });
    const others = await otherTeamsOnAccount(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage }, now, week.usedPct);
    const teams = { split, others };
    const summary = teamWeekSummaryOf({ window: week.window, usedPct: week.usedPct, wPerPct: week.wPerPct, targetPct: budget.targetPct, states: [...byId.values()], teams, now });
    if (summary !== undefined) {
        await keepTeamWeek(files, kit.paths.teamWeek, summary);
    }
    const sessionsWeek = sessionsWeekOf({ window: week.window, wPerPct: week.wPerPct, byId, now });
    if (sessionsWeek !== undefined) {
        await keepSessionsWeek(files, kit.paths.sessionsWeek, sessionsWeek);
    }
    const funded = fundForDay({ split, others }, week);
    const shared = dailyBudgetOf(week.allowancePct, id, funded.split, funded.others);
    const inForce = activeBurst((await new BurstLog(files, kit.paths.bursts).read()).records, now, week.usedPct);
    const burst = inForce !== undefined && inForce.sessions.includes(id) ? inForce : undefined;
    const budgetPct = withBurst(shared, burst === undefined ? undefined : burstFloorOf(burst, week, byId, budget, now));
    if (budgetPct === undefined) {
        return undefined;
    }
    const own = byId.get(id);
    const todayW = own === undefined ? 0 : wSince([own], week.todayFrom, now);
    const isLead = id === config.roles.lead;
    const surplus = isLead && inForce === undefined
        ? surplusHintOf({
            config: config.burst,
            window: week.window,
            now,
            usedPct: week.usedPct,
            targetPct: budget.targetPct,
            // The week's spare, not a short day's cut: the teams unfunded.
            teams,
            ownerAsk: ownerAsk(config),
        })
        : undefined;
    return {
        now,
        id,
        name: roster.nameOf(id) ?? id,
        usedTodayPct: todayW / todayWPerPct,
        todayWPerPct,
        budgetPct,
        lift,
        cut,
        cutBy: cut === undefined ? undefined : leaderNamed(config, roster, cut.by),
        ...liftNamesOf(funded, week.allowancePct, roster, id, lift),
        burst,
        paused: isPaused(funded.split, id),
        surplus,
        weekUsedPct: week.usedPct,
        pace: week.pace,
        teamDay,
        isLead,
        urgent: work.urgent.get(id) ?? [],
        leader: budgetLeaderOf(config, roster, id),
        zone: teamZone(config, runtime),
    };
}
/**
 * The session's own leader, who gets its inbox line: the sub-lead that lists it, else the lead; undefined for the lead.
 * A session the config does not list (the tree knows only listed ones) still tells the lead.
 */
function budgetLeaderOf(config, roster, id) {
    const lead = config.roles.lead;
    const leader = new LeadTree(config).leaderOf(id) ?? (id === lead ? undefined : lead);
    return leader === undefined ? undefined : leaderNamed(config, roster, leader);
}
/** A leader by its session id, with the name its lines call it by. */
function leaderNamed(config, roster, id) {
    return { id, name: roster.nameOf(id) ?? id, isLead: id === config.roles.lead };
}
/** The leader's inbox line about the session; a refusal (a secret pattern, a bad id) comes back as a line for the person. */
async function tellLeader(runtime, scope, leader, text, now) {
    const { kit, config, id } = scope;
    const problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), {
        to: leader.id,
        from: id,
        text,
        now: new Date(now),
    });
    return problem === undefined ? undefined : `Budget: the inbox line to ${leader.name} was not posted: ${problem}`;
}
/** The budget lines for the person at this turn's end (`stopWarning`), after metering the tab; posts its leader's inbox line when it is due. */
export async function stopBudgetLines(runtime, scope, transcript) {
    const facts = await budgetFactsOf(runtime, scope, transcript);
    if (facts === undefined) {
        return [];
    }
    const store = new WarnStore(runtime.files, scope.kit.paths.warn);
    const result = stopWarning(facts, scope.config.budget, await store.read(scope.id));
    // Saved before anything goes out: an unsaved state would repeat the lines, and the leader's line, at every stop.
    await store.write(scope.id, result.state);
    const refused = result.leadLine === undefined || facts.leader === undefined ? undefined : await tellLeader(runtime, scope, facts.leader, result.leadLine, facts.now);
    return refused === undefined ? result.lines : [...result.lines, refused];
}
/** The model's line with the next prompt (`promptWarning`), from the use as last stored: the turn's end metered it. */
export async function promptBudgetLine(runtime, scope) {
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
/**
 * The budget's say on a helper launch (`helperGate`). The budget off, or usage files it cannot read (a newer
 * teamrig wrote them), let the launch go, so the reminder beside it still arrives.
 */
async function budgetGateOf(runtime, scope, transcript) {
    const facts = await budgetFactsOf(runtime, scope, transcript).catch(() => undefined);
    return facts === undefined ? { kind: 'allow' } : helperGate(facts, scope.config.budget);
}
/**
 * The PreToolUse output at each helper launch: rule 8's helper default as model context (`helperLaunchReminder`),
 * plus the budget's ask or refusal when it holds the launch back (an ask is a refusal under `prompts.hookAsks: refuse`).
 */
export async function helperGateOutput(runtime, scope, transcript) {
    const gate = await budgetGateOf(runtime, scope, transcript);
    const decision = gate.kind === 'allow' ? {} : holdBack(gate.kind, gate.reason, scope.config.prompts.hookAsks);
    const additionalContext = helperLaunchReminder(scope.config.budget.subagentWeight);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision, additionalContext } });
}
