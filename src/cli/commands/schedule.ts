import { KIT_NAME } from '../../core/home.ts';
import { isMinuteInSpan, utcMinuteOf } from '../../core/time.ts';
import { isScheduleDay, parseScheduledStart, scheduleDayOf, scheduledStartText, startsOn, type ScheduledStart } from '../../wake/schedule.ts';
import { noPositionals, requiredFlag, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { dayScheduleStoreOf } from '../day-schedule.ts';
import { callerOf, listOf } from '../inputs.ts';
import { leadOnly, openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree, type KitTree } from '../tree.ts';

/**
 * The tree's day schedule (src/wake/schedule.ts): `schedule` shows a day's starts, `schedule set` lets the root team's
 * lead write them. A start wakes each idle session of its team (or the one session) once, as `wake.dayStartUtc` does;
 * `none` gives that day no start. A key with no entry up to a day keeps its team's `wake.dayStartUtc`.
 */

/** `--day`, else today (UTC). */
function dayOf(flags: Flags, now: number): string {
  const day = flags.get('day') ?? scheduleDayOf(now);
  if (!isScheduleDay(day)) {
    throw new UsageError(`--day "${day}" is not a day: give YYYY-MM-DD (UTC)`);
  }
  return day;
}

export async function show(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const day = dayOf(args.flags, runtime.clock.now());
  const store = await dayScheduleStoreOf(runtime, { kit, config });
  if (store === undefined) {
    throw new RefusedError(`a team above ${kit.paths.team} has no config that loads: its day schedule cannot be read (${KIT_NAME} doctor names it)`);
  }
  const schedule = await store.read();
  const entries = schedule === undefined ? [] : startsOn(schedule, day);
  if (entries.length === 0) {
    runtime.out.stdout(`SCHEDULE ${day}: none written; each team's wake.dayStartUtc holds`);
    return EXIT.ok;
  }
  runtime.out.stdout(`SCHEDULE ${day} (UTC; a key not listed keeps its team's wake.dayStartUtc):`);
  for (const entry of entries) {
    const repeated = entry.writtenOn === day ? '' : ` (repeats ${entry.writtenOn})`;
    runtime.out.stdout(`  ${entry.key} ${scheduledStartText(entry.start)}${repeated}`);
  }
  return EXIT.ok;
}

/** The key for `team/name` or `team`, with the session given by id or name, checked against the tree. */
function keyOf(loaded: KitTree, root: string, text: string): { readonly key: string; readonly team: string } {
  const [team = '', name, extra] = text.split('/');
  const found = loaded.teams.get(team);
  if (found === undefined || extra !== undefined || !loaded.tree.sameTree(team, root)) {
    throw new RefusedError(`--start "${text}": name a team of this tree, or <team>/<session>`);
  }
  return name === undefined ? { key: team, team } : { key: `${team}/${sessionIdOf(found.roster, name)}`, team };
}

/** Whether `minute` (UTC) falls in the quiet hours from `startUtc` to `endUtc`; none when either is malformed. */
function inQuietHours(minute: number, startUtc: string, endUtc: string): boolean {
  const from = utcMinuteOf(startUtc);
  const to = utcMinuteOf(endUtc);
  return from !== undefined && to !== undefined && from !== to && isMinuteInSpan(minute, from, to);
}

/** The starts `--start` gives: `<key>=HH:MM|none`, comma-separated; a start inside its team's quiet hours is refused. */
function startsOf(loaded: KitTree, root: string, text: string): Map<string, ScheduledStart> {
  const starts = new Map<string, ScheduledStart>();
  for (const item of listOf('--start', text)) {
    const [keyText = '', startText = ''] = item.split('=');
    const start = parseScheduledStart(startText.trim());
    if (start === undefined) {
      throw new UsageError(`--start "${item}": give <team>[/<session>]=HH:MM (UTC) or =none`);
    }
    const { key, team } = keyOf(loaded, root, keyText.trim());
    const quiet = loaded.teams.get(team)?.config.budget.quietHours;
    if (start.kind === 'at' && quiet !== undefined && inQuietHours(start.minute, quiet.startUtc, quiet.endUtc)) {
      throw new RefusedError(`--start "${item}": ${scheduledStartText(start)} is inside ${team}'s quiet hours (${quiet.startUtc}-${quiet.endUtc} UTC), when no day start wakes anyone`);
    }
    starts.set(key, start);
  }
  return starts;
}

export async function set(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  leadOnly(roster, caller, "writes the tree's day schedule");
  if (config.team?.parent !== undefined) {
    throw new RefusedError(`the day schedule is the root team's: ${kit.paths.team} sits under ${config.team.parent}, whose lead writes it`);
  }
  const now = runtime.clock.now();
  const day = dayOf(args.flags, now);
  if (day < scheduleDayOf(now)) {
    throw new RefusedError(`--day ${day} is past: write today or a later day`);
  }
  const starts = startsOf(await loadTree(runtime), kit.paths.team, requiredFlag(args.flags, 'start'));
  const store = await dayScheduleStoreOf(runtime, { kit, config });
  if (store === undefined) {
    throw new RefusedError(`the day schedule of ${kit.paths.team} cannot be opened`);
  }
  const written = await store.write(day, starts);
  runtime.out.stdout(`SCHEDULED ${day} (UTC): ${[...starts].map(([key, start]) => `${key} ${scheduledStartText(start)}`).join(', ')}`);
  runtime.out.stdout(`  each start wakes its idle sessions once; later days repeat it until one is written (${written.days.size} day(s) kept)`);
  return EXIT.ok;
}
