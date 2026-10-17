import { formatWeekdayMinute } from "../../budget/format.js";
import { noPositionals } from "../args.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { checkLines, ownCheck } from "../reports.js";
import { EXIT } from "../runtime.js";
import { weekLineOf } from "./budget.js";
import { read } from "./inbox.js";
import { checkReport, list, waitingReport } from "./register.js";
/**
 * `start [--session <id|name>] [--all]`: what a session reads at the start of a work block, in one call: the UTC
 * time, its unread inbox lines (marked read, which also ties this tab to it, as `inbox read`), its task list (`list
 * --session`), the other sessions' tasks waiting on it (`WAITING ON YOU`, only when some do), the check flags it
 * acts on (the lead's: every flag, as `check`; any other session's: those of the tasks and skills it owns) and the
 * week's use (the first line of `budget`). `--all` prints the list and the flags in their long form, as `list
 * --all` and `check --all` do, and every task waiting on it.
 */
export async function start(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const id = sessionIdOf(roster, callerOf(args.flags, runtime.env));
    const own = { ...args, flags: new Map([['session', id]]) };
    runtime.out.stdout(`START ${id}, ${formatWeekdayMinute(runtime.clock.now())}`);
    await read(own, runtime);
    await list(own, runtime);
    (await waitingReport(own, runtime)).forEach((line) => runtime.out.stdout(line));
    const report = await checkReport(own, runtime);
    checkLines(id === config.roles.lead ? report : ownCheck(report, id), args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    runtime.out.stdout(await weekLineOf(runtime, kit, config, roster));
    return EXIT.ok;
}
