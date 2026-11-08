import { join } from 'node:path';
import { ownerAsk } from "../../config/tree.js";
import { KIT_NAME } from "../../core/home.js";
import { DailyProfile } from "../../budget/active-time.js";
import { activeBurst, BURST_KINDS, burstFloorOf, decideBurst, isBurst, isBurstKind, sessionsTodayPct, spareShareNote, surplusOf, } from "../../budget/burst.js";
import { BurstLog } from "../../budget/burst-log.js";
import { BURST_COMMAND, burstText } from "../../budget/burst-lines.js";
import { formatPct } from "../../budget/format.js";
import { cachedWork, WORK_CACHE_FILE } from "../../budget/work.js";
import { HiringLog } from "../../hiring/log.js";
import { activeHires } from "../../hiring/record.js";
import { ACTIVE_STATUSES } from "../../register/model.js";
import { teamsOnAccountOf } from "../account-teams.js";
import { noPositionals, onePositional, requiredFlag, UsageError } from "../args.js";
import { readBursts } from "../burst-reading.js";
import { callerOf, listOf } from "../inputs.js";
import { leadOnly, openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { pctFlag, timeFlag, usageReadingOf } from "./budget.js";
import { ownRegister } from "./register.js";
/**
 * `burst`: the lead's time-boxed scale-out onto helpers and hired sessions (src/budget/burst.ts). `burst`
 * shows the week's surplus, the burst in force and its hires, and changes nothing; `burst start` starts one
 * within `burst`'s policy and caps (without --yes it only shows it); `burst end` ends the one in force. A
 * burst spends more of the week, so only a person starts one, by command, and under `burst.policy` owner
 * only with the owner's approval: the hooks only suggest one.
 */
const POLICY_TEXT = {
    off: 'the team takes no bursts',
    owner: 'the lead starts one once the owner approves it (--approved-by)',
    lead: 'the lead starts one within the caps',
};
/** A count flag: a whole number of 0 or more, or undefined when it is not given. */
function countFlag(flags, name) {
    const text = flags.get(name);
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (text.trim() === '' || !Number.isInteger(value) || value < 0) {
        throw new UsageError(`--${name} "${text}" is not a whole number of 0 or more`);
    }
    return value;
}
function namesOf(roster, ids) {
    return ids.map((id) => roster.nameOf(id) ?? id);
}
/** The hires on the team made for this burst. */
function hiresFor(burst, hires, config) {
    return hires.filter((hire) => hire.burst === burst.at && config.sessions.includes(hire.session));
}
/** The week's line, or why it is unknown. */
function weekStatusLine(week, zone) {
    const { usedPct, window } = week;
    if (usedPct === undefined || window === undefined) {
        return `WEEK the week's use or reset is unknown, so no burst can be judged: run ${KIT_NAME} statusline install, or set budget.weeklyLimitW and budget.reset`;
    }
    return `WEEK ${formatPct(usedPct)} of the week used; the pace ends ${zone.weekdayMinute(new Date(window.paceEnd))}, the reset is ${zone.weekdayMinute(new Date(window.reset))}`;
}
/**
 * The team and the other teams on its account (src/cli/account-teams.ts `teamsOnAccountOf`), split by the roster, lifts
 * in force at the week's use and each session's queued work as the hooks read it (`cachedWork`).
 */
async function teamsOf(runtime, kit, config, roster, now, usedPct) {
    const { weights: work } = await cachedWork(runtime.files, kit.paths.events, join(kit.paths.usage, WORK_CACHE_FILE), config.register.priorities, now);
    return teamsOnAccountOf(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage, ids: roster.ids, liftsPath: kit.paths.lifts, work }, now, usedPct);
}
/** The week's surplus with the team's part of its spare (`surplusOf`); undefined while the week is unknown or has no rate yet. */
async function teamSurplusOf(runtime, kit, config, roster, week, now) {
    const { usedPct, window } = week;
    if (usedPct === undefined || window === undefined) {
        return undefined;
    }
    const teams = await teamsOf(runtime, kit, config, roster, now, usedPct);
    return surplusOf({ window, now, usedPct, targetPct: config.budget.targetPct, config: config.burst, teams });
}
/** The surplus line: the team's part of the spare, and whether a surplus burst may start now. */
function surplusStatusLine(surplus, config, zone) {
    const projected = `about ${formatPct(surplus.sparePct)} of the week${spareShareNote(surplus)} projected unused at the pace end (budget.targetPct ${formatPct(config.budget.targetPct)})`;
    if (!surplus.open) {
        return `SURPLUS ${projected}; a surplus burst may start from ${zone.weekdayMinute(new Date(surplus.opensAt))} (burst.surplusHours ${config.burst.surplusHours} before the reset)`;
    }
    return surplus.worth
        ? `SURPLUS ${projected}: worth a surplus burst now`
        : `SURPLUS ${projected}: below burst.minSparePct (${formatPct(config.burst.minSparePct)}), so no surplus burst`;
}
/** What to run next: end the burst in force, else start one the week allows. */
function nextLine(config, inForce, surplus) {
    if (inForce !== undefined) {
        return `NEXT end it early: ${BURST_COMMAND} end --reason "<why>"`;
    }
    if (config.burst.policy === 'off') {
        return undefined;
    }
    const approval = config.burst.policy === 'owner' ? ' --approved-by "<who>"' : '';
    if (surplus?.worth === true) {
        return `NEXT preview a surplus burst: ${BURST_COMMAND} start surplus --reason "<why>"${approval}`;
    }
    return `NEXT for work due by a time, preview a deadline burst: ${BURST_COMMAND} start deadline --task <ids> --by <time> --stop-pct <n> --reason "<why>"${approval}`;
}
/** `burst`: the policy, the week, its surplus, the burst in force and its hires; read-only. */
export async function burst(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const now = runtime.clock.now();
    const zone = teamZone(config, runtime);
    const { week, bySession } = await usageReadingOf(runtime, kit, config, roster);
    const { records } = await new BurstLog(runtime.files, kit.paths.bursts).read();
    const inForce = activeBurst(records, now, week.usedPct);
    const lines = [`POLICY burst.policy ${config.burst.policy}: ${POLICY_TEXT[config.burst.policy]}`, weekStatusLine(week, zone)];
    const surplus = await teamSurplusOf(runtime, kit, config, roster, week, now);
    if (surplus !== undefined) {
        lines.push(surplusStatusLine(surplus, config, zone));
    }
    if (inForce === undefined) {
        const last = records.filter(isBurst).at(-1);
        lines.push(last === undefined ? 'BURST none yet' : `BURST none in force; the last, a ${last.kind} burst, started ${zone.weekdayMinute(new Date(last.at))} (${last.reason})`);
    }
    else {
        const approved = inForce.approvedBy === undefined ? '' : `, approved by ${inForce.approvedBy}`;
        const floorPct = burstFloorOf(inForce, week, bySession, config.budget, now);
        lines.push(`BURST in force: ${burstText(inForce, namesOf(roster, inForce.sessions), zone, floorPct)}`);
        lines.push(`  started ${zone.weekdayMinute(new Date(inForce.at))} by ${roster.nameOf(inForce.by) ?? inForce.by}${approved}: ${inForce.reason}`);
        const hired = hiresFor(inForce, activeHires((await new HiringLog(runtime.files, kit.paths.hires).read()).records), config);
        if (hired.length > 0) {
            lines.push(`  its hires: ${namesOf(roster, hired.map((hire) => hire.session)).join(', ')} (${hired.length} of ${inForce.hires})`);
        }
    }
    const next = nextLine(config, inForce, surplus);
    if (next !== undefined) {
        lines.push(next);
    }
    lines.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
function kindOf(args) {
    const kind = onePositional(args, 'kind');
    if (!isBurstKind(kind)) {
        throw new UsageError(`"${kind}" is not a burst kind: ${BURST_KINDS.join(' or ')}`);
    }
    return kind;
}
/** A deadline burst's tasks: each a task of the team still open. */
async function tasksOf(runtime, text) {
    if (text === undefined) {
        return { ids: [], owners: [] };
    }
    const ids = [...new Set(listOf('--task', text))];
    const { tasks } = (await ownRegister(runtime)).own.snapshot.state;
    const owners = ids.map((id) => {
        const task = tasks.get(id);
        if (task === undefined) {
            throw new RefusedError(`${id} is not a task of the team`);
        }
        if (!ACTIVE_STATUSES.includes(task.status)) {
            throw new RefusedError(`${id} is ${task.status}: a burst works on open tasks only`);
        }
        return task.owner;
    });
    return { ids, owners };
}
/** The sessions a burst names: --sessions, else the whole team for a surplus and the tasks' owners for a deadline. */
function sessionsOf(roster, flags, kind, owners) {
    const text = flags.get('sessions');
    if (text !== undefined) {
        return [...new Set(listOf('--sessions', text).map((each) => sessionIdOf(roster, each)))];
    }
    return kind === 'surplus' ? [...roster.ids] : [...new Set(owners)].filter((owner) => roster.ids.includes(owner));
}
/**
 * `burst start <surplus|deadline> --reason "<why>" [--sessions <ids>] [--helpers <n>] [--hires <n>] [--stop-pct <n>]
 * [--by <time>] [--task <ids>] [--approved-by "<who>"] [--yes]`: the lead only.
 */
export async function start(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const kind = kindOf(args);
    const { flags } = args;
    const reason = requiredFlag(flags, 'reason').trim();
    if (reason === '') {
        throw new UsageError('--reason needs a reason');
    }
    if (kind === 'surplus' && (flags.has('task') || flags.has('by'))) {
        throw new UsageError("--task and --by name a deadline burst's work: a surplus burst takes neither");
    }
    const now = runtime.clock.now();
    const helpers = countFlag(flags, 'helpers');
    const hires = countFlag(flags, 'hires');
    const stopPct = pctFlag(flags, 'stop-pct');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const zone = teamZone(config, runtime);
    const deadline = timeFlag(flags, 'by', { nowMs: now, zone });
    const roster = await rosterOf(runtime, kit, config);
    const by = leadOnly(roster, caller, 'starts a burst');
    const tasks = await tasksOf(runtime, flags.get('task'));
    const sessions = sessionsOf(roster, flags, kind, tasks.owners);
    const { week, bySession } = await usageReadingOf(runtime, kit, config, roster);
    const log = new BurstLog(runtime.files, kit.paths.bursts);
    const { records } = await log.read();
    const decision = decideBurst({ kind, sessions, helpers, hires, stopPct, deadline, tasks: tasks.ids, reason, approvedBy: flags.get('approved-by'), by, now }, {
        usedPct: week.usedPct,
        window: week.window,
        targetPct: config.budget.targetPct,
        config: config.burst,
        active: activeBurst(records, now, week.usedPct),
        zone,
        profile: DailyProfile.ofQuietHours(config.budget.quietHours),
        sessionsTodayPct: sessionsTodayPct(sessions, week, bySession, now),
        teams: await teamsOf(runtime, kit, config, roster, now, week.usedPct),
        ownerAsk: ownerAsk(config),
    });
    if (decision.kind === 'refused') {
        throw new RefusedError(decision.reason);
    }
    const started = decision.burst;
    const what = burstText(started, namesOf(roster, started.sessions), zone, started.dailyPct);
    const spend = `  the week is at ${formatPct(week.usedPct ?? 0)}; the burst may take it to ${formatPct(started.stopPct)} by ${zone.weekdayMinute(new Date(started.endsAt))} (budget.targetPct ${formatPct(config.budget.targetPct)})`;
    if (!args.switches.has('yes')) {
        runtime.out.stdout(`PREVIEW ${what} Nothing written (add --yes to write).`);
        runtime.out.stdout(spend);
        return EXIT.ok;
    }
    await log.append(started);
    runtime.out.stdout(`STARTED ${what}`);
    runtime.out.stdout(spend);
    const hire = started.hires === 0 ? '' : `; hire for it: ${KIT_NAME} hire <id> --burst --scope "<its job>" --reason "<why>"`;
    runtime.out.stdout(`NEXT its sessions read it at their next turn; end it early: ${BURST_COMMAND} end --reason "<why>"${hire}`);
    return EXIT.ok;
}
/** `burst end --reason "<why>"`: the lead ends the burst in force; its sessions' daily budgets are the shared ones again. */
export async function end(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const reason = requiredFlag(args.flags, 'reason').trim();
    if (reason === '') {
        throw new UsageError('--reason needs a reason');
    }
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const by = leadOnly(roster, caller, 'ends a burst');
    const now = runtime.clock.now();
    const { records, usedPct } = await readBursts(runtime, kit.paths, config.budget, now);
    const inForce = activeBurst(records, now, usedPct);
    if (inForce === undefined) {
        throw new RefusedError('no burst is in force: nothing to end');
    }
    await new BurstLog(runtime.files, kit.paths.bursts).append({ kind: 'end', burstAt: inForce.at, reason, by, at: now });
    runtime.out.stdout(`ENDED the ${inForce.kind} burst started ${teamZone(config, runtime).weekdayMinute(new Date(inForce.at))}: its sessions' daily budgets are the shared ones again`);
    const hired = hiresFor(inForce, activeHires((await new HiringLog(runtime.files, kit.paths.hires).read()).records), config);
    if (hired.length > 0) {
        runtime.out.stdout(`NEXT retire its hires: ${hired.map((each) => `${KIT_NAME} retire ${each.session}`).join('; ')}`);
    }
    return EXIT.ok;
}
