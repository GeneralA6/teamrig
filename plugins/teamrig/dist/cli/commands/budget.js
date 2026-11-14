import { basename, join } from 'node:path';
import { DEFAULT_STATUS_LINE } from "../../config/defaults.js";
import { LeadTree } from "../../config/lead-tree.js";
import { formatAddress, splitAddress } from "../../core/address.js";
import { errorMessage } from "../../core/guards.js";
import { resolveKitHome } from "../../core/home.js";
import { PlainLogFile } from "../../core/log-file.js";
import { resolveTeam } from "../../core/team.js";
import { formatUtcDay, MS_PER_DAY, parseUtcDay, typedDeadline, typedTimeHint } from "../../core/time.js";
import { transcriptTitleOf } from "../../budget/attribute.js";
import { activeBurst, burstFloorOf, withBurst } from "../../budget/burst.js";
import { BurstLog } from "../../budget/burst-log.js";
import { calibrationOf } from "../../budget/calibration.js";
import { classRowsOf } from "../../budget/class-spend.js";
import { activeCut, CutLog, cutText, decideCut } from "../../budget/cut.js";
import { claudeProjectsDir } from "../../budget/discover.js";
import { ExtraLog, lastSpentOf } from "../../budget/extra.js";
import { formatPct, formatUsd } from "../../budget/format.js";
import { activeGroupLift, activeLift, decideLift, LiftLog, liftText, parentBudgetText } from "../../budget/lift.js";
import { CATCH_UP_CHUNK_BYTES, MAX_RUNS_PER_SESSION, measure, OUTSIDE_ID, outsideUsageDir } from "../../budget/measure.js";
import { paceLineOfWeek } from "../../budget/pace.js";
import { resetStockLines } from "../../budget/resets.js";
import { budgetSplitOf, crossLiftPlaceOf, dailyBudgetOf, groupPartsOf, liftPlaceOf, liftWeekPctOf, teamPartOf } from "../../budget/parts.js";
import { fundForDay, isPaused, pausableOf } from "../../budget/pause.js";
import { nextPeriod, sightOf } from "../../budget/period.js";
import { burnLines, loopLines, missLines, missMatrixLines, recountLines, sessionLines, sumDays, sumUsage, taskLines, todayLines, weekLine, } from "../../budget/report.js";
import { datedSnapshot, defaultSnapshotDir, effortOfStatus, formatSnapshot, parseSnapshot, pruneSnapshots, snapshotDirOf, snapshotOfStatus, statusLineText, } from "../../budget/snapshot.js";
import { foldIntoFiveHourSummary, readFolderFiveHour } from "../../budget/five-hour-summary.js";
import { CURSOR_DAYS_KEPT, DAYS_KEPT, EMPTY_USAGE, MemoryUsageStore, UsageStore } from "../../budget/store.js";
import { attributedW, taskUseOf } from "../../budget/task-use.js";
import { readTeamWeek } from "../../budget/team-week-file.js";
import { teamWeekOf } from "../../budget/team-week.js";
import { foldIntoWeekSummary } from "../../budget/week-summary.js";
import { readWeek, wSince } from "../../budget/week.js";
import { NO_WORK, queuedWork, readTasks, readWork } from "../../budget/work.js";
import { JsonlMarkLog } from "../../inbox/store.js";
import { indexMarks } from "../../inbox/marks.js";
import { TASK_ID } from "../../register/model.js";
import { accountWeekOn, kitHomeAccountsOf, otherTeamsOnAccount, peerMarksOf } from "../account-teams.js";
import { UsageError, onePositional, requiredFlag } from "../args.js";
import { callerOf } from "../inputs.js";
import { leadOnly, openKit, openTeamKit, requireConfig, rosterOf, sessionIdOf, teamFolders, teamZone } from "../kit.js";
import { statusLineMeetingFor } from "../statusline-meeting.js";
import { EXIT, RefusedError } from "../runtime.js";
import { peerUsageOf } from "../stored-week.js";
import { loadTree } from "../tree.js";
/**
 * The weekly budget from the command line: `budget` measures every session's use from the Claude Code
 * transcripts and shows it against the week's pace, or with `--task` what each session spent on one task;
 * `budget lift` is a leader's lift of one session's, or a sub-lead's group's,
 * daily budget, or the lead's top-up of a session of a team below from its own team's; `budget cut` is a leader's cut
 * of one session to its own daily budget; `statusline` is a status line that saves the plan's own reading for `budget`.
 * Measuring, showing and logging only: nothing here blocks or stops a session; the hooks read the lifts and cuts.
 */
