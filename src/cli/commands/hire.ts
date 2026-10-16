import { describeLaunch } from '../../config/launch.ts';
import { formatConfig, writeConfigWithBackup } from '../../config/load.ts';
import type { Roster } from '../../config/roster.ts';
import { parseConfigText } from '../../config/text.ts';
import { describeNameClash, teamNodeOf } from '../../config/tree.ts';
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel, type KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { activeHires, HiringLog } from '../../hiring/log.ts';
import { planHire, type HireRequest } from '../../hiring/plan.ts';
import { onePositional, requiredFlag, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { configFileJson, issueText, openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { pctFlag } from './budget.ts';

/**
 * `hire`: the lead adds a temporary session to the team within `hiring`'s policy and caps. Without
 * --yes it only shows the hire; with it, the old config is kept in the backups folder, the hire is
 * logged in the hire log, then the session, its launch and its daily budget are written to the config.
 */

/** The backup name of a config before `hire` changed it. */
export const HIRE_BACKUP_NAME = 'config.hire';

function effortFlag(flags: Flags): EffortLevel | undefined {
  const text = flags.get('effort');
  if (text !== undefined && !isEffortLevel(text)) {
    throw new UsageError(`--effort "${text}" is not one of ${EFFORT_LEVELS.join(', ')}`);
  }
  return text;
}

/** The request the command line makes, by the caller, at the clock's now. */
function requestOf(args: ParsedArgs, runtime: CliRuntime, by: string): HireRequest {
  const { flags } = args;
  const name = flags.get('name');
  const model = flags.get('model');
  const reviewBy = flags.get('review');
  const approvedBy = flags.get('approved-by');
  const effort = effortFlag(flags);
  const dailyPct = pctFlag(flags, 'daily-pct');
  return {
    id: onePositional(args, 'id'),
    scope: requiredFlag(flags, 'scope'),
    reason: requiredFlag(flags, 'reason'),
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(reviewBy === undefined ? {} : { reviewBy }),
    ...(approvedBy === undefined ? {} : { approvedBy }),
    ...(effort === undefined ? {} : { effort }),
    ...(dailyPct === undefined ? {} : { dailyPct }),
    by,
    now: runtime.clock.now(),
  };
}

/** Refuses a name another team's session already has: Claude Code session names are machine-wide. */
async function refuseNameClash(runtime: CliRuntime, team: string, id: string, next: KitConfig, roster: Roster): Promise<void> {
  const { tree } = await loadTree(runtime);
  const clash = tree
    .with(teamNodeOf(team, next, roster))
    .nameClashesOf(team)
    .find((found) => found.holders.some((holder) => holder.team === team && holder.id === id));
  if (clash !== undefined) {
    throw new RefusedError(`nothing written: ${describeNameClash(clash, KIT_NAME)}`);
  }
}

/** `hire <id> --scope "<its job>" --reason "<why>" [--name] [--model] [--effort] [--daily-pct] [--review] [--approved-by] [--yes]`. */
export async function hire(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const lead = roster.holderOf('lead');
  const by = sessionIdOf(roster, caller);
  if (by !== lead) {
    throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} hires sessions`);
  }
  const request = requestOf(args, runtime, by);
  const { files, clock, sleep, pid } = runtime;
  const { load } = kit;
  const log = new HiringLog(files, kit.paths.hires);
  const mutex = new FileLock(kit.paths.hiresLock, config.lock, { files, clock, sleep, pid });
  return mutex.run(async () => {
    const { records, skipped } = await log.read();
    const plan = planHire(await configFileJson(runtime, load.path), config, activeHires(records), request);
    if (!plan.ok) {
      throw new RefusedError(plan.problem);
    }
    const next = parseConfigText(formatConfig(plan.value.config));
    if (next.status !== 'loaded') {
      throw new RefusedError(`the new config cannot be read: ${issueText(next.issue)}`);
    }
    const [problem] = next.issues;
    if (problem !== undefined) {
      throw new RefusedError(`nothing written: ${issueText(problem)}`);
    }
    const nextRoster = await rosterOf(runtime, kit, next.config);
    await refuseNameClash(runtime, kit.paths.team, request.id, next.config, nextRoster);
    const { hire: record, hired, hiredDailyPct } = plan.value;
    const what = `${record.session} (name ${nextRoster.nameOf(record.session) ?? record.session}) for "${record.scope}": ${describeLaunch(record)}, ${record.dailyPct}% of the week a day, review by ${record.reviewBy}`;
    const caps = `  hired sessions with it: ${hired} of ${config.hiring.maxSessions}, ${hiredDailyPct}% of ${config.hiring.maxDailyPct}% of the week a day`;
    if (skipped > 0) {
      runtime.out.stdout(`NOTE ${skipped} damaged or newer line(s) in ${log.path} were skipped, so the caps may count too few hires`);
    }
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW hire ${what}; nothing written (add --yes to write)`);
      runtime.out.stdout(caps);
      return EXIT.ok;
    }
    // The log first: a hire logged for a session the config does not hold counts toward no cap.
    await log.append(record);
    const backup = await writeConfigWithBackup(files, { configPath: load.path, backupsDir: kit.paths.backups, backupName: HIRE_BACKUP_NAME }, plan.value.config, clock);
    runtime.out.stdout(`HIRED ${what}; the old config is at ${backup}`);
    runtime.out.stdout(caps);
    runtime.out.stdout(`NEXT give it its first task: ${KIT_NAME} add --owner ${record.session} --title "<task>" --session ${by}; then open it: ${KIT_NAME} open ${record.session}`);
    return EXIT.ok;
  });
}
