import { resetSummaryLine } from "../../budget/resets.js";
import { LeadTree } from "../../config/lead-tree.js";
import { KIT_NAME } from "../../core/home.js";
import { LockBusyError } from "../../core/lock.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { MeetingSchedule } from "../../meeting/schedule.js";
import { noPositionals } from "../args.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { behindLine, behindMain } from "../behind-main.js";
import { checkLines, ownCheck } from "../reports.js";
import { EXIT } from "../runtime.js";
import { UnownedNotices } from "../unowned-notices.js";
import { unownedNotice } from "../unowned.js";
import { weekLineOf } from "./budget.js";
import { inboxDepsOf, read } from "./inbox.js";
import { startMeetingLine } from "./meetings.js";
import { checkReport, list, waitingReport } from "./register.js";
import { fileLockOf } from "../file-locks.js";
/** The most inbox lines one start posts the lead on warnings no session owns; the rest wait for the next start. */
export const MAX_UNOWNED_NOTICES = 5;
/**
 * `start [--session <id|name>] [--all]`: what a session reads at the start of a work block, in one call: the time on
 * the team's clock, how far its checkout is behind origin's default branch as last fetched (`BEHIND`, only when it
 * lacks commits, T1006), today's and the missed scheduled meetings it is met in or joins (`MEETINGS`, every one for the
 * lead, only when there are some), its unread inbox lines (marked read, which also ties this tab to it, as `inbox read`), its task list (`list
 * --session`), the other sessions' tasks waiting on it (`WAITING ON YOU`, only when some do), the check flags it
 * acts on (the lead's: every flag, as `check`; any other session's: those of the tasks and skills it owns, a sub-lead's
 * also those of its group's tasks) and the
 * week's use (the first line of `budget`), then for the lead the account's resets in stock (T2450). `--all` prints the list and the flags in their long form, as `list
 * --all` and `check --all` do, and every task waiting on it. Any session's start also posts the lead one inbox line on
 * each warning no session owns that the lead was not told of yet (T951), at most MAX_UNOWNED_NOTICES per start; a told
 * warning is told again only after no start saw it for a day.
 */
export async function start(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const id = sessionIdOf(roster, callerOf(args.flags, runtime.env));
    const own = { ...args, flags: new Map([['session', id]]) };
    const zone = teamZone(config, runtime);
    const now = runtime.clock.now();
    const tree = new LeadTree(config);
    runtime.out.stdout(`START ${id}, ${zone.weekdayMinute(new Date(now))}`);
    const behind = behindMain(runtime.mergeGit, runtime.cwd);
    if (behind !== undefined) {
        runtime.out.stdout(behindLine(behind));
    }
    const meetings = startMeetingLine((await new MeetingSchedule(runtime.files, kit.paths.meetings).read()).meetings, zone, now, id, id === tree.lead);
    if (meetings !== undefined) {
        runtime.out.stdout(meetings);
    }
    await read(own, runtime);
    await list(own, runtime);
    (await waitingReport(own, runtime)).forEach((line) => runtime.out.stdout(line));
    const report = await checkReport(own, runtime);
    await tellLead(runtime, kit, config, report);
    checkLines(id === tree.lead ? report : ownCheck(report, id, tree.groupOf(id)), args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    runtime.out.stdout(await weekLineOf(runtime, kit, config, roster));
    const resets = id === tree.lead ? resetSummaryLine(config.budget.resets, now, zone, KIT_NAME) : undefined;
    if (resets !== undefined) {
        runtime.out.stdout(resets);
    }
    return EXIT.ok;
}
/**
 * Posts the lead one inbox line on each warning no session owns that it was not told of yet, so a warning reaches the
 * lead even when the lead does not start. A refused line or a busy lock is a stderr line; the next start tries again.
 */
async function tellLead(runtime, kit, config, report) {
    const { files, clock } = runtime;
    const notices = new UnownedNotices(files, kit.paths.unownedNotices, fileLockOf(runtime, kit.paths.unownedNoticesLock, config.lock));
    const { inboxes } = inboxDepsOf(runtime, kit.paths);
    const secrets = new SecretScanner(config.register.secretPatterns);
    const now = new Date(clock.now());
    try {
        const told = await notices.tell(report.unowned, MAX_UNOWNED_NOTICES, (warning) => postLine(inboxes, secrets, { to: report.lead, from: KIT_NAME, text: unownedNotice(warning), now }), now.getTime());
        told.failed.forEach(({ warning, problem }) => runtime.out.stderr(`WARN ${report.lead} was not told of a warning no session owns (${warning.key}): ${problem}`));
        if (told.posted.length > 0) {
            runtime.out.stderr(`NOTE ${report.lead} has ${told.posted.length} new inbox line(s) on warnings no session owns`);
        }
    }
    catch (error) {
        if (!(error instanceof LockBusyError)) {
            throw error;
        }
        runtime.out.stderr(`WARN ${report.lead} was not told of the warnings no session owns: ${error.message}`);
    }
}