/** Days the loop table shows by default; `--all` shows every stored day. */
export const LOOP_DAYS_SHOWN = 4;
function dayStartOf(at) {
    return at - (at % MS_PER_DAY);
}
/** Measures every session up to now (or through the recounted day) and reads the week. */
async function readBudget(runtime, kit, config, roster, options) {
    const { files } = runtime;
    const recount = options.recountDay !== undefined;
    const now = options.recountDay === undefined ? runtime.clock.now() : options.recountDay + MS_PER_DAY - 1;
    const clock = { now: () => now };
    const { marks } = await new JsonlMarkLog(new PlainLogFile(files, kit.paths.inboxMarks)).read();
    const account = recount ? undefined : await accountWeekOn(runtime, config.budget, kit.paths, now);
    const peers = account === undefined ? [] : await peerMarksOf(files, account.peers);
    const measured = await measure({
        transcripts: runtime.transcripts,
        titleOf: (path) => transcriptTitleOf(runtime.transcripts, path),
        team: recount ? new MemoryUsageStore() : new UsageStore(files, kit.paths.usage),
        outside: recount ? new MemoryUsageStore() : new UsageStore(files, outsideUsageDir(kit.paths.usage)),
        clock,
    }, {
        projectsDir: claudeProjectsDir(runtime.env, runtime.userHome),
        since: options.recountDay ?? dayStartOf(now) - (CURSOR_DAYS_KEPT - 1) * MS_PER_DAY,
        team: kit.paths.team,
        roster,
        areaBySession: indexMarks(marks).areaBySession,
        peers,
        subagentWeight: config.budget.subagentWeight,
        chunkBytes: CATCH_UP_CHUNK_BYTES,
        maxRuns: MAX_RUNS_PER_SESSION,
    });
    // The account's W: the other teams' sessions on it count too, as their stores last held them (T1778).
    const peerUsage = account === undefined ? [] : await peerUsageOf(runtime, account.peers);
    const states = [...measured.bySession.values(), measured.outside, ...peerUsage.flatMap((peer) => peer.states)];
    const input = { budget: config.budget, now, statusUse: account?.statusUse, states };
    // A recount reads no team state, the meter log included: its rate is the configured one.
    const week = account === undefined
        ? readWeek({ ...input, period: recountPeriodOf(config.budget, now), calibration: calibrationOf([]), readings: [] })
        : await teamWeekOf(files, account, input);
    const lifts = recount ? [] : (await new LiftLog(files, kit.paths.lifts).read()).lifts;
    const bursts = recount ? [] : (await new BurstLog(files, kit.paths.bursts).read()).records;
    const cuts = recount ? [] : (await new CutLog(files, kit.paths.cuts).read()).cuts;
    return { now, measured, week, weekPaths: account?.paths ?? kit.paths, lifts, bursts, cuts, peerUsage };
}
/** The week and the team's usage now, for `burst`: its floor reads its sessions' use today. */
export async function usageReadingOf(runtime, kit, config, roster) {
    const { week, measured } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
    return { week, bySession: measured.bySession };
}
/** The week's use line, measured up to now as `budget` measures it, for `start`. */
export async function weekLineOf(runtime, kit, config, roster) {
    return weekLine((await usageReadingOf(runtime, kit, config, roster)).week, teamZone(config, runtime));
}
/** How the team's part of the day is split among its sessions: down its lead tree, by their queued work (`work`), the lifts in force and the sessions a short day may pause. */
function splitOf(reading, team, roster, config, work) {
    return budgetSplitOf({ team, ids: roster.ids, sessions: config.budget.sessions, leads: config.leads, work, pausable: pausableOf(config, team, roster.ids), lifts: reading.lifts, now: reading.now, usedPct: reading.week.usedPct });
}
/** Each session today: its use, and its part (`split`) of the team's part of the account's daily budget beside the `others` on it, its lift, the burst and whether a leader's cut of it is in force. */
function sessionsToday(reading, roster, budget, split, others) {
    const today = formatUtcDay(new Date(reading.now));
    const inForce = activeBurst(reading.bursts, reading.now, reading.week.usedPct);
    const burstNow = inForce === undefined ? undefined : { burst: inForce, floorPct: burstFloorOf(inForce, reading.week, reading.measured.bySession, budget, reading.now) };
    return roster.ids.map((id) => {
        const state = reading.measured.bySession.get(id);
        const w = state === undefined ? 0 : wSince([state], reading.week.todayFrom, reading.now);
        const lift = activeLift(reading.lifts, id, reading.now, reading.week.usedPct);
        const inBurst = burstNow !== undefined && burstNow.burst.sessions.includes(id) ? burstNow : undefined;
        const budgetPct = withBurst(dailyBudgetOf(reading.week.allowancePct, id, split, others), inBurst?.floorPct);
        return { id, name: roster.nameOf(id) ?? id, w, calls: state?.byDay[today]?.calls ?? 0, budgetPct, lift, ...liftNamesOf({ split, others }, reading.week.allowancePct, roster, id, lift), inBurst, paused: isPaused(split, id), cut: activeCut(reading.cuts, reading.lifts, id, reading.now) !== undefined };
    });
}
/** Each sub-lead's group today: its part of the day (`groupPartsOf`) and its group lift by name. */
function groupsToday(reading, roster, split, others) {
    return groupPartsOf(reading.week.allowancePct, split, others).map((group) => {
        const lift = activeGroupLift(reading.lifts, group.id, reading.now, reading.week.usedPct);
        return { id: group.id, name: roster.nameOf(group.id) ?? group.id, sessions: group.sessions, budgetPct: group.budgetPct, lift, ...liftNamesOf({ split, others }, reading.week.allowancePct, roster, group.id, lift) };
    });
}
/**
 * Another team on the account today: its sessions' use as their stores last held it and its part of the account's
 * daily budget, from its split among the `others` beside the asking team's `split`; no part when it has none there.
 */
