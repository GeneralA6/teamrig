import { LeadTree } from '../../config/lead-tree.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { LockBusyError } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import { MeetingSchedule } from '../../meeting/schedule.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { behindLine, behindMain } from '../behind-main.ts';
import { checkLines, ownCheck, type CheckReport } from '../reports.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { UnownedNotices } from '../unowned-notices.ts';
import { unownedNotice } from '../unowned.ts';
import { weekLineOf } from './budget.ts';
import { inboxDepsOf, read } from './inbox.ts';
import { startMeetingLine } from './meetings.ts';
import { checkReport, list, waitingReport } from './register.ts';
import { fileLockOf } from '../file-locks.ts';

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
 * week's use (the first line of `budget`). `--all` prints the list and the flags in their long form, as `list
 * --all` and `check --all` do, and every task waiting on it. Any session's start also posts the lead one inbox line on
 * each warning no session owns that the lead was not told of yet (T951), at most MAX_UNOWNED_NOTICES per start; a told
 * warning is told again only after no start saw it for a day.
 */
export async function start(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, callerOf(args.flags, runtime.env));
  const own: ParsedArgs = { ...args, flags: new Map([['session', id]]) };
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
  return EXIT.ok;
}

/**
 * Posts the lead one inbox line on each warning no session owns that it was not told of yet, so a warning reaches the
 * lead even when the lead does not start. A refused line or a busy lock is a stderr line; the next start tries again.
 */
async function tellLead(runtime: CliRuntime, kit: Kit, config: KitConfig, report: CheckReport): Promise<void> {
  const { files, clock } = runtime;
  const notices = new UnownedNotices(files, kit.paths.unownedNotices, fileLockOf(runtime, kit.paths.unownedNoticesLock, config.lock));
  const { inboxes } = inboxDepsOf(runtime, kit.paths);
  const secrets = new SecretScanner(config.register.secretPatterns);
  const now = new Date(clock.now());
  try {
    const told = await notices.tell(
      report.unowned,
      MAX_UNOWNED_NOTICES,
      (warning) => postLine(inboxes, secrets, { to: report.lead, from: KIT_NAME, text: unownedNotice(warning), now }),
      now.getTime(),
    );
    told.failed.forEach(({ warning, problem }) => runtime.out.stderr(`WARN ${report.lead} was not told of a warning no session owns (${warning.key}): ${problem}`));
    if (told.posted.length > 0) {
      runtime.out.stderr(`NOTE ${report.lead} has ${told.posted.length} new inbox line(s) on warnings no session owns`);
    }
  } catch (error) {
    if (!(error instanceof LockBusyError)) {
      throw error;
    }
    runtime.out.stderr(`WARN ${report.lead} was not told of the warnings no session owns: ${error.message}`);
  }
}
