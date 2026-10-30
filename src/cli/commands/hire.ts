import { describeLaunch } from '../../config/launch.ts';
import { writeConfigWithBackup } from '../../config/load.ts';
import type { Roster } from '../../config/roster.ts';
import { describeNameClash, teamNodeOf } from '../../config/tree.ts';
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel, type KitConfig } from '../../config/types.ts';
import { activeBurst } from '../../budget/burst.ts';
import { KIT_NAME } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { burstHireOf } from '../../hiring/burst-hire.ts';
import { HiringLog } from '../../hiring/log.ts';
import { activeHires, retiredSessions, type HireRecord, type RetireRecord } from '../../hiring/record.ts';
import { hirerProblem, planHire, type HireRequest } from '../../hiring/plan.ts';
import type { ResumeVerdict } from '../../hiring/rehire.ts';
import type { TimeZone } from '../../core/zone.ts';
import { noRoomText } from '../../sessions/headroom.ts';
import { onePositional, requiredFlag, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { readBursts } from '../burst-reading.ts';
import { headroomOf } from '../headroom.ts';
import { callerOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { freshOpenOf, resumeVerdictOf } from './rehire.ts';
import { sessionProjectOf } from './setup.ts';

/**
 * `hire`: a lead adds a temporary session to the team within `hiring`'s policy: the team's lead, or a
 * sub-lead, whose hire joins its own group (T509). Without
 * --yes it only shows the hire; with it, the old config is kept in the backups folder, the hire is
 * logged in the hire log, then the session and its launch are written to the config. A hire gets no fixed daily
 * budget: its part of the team's follows its share and queued work, like any session's.
 * A retired id is hired back: it shows the retire and its handover, and whether its last Claude Code session
 * can be resumed (`open --resume`) or it opens fresh on that handover. With --burst it is a hire for the burst in
 * force, within the burst's hires and on the lead's model and effort (src/hiring/burst-hire.ts).
 * With --yes it refuses when the host has no room for one more session (`open.headroom`); the preview says so.
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
  return {
    id: onePositional(args, 'id'),
    scope: requiredFlag(flags, 'scope'),
    reason: requiredFlag(flags, 'reason'),
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(reviewBy === undefined ? {} : { reviewBy }),
    ...(approvedBy === undefined ? {} : { approvedBy }),
    ...(effort === undefined ? {} : { effort }),
    by,
    now: runtime.clock.now(),
  };
}

/** The request tied to the burst in force, for `hire --burst`; refused when the burst takes no such hire. */
async function burstRequestOf(runtime: CliRuntime, kit: Kit, config: KitConfig, request: HireRequest, active: readonly HireRecord[]): Promise<HireRequest> {
  const { records, usedPct } = await readBursts(runtime, kit.paths, config.budget, request.now);
  const checked = burstHireOf(request, activeBurst(records, request.now, usedPct), active, config);
  if (!checked.ok) {
    throw new RefusedError(checked.problem);
  }
  return checked.value;
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

/** A hire of a retired id: the retire it comes back from and whether its last Claude Code session resumes. */
interface Rehire {
  readonly from: RetireRecord;
  readonly verdict: ResumeVerdict;
}

/** A rehire's lines: the retire it comes back from (its day on the team's clock), its handover, and whether its last Claude Code session resumes. */
function rehireLines({ from, verdict }: Rehire, zone: TimeZone): string[] {
  const left = from.handover === undefined ? `it left no handover${from.noHandover === undefined ? '' : `: ${from.noHandover}`}` : `its handover: ${from.handover}`;
  const resume = verdict.kind === 'resume' ? `its last Claude Code session can be resumed: ${verdict.detail}` : `it opens fresh (not resumed: ${verdict.detail})`;
  return [`REHIRE ${from.session} retired ${zone.day(new Date(from.at))} (${from.reason}); ${left}`, `  ${resume}`];
}

/** How to open the session once hired: a rehire resumes or opens fresh, as measured. */
function openStepOf(id: string, rehire: Rehire | undefined): string {
  const fresh = `${KIT_NAME} open ${id}`;
  if (rehire === undefined) {
    return `then open it: ${fresh}`;
  }
  if (rehire.verdict.kind === 'resume') {
    return `then resume its last Claude Code session: ${fresh} --resume, or ${freshOpenOf(rehire.from)}: ${fresh}`;
  }
  return `then ${freshOpenOf(rehire.from)}: ${fresh}`;
}

/** `hire <id> --scope "<its job>" --reason "<why>" [--name] [--model] [--effort] [--review] [--approved-by] [--burst] [--yes]`. */
export async function hire(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const by = sessionIdOf(roster, caller);
  const refusal = hirerProblem(config, by);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
  const asked = requestOf(args, runtime, by);
  // Outside the hire lock: listing the host's processes takes about a second.
  const headroom = await headroomOf(runtime, kit.paths, config, roster.ids);
  const { files, clock, sleep, pid } = runtime;
  const { load } = kit;
  const log = new HiringLog(files, kit.paths.hires);
  const mutex = new FileLock(kit.paths.hiresLock, config.lock, { files, clock, sleep, pid });
  return mutex.run(async () => {
    const { records, skipped } = await log.read();
    const active = activeHires(records);
    const request = args.switches.has('burst') ? await burstRequestOf(runtime, kit, config, asked, active) : asked;
    const plan = planHire(await configFileJson(runtime, load.path), config, request);
    if (!plan.ok) {
      throw new RefusedError(plan.problem);
    }
    const next = checkedNextConfig(plan.value.config);
    const nextRoster = await rosterOf(runtime, kit, next);
    await refuseNameClash(runtime, kit.paths.team, request.id, next, nextRoster);
    const { hire: record, leader } = plan.value;
    const ledBy = leader === config.roles.lead ? '' : `, led by ${nextRoster.nameOf(leader) ?? leader}`;
    const what = `${record.session} (name ${nextRoster.nameOf(record.session) ?? record.session}) for "${record.scope}"${ledBy}: ${describeLaunch(record)}, review by ${record.reviewBy}${record.burst === undefined ? '' : `, for the burst started ${teamZone(config, runtime).weekdayMinute(new Date(record.burst))}`}`;
    const from = retiredSessions(records).find((record) => record.session === request.id);
    // Measured before anything is written, so the preview shows it too.
    const rehire: Rehire | undefined =
      from === undefined ? undefined : { from, verdict: await resumeVerdictOf(runtime, kit.paths, config.hiring, request.id, await sessionProjectOf(runtime, config, request.id, undefined, found.from)) };
    const rehireText = rehire === undefined ? [] : rehireLines(rehire, teamZone(config, runtime));
    if (skipped > 0) {
      runtime.out.stdout(`NOTE ${skipped} damaged or newer line(s) in ${log.path} were skipped, so a burst's hires may count too few`);
    }
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW hire ${what}; nothing written (add --yes to write)`);
      rehireText.forEach((line) => runtime.out.stdout(line));
      if (headroom.short.length > 0) {
        runtime.out.stdout(`NOTE ${noRoomText(`hire ${request.id}`, headroom)}; --yes refuses until there is room`);
      }
      return EXIT.ok;
    }
    if (headroom.short.length > 0) {
      throw new RefusedError(noRoomText(`hire ${request.id}`, headroom));
    }
    // The log first: a hire logged for a session the config does not hold counts toward no burst's hires.
    await log.append(record);
    const backup = await writeConfigWithBackup(files, { configPath: load.path, backupsDir: kit.paths.backups, backupName: HIRE_BACKUP_NAME }, plan.value.config, clock);
    runtime.out.stdout(`HIRED ${what}; the old config is at ${backup}`);
    rehireText.forEach((line) => runtime.out.stdout(line));
    runtime.out.stdout(`NEXT give it its first task: ${KIT_NAME} add --owner ${record.session} --title "<task>" --description "<what and why>" --session ${by}; ${openStepOf(record.session, rehire)}`);
    return EXIT.ok;
  });
}