function peerToday(peer, reading, split, others) {
    const today = formatUtcDay(new Date(reading.now));
    const own = others.find((each) => each.team === peer.team);
    const budgetPct = own === undefined ? undefined : teamPartOf(reading.week.allowancePct, own, [split, ...others.filter((each) => each !== own)]);
    return {
        team: peer.team,
        sessions: peer.states.length,
        w: wSince(peer.states, reading.week.todayFrom, reading.now),
        calls: peer.states.reduce((sum, state) => sum + (state.byDay[today]?.calls ?? 0), 0),
        budgetPct,
    };
}
/**
 * The lift of session `id`, or of the group sub-lead `id` leads, by name: the leader that gave it, the sub-lead whose
 * group's daily budget it is a part of (the team's `split` tree) and the share of the week its part comes to now, of
 * the account's day `allowancePct` beside the `others` on it.
 */
export function liftNamesOf(teams, allowancePct, roster, id, lift) {
    if (lift === undefined) {
        return { liftBy: undefined, liftParent: undefined, liftWeekPct: undefined };
    }
    const parent = liftPlaceOf(teams.split, id, lift.group)?.parent;
    return {
        liftBy: roster.nameOf(lift.by) ?? lift.by,
        liftParent: parent === undefined ? undefined : (roster.nameOf(parent) ?? parent),
        liftWeekPct: liftWeekPctOf(allowancePct, parent, lift.partPct, teams.split, teams.others),
    };
}
/** The days a loop table shows, oldest first, ending at `now`'s day. */
function loopDays(now, count) {
    return Array.from({ length: count }, (_, index) => formatUtcDay(new Date(now - (count - 1 - index) * MS_PER_DAY)));
}
/** A recount's period: it reads no stored state, so the week before the configured reset, a guess. */
function recountPeriodOf(budget, now) {
    const sight = sightOf(budget, undefined, now);
    return sight === undefined ? undefined : nextPeriod(undefined, sight);
}
function recountDayOf(text, now) {
    if (text === undefined) {
        return undefined;
    }
    const day = parseUtcDay(text);
    if (day === undefined) {
        throw new UsageError(`--day "${text}" is not a YYYY-MM-DD day`);
    }
    if (day.getTime() > now) {
        throw new UsageError(`--day ${text} has not begun`);
    }
    return day.getTime();
}
function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}
/** `budget --task <id>`: each session's W on the task by UTC day, outside the team too, and today's share of W any task got. */
function taskReadingLines(reading, roster, task) {
    const { measured, week, now } = reading;
    const states = new Map([...measured.bySession, [OUTSIDE_ID, measured.outside]]);
    const today = formatUtcDay(new Date(now));
    const usages = [...states.values()];
    return taskLines(taskUseOf(states, task), {
        week,
        nameOf: (session) => (session === OUTSIDE_ID ? 'outside the team' : (roster.nameOf(session) ?? session)),
        today: { w: sum(usages.map((state) => state.byDay[today]?.w ?? 0)), attributed: sum(usages.map((state) => attributedW(state, today))) },
    });
}
/** `budget [<session>] [--loops|--burn|--misses] [--day <day>] [--all]`, or `budget --task <id>` alone. */
export async function budget(args, runtime) {
    const [target, extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const recountDay = recountDayOf(args.flags.get('day'), runtime.clock.now());
    const all = args.switches.has('all');
    const loops = args.switches.has('loops');
    const burn = args.switches.has('burn');
    const misses = args.switches.has('misses');
    if ([loops, burn, misses].filter(Boolean).length > 1) {
        throw new UsageError('--loops, --burn and --misses are three tables: give one');
    }
    const task = args.flags.get('task');
    if (task !== undefined) {
        if (target !== undefined || recountDay !== undefined || all || loops || burn || misses) {
            throw new UsageError('--task reads alone: give no session, table, --day or --all with it');
        }
        if (!TASK_ID.test(task)) {
            throw new UsageError(`--task "${task}" is not a task id such as T734`);
        }
    }
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const id = target === undefined ? undefined : sessionIdOf(roster, target);
    const reading = await readBudget(runtime, kit, config, roster, { recountDay });
    if (task !== undefined) {
        for (const line of taskReadingLines(reading, roster, task)) {
            runtime.out.stdout(line);
        }
        return EXIT.ok;
    }
    const tasks = recountDay === undefined ? await readTasks(runtime.files, kit.paths.events) : undefined;
    const { weights: work } = tasks === undefined ? NO_WORK : queuedWork(tasks, config.register.priorities, reading.now);
    // A recount shows no budgets, so it reads no other team.
    const onAccount = recountDay === undefined ? await otherTeamsOnAccount(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage }, reading.now, reading.week.usedPct) : [];
    const { split, others } = fundForDay({ split: splitOf(reading, kit.paths.team, roster, config, work), others: onAccount }, reading.week);
    const sessions = sessionsToday(reading, roster, config.budget, split, others);
    const teamPct = teamPartOf(reading.week.allowancePct, split, others);
    const { measured, week, now } = reading;
    const zone = teamZone(config, runtime);
    let lines;
    const days = recountDay === undefined ? loopDays(now, all ? DAYS_KEPT : LOOP_DAYS_SHOWN) : [formatUtcDay(new Date(recountDay))];
    const source = recountDay === undefined ? 'metered' : 'recounted';
    if (misses && id === undefined) {
        const rows = roster.ids.map((each) => ({ name: roster.nameOf(each) ?? each, usage: sumUsage(sumDays([measured.bySession.get(each) ?? EMPTY_USAGE], days)) }));
        lines = missMatrixLines(days, rows);
    }
    else if (loops || burn || misses) {
        const states = id === undefined ? [...measured.bySession.values(), measured.outside] : [measured.bySession.get(id) ?? EMPTY_USAGE];
        const table = loops ? loopLines : burn ? burnLines : missLines;
        lines = table(id === undefined ? 'every session, outside the team too' : (roster.nameOf(id) ?? id), days, sumDays(states, days), source);
    }
    else if (id !== undefined) {
        const session = sessions.find((each) => each.id === id);
        const state = measured.bySession.get(id);
        lines = session === undefined || state === undefined ? [] : sessionLines(session, state, week, zone);
    }
    else {
        const today = formatUtcDay(new Date(now));
        const outsideToday = measured.outside.byDay[today];
        const outside = { w: wSince([measured.outside], week.todayFrom, now), calls: outsideToday?.calls ?? 0, sessions: measured.outsideSessions, top: measured.outsideTop };
        const behind = measured.behind.map((each) => (each === OUTSIDE_ID ? 'outside the team' : (roster.nameOf(each) ?? each)));
        // The team's sessions alone, so the rows add up to the team's row of the table above them.
        const classes = tasks === undefined ? undefined : classRowsOf({ states: [...measured.bySession.values()], tasks, focus: config.focus, todayFrom: week.todayFrom, weekFrom: week.window?.start, now });
        if (recountDay === undefined) {
            const fiveHour = await readFolderFiveHour(runtime.files, snapshotDirOf(config.budget, kit.paths), now);
            const peers = reading.peerUsage.map((peer) => peerToday(peer, reading, split, others));
            lines = [
                ...todayLines({ week, fiveHour, teamPct, sessions, groups: groupsToday(reading, roster, split, others), classes, peers, outside, behind, all, zone }),
                ...resetStockLines(config.budget.resets, now, zone),
            ];
        }
        else {
            lines = recountLines(today, { week, sessions, outside, all });
        }
    }
    for (const line of lines) {
        runtime.out.stdout(line);
    }
    return EXIT.ok;
}
/** A percent flag: above 0 and up to 100, or undefined when it is not given. */
export function pctFlag(flags, name) {
    const text = flags.get(name);
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 100) {
        throw new UsageError(`--${name} "${text}" is not a percent above 0 and up to 100`);
    }
    return value;
}
/** A time flag such as `--until`: `HH:MM` today or `YYYY-MM-DD HH:MM`, on the team's clock unless marked UTC; undefined when it is not given. */
export function timeFlag(flags, name, times) {
    const text = flags.get(name);
    if (text === undefined) {
        return undefined;
    }
    const at = typedDeadline(text, times.nowMs, times.zone);
    if (at === undefined) {
        throw new UsageError(`--${name} "${text}" is not ${typedTimeHint(times.zone, times.nowMs)}`);
    }
    return at.getTime();
}
/** `a`, `a or b`, `a, b or c`. */
function orList(words) {
    return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`;
}
/**
 * Why session `by` may not lift session `id`'s daily budget, or with `group` sub-lead `id`'s group's; undefined when it
 * may. A leader lifts every session and sub-lead's group under it, at any depth, and a sub-lead its own session too,
 * a part of its own group's budget; the lead's group is the whole team, which no lift takes a part of.
 */
function liftRefusalOf(tree, nameOf, by, id, group) {
    const name = nameOf(id);
    if (group) {
        if (id === tree.lead) {
            return `--group lifts a sub-lead's group; ${name} is the lead, whose group is the whole team`;
        }
        if (!tree.isLeader(id)) {
            return `--group lifts a sub-lead's group, and ${name} leads none`;
        }
        return tree.leads(by, id) ? undefined : `${name}'s group's budget is lifted only by ${orList(tree.chainOf(id).map(nameOf))}`;
    }
    return sessionRefusalOf(tree, nameOf, by, id, 'lifted');
}
/**
 * Why session `by` may not lift or cut (`verb`) session `id`'s daily budget; undefined when it may. A leader may for
 * every session under it, at any depth, and a sub-lead for its own session too.
 */
