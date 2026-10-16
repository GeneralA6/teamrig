import { basename, dirname, join } from 'node:path';
import { SecretScanner } from "../../core/secrets.js";
import { formatUtcDay } from "../../core/time.js";
import { activeLift, LiftLog } from "../../budget/lift.js";
import { OUTSIDE_ID } from "../../budget/measure.js";
import { runMeter } from "../../budget/meter.js";
import { sessionBudgetPct } from "../../budget/pace.js";
import { readSnapshots, weekUseOf } from "../../budget/snapshot.js";
import { UsageStore } from "../../budget/store.js";
import { helperGate, promptWarning, stopWarning } from "../../budget/warn.js";
import { WarnStore } from "../../budget/warn-store.js";
import { readWeek } from "../../budget/week.js";
import { postLine } from "../../inbox/inbox.js";
import { snapshotDirOf } from "./budget.js";
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
 * budget off, before the week's use or W per % is known, or without a daily budget for the session.
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
    const snapshots = await readSnapshots(files, snapshotDirOf(budget, kit.paths));
    const week = readWeek({ budget, now, statusUse: weekUseOf(snapshots, now), states: [...byId.values(), outside] });
    if (week.usedPct === undefined || week.wPerPct === undefined) {
        return undefined;
    }
    const lift = activeLift((await new LiftLog(files, kit.paths.lifts).read()).lifts, id, now, week.usedPct);
    const shared = week.allowancePct === undefined ? budget.sessions[id]?.dailyPct : sessionBudgetPct(week.allowancePct, id, roster.ids, budget.sessions);
    const budgetPct = lift?.toPct ?? shared;
    if (budgetPct === undefined) {
        return undefined;
    }
    const todayW = byId.get(id)?.byDay[formatUtcDay(new Date(now))]?.w ?? 0;
    return {
        now,
        id,
        name: roster.nameOf(id) ?? id,
        usedTodayPct: todayW / week.wPerPct,
        budgetPct,
        lift,
        weekUsedPct: week.usedPct,
        pace: week.pace,
        isLead: id === config.roles.lead,
    };
}
/** The lead's inbox line about the session; a refusal (a secret pattern, a bad id) comes back as a line for the person. */
async function tellLead(runtime, scope, text, now) {
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
export async function stopBudgetLines(runtime, scope, transcript) {
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
/** The PreToolUse output that asks the person before a helper launch or refuses it (`helperGate`); undefined lets it go. */
export async function helperGateOutput(runtime, scope, transcript) {
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
