import { formatWeekdayMinute } from '../../budget/format.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { checkLines, ownCheck } from '../reports.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { weekLineOf } from './budget.ts';
import { read } from './inbox.ts';
import { checkReport, list, waitingReport } from './register.ts';

/**
 * `start [--session <id|name>] [--all]`: what a session reads at the start of a work block, in one call: the UTC
 * time, its unread inbox lines (marked read, which also ties this tab to it, as `inbox read`), its task list (`list
 * --session`), the other sessions' tasks waiting on it (`WAITING ON YOU`, only when some do), the check flags it
 * acts on (the lead's: every flag, as `check`; any other session's: those of the tasks and skills it owns) and the
 * week's use (the first line of `budget`). `--all` prints the list and the flags in their long form, as `list
 * --all` and `check --all` do, and every task waiting on it.
 */
export async function start(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, callerOf(args.flags, runtime.env));
  const own: ParsedArgs = { ...args, flags: new Map([['session', id]]) };
  runtime.out.stdout(`START ${id}, ${formatWeekdayMinute(runtime.clock.now())}`);
  await read(own, runtime);
  await list(own, runtime);
  (await waitingReport(own, runtime)).forEach((line) => runtime.out.stdout(line));
  const report = await checkReport(own, runtime);
  checkLines(id === config.roles.lead ? report : ownCheck(report, id), args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
  runtime.out.stdout(await weekLineOf(runtime, kit, config, roster));
  return EXIT.ok;
}