function sessionRefusalOf(tree, nameOf, by, id, verb) {
    if (tree.leads(by, id) || (by === id && tree.isLeader(by))) {
        return undefined;
    }
    return `${nameOf(id)}'s budget is ${verb} only by ${orList([...(tree.isLeader(id) ? [id] : []), ...tree.chainOf(id)].map(nameOf))}`;
}
/**
 * What a lift too big for sub-lead `group`'s group's budget can do instead, for its refusal: the lift of that group its
 * leader (`leader`) can give, after the group's budget and use today in percent of the week, each left out when unknown.
 */
function beyondGroupText(group, leader, budgetPct, usedPct) {
    const facts = [budgetPct === undefined ? undefined : `gets ${formatPct(budgetPct)} of the week today`, usedPct === undefined ? undefined : `has used ${formatPct(usedPct)}`];
    const known = facts.filter((each) => each !== undefined);
    const command = `\`teamrig budget lift ${group} --group --part <pct> --stop-pct <n> --reason "<why>"\``;
    return known.length === 0 ? `${leader} can lift ${group}'s group: ${command}` : `${group}'s group ${known.join(' and ')}; ${leader} can lift it: ${command}`;
}
/**
 * `budget lift <session> [--group] --part <pct> --stop-pct <n> [--until <time>] [--reserve] --reason "<text>"`: a
 * leader lifts a session under it, or with `--group` the group of a sub-lead under it (`liftRefusalOf`); the lead
 * also lifts `<team>/<session>`, a session of a team under its own (`crossTeamLift`).
 */
