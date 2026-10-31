import { describeLaunch } from '../../config/launch.ts';
import type { Roster } from '../../config/roster.ts';
import { describeNameClash, teamNodeOf } from '../../config/tree.ts';
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel, type IdleMode, type KitConfig } from '../../config/types.ts';
import { activeBurst } from '../../budget/burst.ts';
import { KIT_NAME } from '../../core/home.ts';
import { burstHireOf } from '../../hiring/burst-hire.ts';
import { planKeep } from '../../hiring/keep.ts';
import { HiringLog } from '../../hiring/log.ts';
import { activeHires, retiredSessions, type HireRecord, type RetireRecord } from '../../hiring/record.ts';
import { hirerProblem, planHire, type HireRequest } from '../../hiring/plan.ts';
import type { ResumeVerdict } from '../../hiring/rehire.ts';
import type { TimeZone } from '../../core/zone.ts';
import { noRoomText } from '../../sessions/headroom.ts';
import { homeCloseOf, SessionLog } from '../../sessions/log.ts';
import { onePositional, requiredFlag, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { readBursts } from '../burst-reading.ts';
import { headroomOf } from '../headroom.ts';
import { callerOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, configLockOf, findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { freshOpenOf, resumeVerdictOf } from './rehire.ts';
import { sessionProjectOf } from './setup.ts';

/**
 * `hire`: a lead adds a worker it is sure the team needs within `hiring`'s policy: the team's lead, or a
 * sub-lead, whose hire joins its own group (T509). Without
 * --yes it only shows the hire; with it, the old config is kept in the backups folder, the hire is
 * logged in the hire log, then the session and its launch are written to the config. A hire gets no fixed daily
 * budget: its part of the team's follows its share and queued work, like any session's.
 * A retired id is hired back: it shows the retire and its handover, and whether its last Claude Code session
 * can be resumed (`open --resume`) or it opens fresh on that handover. With --burst it is a hire for the burst in
 * force, within the burst's hires and on the lead's model and effort (src/hiring/burst-hire.ts).
 * With no room on the host for one more session (`open.headroom`) it is hired home (T1364): a home close in the session
 * log (src/sessions/log.ts) keeps it closed until the idle pass opens it once it has work and the host has room, or
 * `open` does; the preview says so.
 * On a hired session already on the team, `--review <day> --reason` keeps it to that new review day instead, which
 * clears its REVIEW-DUE (src/hiring/keep.ts): only the hire log changes, so it takes no room check.
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
function requestOf(args: ParsedArgs, runtime: CliRuntime, id: string, by: string): HireRequest {
  const { flags } = args;
  const name = flags.get('name');
  const model = flags.get('model');
  const reviewBy = flags.get('review');
  const approvedBy = flags.get('approved-by');
  const effort = effortFlag(flags);
  return {
    id,
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
    return `open it: ${fresh}`;
  }
  if (rehire.verdict.kind === 'resume') {
    return `resume its last Claude Code session: ${fresh} --resume, or ${freshOpenOf(rehire.from)}: ${fresh}`;
  }
  return `${freshOpenOf(rehire.from)}: ${fresh}`;
}

/** When it opens: now, or, hired home, once the host has room, by the idle pass when it is on and work is handed to it. */
function whenOpensOf(id: string, rehire: Rehire | undefined, home: boolean, idle: IdleMode): string {
  const step = openStepOf(id, rehire);
  if (!home) {
    return `then ${step}`;
  }
  const byHand = `once the host has room, ${step}`;
  return idle === 'on' ? `the idle pass opens it once it has work and the host has room; or, ${byHand}` : byHand;
}

/** The flags a keep refuses: it changes only the review day, the job and launch stay as hired. */
const HIRE_ONLY_FLAGS = ['scope', 'name', 'model', 'effort', 'approved-by'] as const;

/** `hire <id> --review <YYYY-MM-DD> --reason "<why>" [--yes]` on a session already on the team: keep its hire. */
async function keep(args: ParsedArgs, runtime: CliRuntime, kit: Kit, config: KitConfig, id: string, by: string): Promise<ExitCode> {
  const { flags } = args;
  const reviewBy = flags.get('review');
  if (reviewBy === undefined) {
    throw new RefusedError(`${id} is already on the team: a hired session is kept with --review <YYYY-MM-DD> --reason "<why>"`);
  }
  const extra = HIRE_ONLY_FLAGS.find((flag) => flags.has(flag)) ?? (args.switches.has('burst') ? 'burst' : undefined);
  if (extra !== undefined) {
    throw new UsageError(`--${extra}: a keep of ${id} changes only its review day`);
  }
  const reason = requiredFlag(flags, 'reason');
  const { files, clock } = runtime;
  const log = new HiringLog(files, kit.paths.hires);
  return configLockOf(runtime, kit, config).run(async () => {
    const { records, skipped } = await log.read();
    const plan = planKeep(config, activeHires(records), { id, reviewBy, reason, by, now: clock.now() });
    if (!plan.ok) {
      throw new RefusedError(plan.problem);
    }
    const { keep: record, hire: kept } = plan.value;
    const what = `${id} on the team, review by ${record.reviewBy} (was ${kept.reviewBy})`;
    if (skipped > 0) {
      runtime.out.stdout(`NOTE ${skipped} damaged or newer line(s) in ${log.path} were skipped, so its review day may read older than logged`);
    }
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW keep ${what}: "${record.reason}"; nothing written (add --yes to write)`);
      return EXIT.ok;
    }
    await log.append(record);
    runtime.out.stdout(`KEPT ${what}`);
    return EXIT.ok;
  });
}

/**
 * `hire <id> --scope "<its job>" --reason "<why>" [--name] [--model] [--effort] [--review] [--approved-by] [--burst] [--yes]`;
 * on a session already on the team, a keep.
 */
export async function hire(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const by = sessionIdOf(roster, caller);
  const id = onePositional(args, 'id');
  if (config.sessions.includes(id)) {
    return keep(args, runtime, kit, config, id, by);
  }
  const refusal = hirerProblem(config, by);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
  const asked = requestOf(args, runtime, id, by);
  // Outside the hire lock: listing the host's processes takes about a second.
  const headroom = await headroomOf(runtime, kit.paths, config, roster.ids);
  const { files, clock } = runtime;
  const { load } = kit;
  const log = new HiringLog(files, kit.paths.hires);
  return configLockOf(runtime, kit, config).run(async (writer) => {
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
    const home = headroom.short.length > 0;
    const noRoom = noRoomText(`open ${request.id}`, headroom);
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW hire ${what}; nothing written (add --yes to write)`);
      rehireText.forEach((line) => runtime.out.stdout(line));
      if (home) {
        runtime.out.stdout(`NOTE ${noRoom}; with --yes it is hired home, closed until there is room`);
      }
      return EXIT.ok;
    }
    // The log first: a hire logged for a session the config does not hold counts toward no burst's hires.
    await log.append(record);
    const backup = await writer.write(plan.value.config, HIRE_BACKUP_NAME);
    // After the config: a home close of a session the config does not hold keeps nothing closed.
    if (home) {
      await new SessionLog(files, kit.paths.sessionLog).append(homeCloseOf(record.session, by, new Date(request.now).toISOString()));
    }
    runtime.out.stdout(`HIRED ${what}${home ? ', home until the host has room' : ''}; the old config is at ${backup}`);
    rehireText.forEach((line) => runtime.out.stdout(line));
    if (home) {
      runtime.out.stdout(`NOTE ${noRoom}`);
    }
    const opens = whenOpensOf(record.session, rehire, home, config.open.idle.mode);
    runtime.out.stdout(`NEXT give it its first task: ${KIT_NAME} add --owner ${record.session} --title "<task>" --description "<what and why>" --session ${by}; ${opens}`);
    return EXIT.ok;
  });
}