export async function lift(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const target = onePositional(args, 'session');
    const partPct = pctFlag(args.flags, 'part');
    if (partPct === undefined) {
        throw new UsageError('--part is required');
    }
    const stopPct = pctFlag(args.flags, 'stop-pct');
    const reason = requiredFlag(args.flags, 'reason').trim();
    if (reason === '') {
        throw new UsageError('--reason needs a reason');
    }
    const now = runtime.clock.now();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const zone = teamZone(config, runtime);
    const until = timeFlag(args.flags, 'until', { nowMs: now, zone });
    const roster = await rosterOf(runtime, kit, config);
    const group = args.switches.has('group');
    const address = splitAddress(target);
    if (address?.team !== undefined && address.team !== kit.paths.team) {
        const ask = { caller, group, partPct, stopPct, until, reserve: args.switches.has('reserve'), reason, now };
        return crossTeamLift(runtime, { kit, config, roster, zone }, { team: address.team, session: address.session }, ask);
    }
    const nameOf = (each) => roster.nameOf(each) ?? each;
    const by = sessionIdOf(roster, caller);
    const id = sessionIdOf(roster, address?.session ?? target);
    const tree = new LeadTree(config);
    const refusal = liftRefusalOf(tree, nameOf, by, id, group);
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    const name = nameOf(id);
    const reading = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
    const { week } = reading;
    const { weights: work } = await readWork(runtime.files, kit.paths.events, config.register.priorities, now);
    const split = splitOf(reading, kit.paths.team, roster, config, work);
    const place = liftPlaceOf(split, id, group);
    if (place === undefined) {
        throw new RefusedError(`${group ? `${name}'s group` : name} has no daily budget to lift: \`leads\` lists it in a loop of sub-leads no leader above reaches`);
    }
    const parent = parentBudgetText(place.parent === undefined ? undefined : nameOf(place.parent));
    const others = await otherTeamsOnAccount(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage }, reading.now, week.usedPct);
    const funded = fundForDay({ split, others }, week);
    let beyondParent;
    if (place.parent !== undefined) {
        const part = groupPartsOf(week.allowancePct, funded.split, funded.others).find((each) => each.id === place.parent);
        const states = (part?.sessions ?? []).flatMap((each) => reading.measured.bySession.get(each) ?? []);
        const usedPct = week.todayWPerPct === undefined || part === undefined ? undefined : wSince(states, week.todayFrom, reading.now) / week.todayWPerPct;
        beyondParent = beyondGroupText(nameOf(place.parent), nameOf(tree.leaderOf(place.parent) ?? tree.lead), part?.budgetPct, usedPct);
    }
    const decision = decideLift({ session: id, group, partPct, stopPct, until, reserve: args.switches.has('reserve'), reason, by, now }, { usedPct: week.usedPct, reset: week.reset, limits: config.budget.lift, liftedPct: place.liftedPct, parent, beyondParent, zone });
    if (decision.kind === 'refused') {
        throw new RefusedError(decision.reason);
    }
    await new LiftLog(runtime.files, kit.paths.lifts).append(decision.lift);
    runtime.out.stdout(`LIFTED ${liftText(decision.lift, name, parent, liftWeekPctOf(week.allowancePct, place.parent, partPct, funded.split, funded.others), zone)}`);
    return EXIT.ok;
}
/**
 * `budget lift <team>/<session>`: the team's lead lifts a session of a team under its own, at any depth, on the same
 * Claude account, by a part of its own team's daily budget (src/budget/lift.ts). It is logged in its own team's lift
 * log, which the lifted team reads beside the other teams on the account, and refused past what its team's other
 * lifts leave of that budget; a group of the team below is not lifted this way.
 */
async function crossTeamLift(runtime, lifting, target, ask) {
    const { kit, config, roster, zone } = lifting;
    const own = kit.paths.team;
    const by = leadOnly(roster, ask.caller, 'lifts a session of a team under its own');
    if (ask.group) {
        throw new UsageError(`--group lifts a sub-lead's group of team ${own}; a session of a team under it is lifted alone`);
    }
    const { tree, teams } = await loadTree(runtime);
    const below = teams.get(target.team);
    if (below === undefined || !tree.ancestorsOf(target.team).includes(own)) {
        throw new RefusedError(`team ${target.team} is not a team under team ${own}`);
    }
    const { account, accounts } = await kitHomeAccountsOf(runtime, teams, { team: own, budget: config.budget });
    if (accounts.get(target.team) !== account) {
        throw new RefusedError(`team ${target.team} is on another Claude account than team ${own}, so team ${own}'s daily budget cannot top its sessions up`);
    }
    const found = below.roster.lookup(target.session);
    if (!found.ok) {
        throw new RefusedError(`on team ${target.team}, ${found.error}`);
    }
    const address = formatAddress({ team: target.team, id: found.id });
    const reading = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
    const { weights: work } = await readWork(runtime.files, kit.paths.events, config.register.priorities, ask.now);
    const split = splitOf(reading, own, roster, config, work);
    const place = crossLiftPlaceOf(split, address);
    const parent = `team ${own}'s daily budget`;
    const decision = decideLift({ session: address, group: false, partPct: ask.partPct, stopPct: ask.stopPct, until: ask.until, reserve: ask.reserve, reason: ask.reason, by, now: ask.now }, { usedPct: reading.week.usedPct, reset: reading.week.reset, limits: config.budget.lift, liftedPct: place.liftedPct, parent, beyondParent: undefined, zone });
    if (decision.kind === 'refused') {
        throw new RefusedError(decision.reason);
    }
    await new LiftLog(runtime.files, kit.paths.lifts).append(decision.lift);
    const others = await otherTeamsOnAccount(runtime, { team: own, config, usageDir: kit.paths.usage }, reading.now, reading.week.usedPct);
    const funded = fundForDay({ split, others }, reading.week);
    const weekPct = liftWeekPctOf(reading.week.allowancePct, undefined, ask.partPct, funded.split, funded.others);
    runtime.out.stdout(`LIFTED ${liftText(decision.lift, `${target.team}/${below.roster.nameOf(found.id) ?? found.id}`, parent, weekPct, zone)}`);
    return EXIT.ok;
}
/**
 * `budget cut <session> [--until <time>] --reason "<text>"`: a leader cuts a session under it, as a lift goes
 * (`sessionRefusalOf`), to its own daily budget for today at most; past it the hooks hold the session whatever room
 * the team has (src/budget/cut.ts). Only its own team's sessions: a team below cuts its own.
 */
export async function cut(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const target = onePositional(args, 'session');
    const reason = requiredFlag(args.flags, 'reason').trim();
    if (reason === '') {
        throw new UsageError('--reason needs a reason');
    }
    const now = runtime.clock.now();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const zone = teamZone(config, runtime);
    const until = timeFlag(args.flags, 'until', { nowMs: now, zone });
    const roster = await rosterOf(runtime, kit, config);
    const address = splitAddress(target);
    if (address?.team !== undefined && address.team !== kit.paths.team) {
        throw new UsageError(`budget cut cuts a session of team ${kit.paths.team}; ${target} is cut by its own team's leaders`);
    }
    const nameOf = (each) => roster.nameOf(each) ?? each;
    const by = sessionIdOf(roster, caller);
    const id = sessionIdOf(roster, address?.session ?? target);
    const refusal = sessionRefusalOf(new LeadTree(config), nameOf, by, id, 'cut');
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    const decision = decideCut({ session: id, until, reason, by, now }, zone);
    if (decision.kind === 'refused') {
        throw new RefusedError(decision.reason);
    }
    await new CutLog(runtime.files, kit.paths.cuts).append(decision.cut);
    runtime.out.stdout(`CUT ${cutText(decision.cut, nameOf(id), zone)}`);
    return EXIT.ok;
}
/** A dollar flag: `--add` above 0, `--spent` 0 or more; undefined when it is not given. */
function usdFlag(flags, name) {
    const text = flags.get(name);
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    const tooSmall = name === 'add' ? value <= 0 : value < 0;
    if (text.trim() === '' || !Number.isFinite(value) || tooSmall) {
        throw new UsageError(`--${name} "${text}" is not a dollar amount ${name === 'add' ? 'above 0' : 'of 0 or more'}`);
    }
    return value;
}
/**
 * `budget extra [--add <usd>] [--spent <usd>]`: the extra-usage pool (budget/extra.ts). An add of the dollars put in
 * the pool, or a reading of the dollars claude.ai shows spent from it so far, is the lead's and goes to the extra log
 * with the week's use and the W metered since the period's start; then, or with no flag, the week line names the pool.
 */
export async function extra(args, runtime) {
    const [stray] = args.positionals;
    if (stray !== undefined) {
        throw new UsageError(`unexpected "${stray}"`);
    }
    const added = usdFlag(args.flags, 'add');
    const spent = usdFlag(args.flags, 'spent');
    const writes = added !== undefined || spent !== undefined;
    const caller = writes ? callerOf(args.flags, runtime.env) : undefined;
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, writes ? 'write' : 'read');
    const roster = await rosterOf(runtime, kit, config);
    if (caller !== undefined) {
        leadOnly(roster, caller, 'enters the extra-usage pool');
        const { week, measured, now, weekPaths } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
        const window = week.window;
        if (window === undefined) {
            throw new RefusedError("the week's period is unknown (no status line reading and no budget.weeklyLimitW), so the entry has no period to belong to");
        }
        const entry = {
            at: now,
            weekPct: week.statusAt === undefined ? undefined : week.usedPct,
            start: window.start,
            end: window.reset,
            w: wSince([...measured.bySession.values(), measured.outside], window.start, now),
        };
        const log = new ExtraLog(runtime.files, weekPaths.extraLog);
        const logged = [];
        if (added !== undefined) {
            await log.append({ ...entry, kind: 'add', usd: added });
            logged.push(`added ${formatUsd(added)} to the pool`);
        }
        if (spent !== undefined) {
            // A reading below the last is read as claude.ai's monthly counter restarting (budget/extra.ts `spentUsdOf`): say
            // so, as a mistyped reading would count the same way.
            const before = lastSpentOf(await log.read());
            await log.append({ ...entry, kind: 'spent', usd: spent });
            const restart = before !== undefined && spent < before.usd
                ? `, below the last reading of ${formatUsd(before.usd)}: read as claude.ai's monthly counter restarting, the ${formatUsd(before.usd)} staying spent`
                : '';
            logged.push(`${formatUsd(spent)} spent from it so far${restart}`);
        }
        runtime.out.stdout(`EXTRA ${logged.join('; ')}.`);
    }
    // Read again after an entry: the pool, and past 100% of the week the team's allowance, now count it.
    const { week } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
    runtime.out.stdout(weekLine(week, teamZone(config, runtime)));
    if (week.pool === undefined) {
        runtime.out.stdout('Extra usage: none in the pool (the lead adds the dollars put in it: teamrig budget extra --add <usd>).');
    }
    return EXIT.ok;
}
/** The status line setup of the team the session works in; outside a team, or with its config unreadable, the kit's default folder and display. */
async function statusLineSetup(runtime, cwd) {
    const fallback = { snapshotDir: defaultSnapshotDir(resolveKitHome(runtime.env, runtime.userHome)), show: DEFAULT_STATUS_LINE, paceSource: undefined, team: undefined };
    const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd === '' ? undefined : cwd, runtime.cwd]));
    if (found.kind !== 'team') {
        return fallback;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return fallback;
    }
    const { config } = kit.load;
    const { budget, statusLine } = config;
    return { snapshotDir: snapshotDirOf(budget, kit.paths), show: statusLine, paceSource: { budget, teamWeekPath: kit.paths.teamWeek }, team: { kit, config } };
}
/** The open meeting's mark for the tab of `claudeSession`; a failed read is told on stderr, never breaking the status bar. */
async function meetingMarkOf(runtime, team, claudeSession) {
    if (team === undefined) {
        return undefined;
    }
    try {
        return await statusLineMeetingFor(runtime, team, claudeSession);
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: the meeting was not read: ${errorMessage(error)}`);
        return undefined;
    }
}
/**
 * Where the team's hooks last said the week resetting at `resetsAt` counts from; undefined with no file, one of another
 * week, or one that names no start. A failed read is told on stderr, never breaking the status bar: it is caught here
 * so it cannot read as a snapshot that was not saved.
 */
async function keptWeekStart(runtime, path, resetsAt) {
    try {
        const kept = await readTeamWeek(runtime.files, path);
        return kept?.resetsAt === resetsAt ? kept.start : undefined;
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: the team's week was not read: ${errorMessage(error)}`);
        return undefined;
    }
}
/**
 * Where the team's pace line stands now in the week the snapshot reads, when the team shows it, from the start its
 * hooks keep, as `teamrig budget` counts: undefined outside a team, with no week reading, or once that week reset. The
 * team's week file is read here and not `accountWeekOn`, which opens every team's config, too much for each tick.
 */
async function pacePctOf(runtime, snapshot, shown) {
    const week = snapshot.rateLimits?.sevenDay ?? null;
    if (!shown.show.pace || shown.paceSource === undefined || week === null) {
        return undefined;
    }
    const { budget, teamWeekPath } = shown.paceSource;
    return paceLineOfWeek(week.resetsAt, budget, runtime.clock.now(), await keptWeekStart(runtime, teamWeekPath, week.resetsAt));
}
/**
 * The session's reading and where the session in `dir` works, as far as `show` asks: git is asked only for a branch
 * it shows, and for the commit only on a detached HEAD.
 */
function statusLineView(git, dir, show, reading) {
    const branch = show.branch ? git.branch(dir) : undefined;
    const commit = show.branch && branch === undefined ? git.head(dir) : undefined;
    return {
        ...(reading.effort === undefined ? {} : { effort: reading.effort }),
        ...(show.folder ? { folder: basename(dir) } : {}),
        ...(branch === undefined ? {} : { branch }),
        ...(commit === undefined ? {} : { commit }),
        ...(reading.pacePct === undefined ? {} : { pacePct: reading.pacePct }),
        ...(reading.meeting === undefined ? {} : { meeting: reading.meeting }),
    };
}
/**
 * Folds the saved snapshot into the folder's summaries (`foldIntoWeekSummary`, `foldIntoFiveHourSummary`); a failure is
 * told on stderr, never breaking the status bar or the other fold.
 */
async function foldQuietly(runtime, dir, snapshot) {
    try {
        await foldIntoWeekSummary(runtime.files, dir, snapshot, runtime.clock.now());
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: the week summary was not updated: ${errorMessage(error)}`);
    }
    try {
        await foldIntoFiveHourSummary(runtime.files, dir, snapshot);
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: the five-hour summary was not updated: ${errorMessage(error)}`);
    }
}
/** Prunes the snapshot folder's old snapshots and left temporaries (`pruneSnapshots`); a failure is told on stderr, never breaking the status bar. */
async function pruneQuietly(runtime, dir) {
    try {
        await pruneSnapshots(runtime.files, dir, runtime.clock.now());
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: old snapshots were not pruned: ${errorMessage(error)}`);
    }
}
/**
 * `statusline`: Claude Code's status line. It saves the status input's reading (the plan's use of the
 * week and its reset) as a snapshot for `budget`, dated by the session's previous snapshot (when the
 * session began to show it, and when it last showed another), folds it into the folder's week summary (the
 * newest reading, which readers open instead of every snapshot) and, on a plan with one, its five-hour window's
 * summary, removes the folder's snapshots written more
 * than 8 days ago (at most one sweep an hour), and prints a short status: the model and its effort level, the
 * session's folder and branch, and the plan's use, the week's beside where the team's pace line stands, as the
 * team's `statusLine` config shows them. It always exits 0, so a bad input or a full disk never breaks the status bar; what
 * went wrong goes to stderr. With --pass it prints the status input again instead of its own status, for
 * the status line after it in a pipe (`statusline install` puts it in front of one already there).
 */
export async function statusline(args, runtime) {
    const [extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const input = await runtime.readStdin();
    const pass = args.switches.has('pass');
    const passed = input.replace(/\r?\n$/, '');
    const snapshot = snapshotOfStatus(input, runtime.clock.now());
    if (snapshot === undefined) {
        runtime.out.stdout(pass ? passed : 'Claude');
        runtime.out.stderr('teamrig statusline: the status input is not Claude Code status JSON with a session id; nothing saved');
        return EXIT.ok;
    }
    let shown = { show: DEFAULT_STATUS_LINE, paceSource: undefined, team: undefined };
    try {
        const setup = await statusLineSetup(runtime, snapshot.cwd);
        shown = setup;
        const path = join(setup.snapshotDir, `${snapshot.sessionId}.json`);
        const previous = await runtime.files.read(path);
        const dated = datedSnapshot(snapshot, previous === undefined ? undefined : parseSnapshot(previous));
        await runtime.files.write(path, formatSnapshot(dated));
        await foldQuietly(runtime, setup.snapshotDir, dated);
        await pruneQuietly(runtime, setup.snapshotDir);
    }
    catch (error) {
        runtime.out.stderr(`teamrig statusline: the snapshot was not saved: ${errorMessage(error)}`);
    }
    if (pass) {
        runtime.out.stdout(passed);
        return EXIT.ok;
    }
    const dir = snapshot.cwd === '' ? runtime.cwd : snapshot.cwd;
    const reading = {
        effort: effortOfStatus(input),
        pacePct: await pacePctOf(runtime, snapshot, shown),
        meeting: await meetingMarkOf(runtime, shown.team, snapshot.sessionId),
    };
    runtime.out.stdout(statusLineText(snapshot, statusLineView(runtime.git, dir, shown.show, reading)));
    return EXIT.ok;
}
