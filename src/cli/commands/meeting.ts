import { join } from 'node:path';
import { resetSummaryLine } from '../../budget/resets.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { deliveryPlaces } from '../../delivery/places.ts';
import { formatAddress } from '../../core/address.ts';
import { sessionDisplay } from '../../core/ids.ts';
import { KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { postLine } from '../../inbox/inbox.ts';
import { agendaLines, agendaSince } from '../../meeting/agenda.ts';
import { mergeDigestLines, type MergeDigestInput, type MergeLogAt } from '../../meeting/merges.ts';
import { decisionsByOwner, endNotice, type NoticeFacts } from '../../meeting/notices.ts';
import { MeetingSchedule } from '../../meeting/schedule.ts';
import { spotlightLine, startSpotlight, type SpotlightPlace } from '../../meeting/spotlight.ts';
import { MeetingStore, phaseOf, stoppedAt, type Meeting, type MeetingPhase } from '../../meeting/state.ts';
import { MergeLog } from '../../merge/merge-log.ts';
import { goalScores, type BoardTeam, type GoalScore } from '../../register/goal-board.ts';
import type { Goal } from '../../register/goals.ts';
import type { StatsRange } from '../../register/stats.ts';
import { currentWeekOf } from '../../register/week.ts';
import { fitLines } from '../../register/fit.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { readRunFiles } from '../hand-step-file.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Access, type Kit } from '../kit.ts';
import { subtreeOf, type RolledTeam, type RollUp } from '../roll-up.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { KitTreeGoals } from '../tree-goals.ts';
import { loadTree, type KitTree } from '../tree.ts';
import { weekLineOf } from './budget.ts';
import { inboxDepsOf, read } from './inbox.ts';
import { decidedByOf, decisionAgendaOf } from './meeting-registers.ts';
import { agendaMeetingLines, meetingEndScheduled, meetingStartScheduled } from './meetings.ts';
import { taskTreeOf, weekFitOf } from './register.ts';
import { foldStats, statsTopLines } from './stats.ts';

/**
 * `meeting start|agenda|end`: the owner's daily meeting with the lead, the lead's only. `start` opens it, which
 * holds every message to the lead but a CRITICAL one (the cold-send hook tells each sender when it holds one, so no
 * session is told), and prints the agenda; `agenda` prints it again, or before a meeting; `end` closes it and tells
 * each session with a decision the lead recorded on its tasks, by one inbox line, and no other. The agenda is
 * gathered in one call: the goal scoreboard, the owner's decisions as card facts, the incidents, the late tasks, what
 * finished since the meeting before, the stats' Health and flow lines, the lead's inbox (marked read) and the week's
 * use and fit to the limit. Only a root team's lead holds it: its goals, stats, decisions and end's lines cover every
 * team under the lead's too (T1018).
 */

interface MeetingKit {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly lead: string;
  readonly leadName: string;
  readonly store: MeetingStore;
  readonly now: number;
  /** The team's clock, which the meeting's lines and notices print on. */
  readonly zone: TimeZone;
  /** Every team of the kit home: the lead's is a root team, whose subtree's waits on the owner the lead asks. */
  readonly kitTree: KitTree;
}

/**
 * The caller's team, refused unless the caller is its lead and the team a root team: the meeting is the lead's with the
 * owner, and a child team's waits on the owner go up to the lead at its tree's root, whose agenda lists them (T509).
 */
async function meetingKit(args: ParsedArgs, runtime: CliRuntime, access: Access): Promise<MeetingKit> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, access);
  const roster = await rosterOf(runtime, kit, config);
  const caller = sessionIdOf(roster, callerOf(args.flags, runtime.env));
  // A config that fails to load its lead still reads (an agenda), and names none on the roster.
  const holder = roster.holderOf('lead');
  const lead = holder !== undefined && roster.ids.includes(holder) ? holder : undefined;
  if (lead === undefined || caller !== lead) {
    throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} runs the owner's daily meeting`);
  }
  const team = kit.paths.team;
  const kitTree = await loadTree(runtime);
  const above = kitTree.tree.ownerLeadAbove(team);
  if (above !== undefined) {
    throw new RefusedError(`team ${team} meets no owner: the owner's daily meeting is ${formatAddress(above)}'s, whose agenda lists ${team}'s waits on the owner`);
  }
  const store = new MeetingStore(runtime.files, kit.paths.meeting);
  return { kit, config, roster, lead, leadName: roster.nameOf(lead) ?? lead, store, now: runtime.clock.now(), zone: teamZone(config, runtime), kitTree };
}

/** The registers of the lead's team and of every team under it, depth first, its own first (subtreeOf). */
async function meetingRegisters(runtime: CliRuntime, mk: MeetingKit): Promise<RollUp> {
  return subtreeOf(runtime, { kit: mk.kit, config: mk.config, roster: mk.roster }, mk.kitTree);
}

/** The decisions recorded on a register's tasks: by the lead in its own team, by its `<team>/<id>` in a team under it (`update web/T2 --note`). */
interface Decided {
  readonly rolled: RolledTeam;
  /** The register's team when it is one under the lead's; undefined for the lead's own. */
  readonly below: string | undefined;
  /** The decision lines, by the session that owns each task now. */
  readonly byOwner: ReadonlyMap<string, readonly string[]>;
}

/** How the lead's end lines name a session of the register: by its id in the lead's own team, by `<team>/<id>` in another. */
function sessionLabel({ below }: Decided, session: string): string {
  return below === undefined ? session : formatAddress({ team: below, id: session });
}

/**
 * One inbox line to each session on the register's roster with decisions recorded on its tasks, and none to the rest;
 * prints a line for each it could not post to, and returns how many it told. A team under the lead's gets them from
 * the lead's `<team>/<id>`, scanned with both teams' secret patterns, as a line to another team is.
 */
async function tellDecided(runtime: CliRuntime, mk: MeetingKit, decided: Decided): Promise<number> {
  const { rolled, below, byOwner } = decided;
  const { inboxes } = inboxDepsOf(runtime, rolled.paths);
  const patterns = below === undefined ? mk.config.register.secretPatterns : [...mk.config.register.secretPatterns, ...rolled.config.register.secretPatterns];
  const secrets = new SecretScanner(patterns);
  const from = below === undefined ? mk.lead : formatAddress({ team: mk.kit.paths.team, id: mk.lead });
  const facts: NoticeFacts = { leadName: mk.leadName, at: mk.now, zone: mk.zone };
  let told = 0;
  for (const session of rolled.roster.ids) {
    const decisions = byOwner.get(session);
    if (from === session || decisions === undefined) {
      continue;
    }
    const problem = await postLine(inboxes, secrets, { to: session, from, text: endNotice(facts, decisions), now: new Date(mk.now) });
    if (problem === undefined) {
      told += 1;
    } else {
      runtime.out.stdout(`NOT TOLD ${sessionLabel(decided, session)}: ${problem}`);
    }
  }
  return told;
}

/** When the meeting before the open one or the next one stopped, from which the agenda counts the finished work. */
function previousEnd(phase: MeetingPhase): number | undefined {
  if (phase.kind !== 'open') {
    return stoppedAt(phase);
  }
  return phase.meeting.since === null ? undefined : Date.parse(phase.meeting.since);
}

function phaseLine(phase: MeetingPhase, mk: MeetingKit): string {
  switch (phase.kind) {
    case 'none':
      return `MEETING none held yet; the agenda for the first (${KIT_NAME} meeting start opens it)`;
    case 'open':
      return `MEETING open since ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))}: messages to ${mk.leadName} are held but CRITICAL ones`;
    case 'lapsed':
      return `MEETING the one started ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))} was never ended and holds no message since ${mk.zone.weekdayMinute(new Date(phase.until))}; ${KIT_NAME} meeting end tells each session the decisions on its tasks`;
    case 'closed':
      return `MEETING none open, the last ended ${mk.zone.weekdayMinute(new Date(phase.until))}; the agenda for the next (${KIT_NAME} meeting start opens it)`;
  }
}

/**
 * The self-merges digest's input, from the agenda's start: the lead's team's merges log, then each other log of a team
 * under it (T2457), each path read once, as teams sharing a `delivery.dir` share its log.
 */
async function mergeDigestOf(runtime: CliRuntime, mk: MeetingKit, since: number, { own, teams }: RollUp): Promise<MergeDigestInput> {
  const pathOf = (rolled: RolledTeam): string => deliveryPlaces(rolled.config.delivery, rolled.paths).merges;
  const readAt = async (path: string): Promise<MergeLogAt> => ({ log: await new MergeLog(runtime.files, path).read(), path });
  const ownPath = pathOf(own);
  const seen = new Set([ownPath]);
  const below: RolledTeam[] = [];
  for (const rolled of teams) {
    const path = pathOf(rolled);
    if (!seen.has(path)) {
      seen.add(path);
      below.push(rolled);
    }
  }
  return {
    own: await readAt(ownPath),
    below: await Promise.all(below.map(async (rolled) => ({ team: rolled.team, ...(await readAt(pathOf(rolled))) }))),
    since,
    zone: mk.zone,
    gated: teams.some((rolled) => rolled.config.pushGuard.pushToProtected === 'gated'),
  };
}

/** The spotlight's error log, in the team's logs folder: the overlay runs hidden, so a failure shows only there. */
export const SPOTLIGHT_LOG = 'meeting-spotlight.log';

/** The range of the stats the agenda opens with: the last week, as `stats` reads by default. */
export const AGENDA_STATS_RANGE: StatsRange = '7d';

/**
 * The scoreboard's rows for the root team's ranked goals, over every register of its tree. A team with no ranked goal
 * reads no history: the done counts need the whole of it, and a meeting opens on this read.
 */
async function goalBoard(runtime: CliRuntime, mk: MeetingKit, { own, teams }: RollUp): Promise<GoalScore[]> {
  const goalsOf = async (rolled: RolledTeam): Promise<ReadonlyMap<string, Goal>> => new KitTreeGoals(runtime, rolled.paths, rolled.config).all();
  const goals = await goalsOf(own);
  if (![...goals.values()].some((goal) => goal.rank !== null)) {
    return [];
  }
  const board = await Promise.all(
    teams.map(
      async (rolled): Promise<BoardTeam> => ({
        team: rolled.team === own.team ? undefined : rolled.team,
        tasks: [...(await rolled.history()).state.tasks.values()],
        tree: taskTreeOf(rolled, runtime),
        goals: await goalsOf(rolled),
        ranking: rolled.ranking,
      }),
    ),
  );
  return goalScores(goals, board, mk.now);
}

/**
 * The agenda: the register's part (the goal scoreboard, then decisions and incidents, with those of every team under
 * the lead's, then late and done), the stats' top lines over the lead's tree (Health, flow, the days at the usage limit;
 * statsTopLines, the fold `stats` and the pane's Stats tab print), today's scheduled meetings and the missed ones, the
 * self-merges since the meeting before, the lead's inbox marked read, then the week's use and, under it, the planned
 * week's fit (as `plan` gives it).
 */
async function printAgenda(args: ParsedArgs, runtime: CliRuntime, mk: MeetingKit, phase: MeetingPhase): Promise<void> {
  const rolled = await meetingRegisters(runtime, mk);
  const { own, teams } = rolled;
  const { snapshot } = own;
  const since = agendaSince(previousEnd(phase), mk.now);
  const lines = agendaLines({
    ...decisionAgendaOf(rolled, runtime, mk.now),
    since,
    lead: mk.lead,
    command: KIT_NAME,
    board: await goalBoard(runtime, mk, rolled),
    runFiles: await readRunFiles(
      runtime,
      teams.flatMap((rolled) => [...rolled.snapshot.state.tasks.values()]),
    ),
  });
  lines.forEach((line) => runtime.out.stdout(line));
  statsTopLines(await foldStats(runtime, rolled, AGENDA_STATS_RANGE), own.team, teams.map((team) => team.team)).forEach((line) => runtime.out.stdout(line));
  runtime.out.stdout(`  each other section: ${KIT_NAME} stats --tree --session ${mk.lead} (new work, speed, delays, waits, bugs, people, goals, areas)`);
  const scheduled = await new MeetingSchedule(runtime.files, mk.kit.paths.meetings).read();
  agendaMeetingLines(scheduled.meetings, mk.zone, mk.now).forEach((line) => runtime.out.stdout(line));
  mergeDigestLines(await mergeDigestOf(runtime, mk, since, rolled)).forEach((line) => runtime.out.stdout(line));
  await read({ ...args, flags: new Map([['session', mk.lead]]) }, runtime);
  runtime.out.stdout(await weekLineOf(runtime, mk.kit, mk.config, mk.roster));
  const resets = resetSummaryLine(mk.config.budget.resets, mk.now, mk.zone, KIT_NAME);
  if (resets !== undefined) {
    runtime.out.stdout(resets);
  }
  const week = currentWeekOf(snapshot, new Date(mk.now), mk.zone);
  if (week !== null) {
    fitLines(await weekFitOf(runtime, { own, teams: [own] }, week, false)).forEach((line) => runtime.out.stdout(`  ${line}`));
  }
}

/**
 * `meeting start`: opens the meeting and prints the agenda; it posts no line, as the hook tells each sender it
 * holds. A meeting already open stays as it is: its agenda prints. With an id, `meeting start M3` starts a scheduled
 * meeting instead (meetings.ts).
 */
export async function meetingStart(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  if (args.positionals.length > 0) {
    return meetingStartScheduled(args, runtime);
  }
  const mk = await meetingKit(args, runtime, 'write');
  const phase = phaseOf(await mk.store.read(), mk.now);
  if (phase.kind === 'open') {
    runtime.out.stdout(`MEETING already open since ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))}: messages to ${mk.leadName} are held but CRITICAL ones`);
    await printAgenda(args, runtime, mk, phase);
    return EXIT.ok;
  }
  const before = stoppedAt(phase);
  const meeting: Meeting = { startedAt: new Date(mk.now).toISOString(), by: mk.lead, endedAt: null, since: before === undefined ? null : new Date(before).toISOString() };
  await mk.store.write(meeting);
  runtime.out.stdout(`MEETING started ${mk.zone.weekdayMinute(new Date(mk.now))}: messages to ${mk.leadName} are held but CRITICAL ones (the hook tells each sender)`);
  const spotlit: SpotlightPlace = {
    title: sessionDisplay(mk.kit.paths.team, mk.leadName),
    meetingFile: mk.kit.paths.meeting,
    meeting,
    breakthroughFile: mk.kit.paths.meetingBreakthrough,
    log: join(mk.kit.paths.logs, SPOTLIGHT_LOG),
  };
  const { spotlight } = mk.config.meeting;
  const line = spotlightLine(await startSpotlight(runtime, spotlight, mk.config.open.terminal, spotlit, runtime.cwd), spotlit, spotlight.dim);
  if (line !== undefined) {
    runtime.out.stdout(line);
  }
  await printAgenda(args, runtime, mk, { kind: 'open', meeting });
  runtime.out.stdout(`END ${KIT_NAME} meeting end --session ${mk.lead}: tells each session the decisions recorded on its tasks`);
  return EXIT.ok;
}

/** `meeting agenda`: the agenda now, during a meeting or to prepare the next one. */
export async function meetingAgenda(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const mk = await meetingKit(args, runtime, 'read');
  const phase = phaseOf(await mk.store.read(), mk.now);
  runtime.out.stdout(phaseLine(phase, mk));
  await printAgenda(args, runtime, mk, phase);
  return EXIT.ok;
}

/**
 * `meeting end`: closes the open meeting, or one that lapsed unended, and tells each session whose tasks the lead
 * updated during the meeting those updates (the decisions recorded) by one inbox line, in a team under the lead's
 * too (T1018); a session with none gets no line. `meeting end <id>` ends a scheduled meeting instead (meetings.ts).
 */
export async function meetingEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  if (args.positionals.length > 0) {
    return meetingEndScheduled(args, runtime);
  }
  if (args.flags.has('note')) {
    throw new UsageError('--note goes with meeting end <id>, a scheduled meeting; the daily meeting records its decisions on the tasks');
  }
  const mk = await meetingKit(args, runtime, 'write');
  const phase = phaseOf(await mk.store.read(), mk.now);
  if (phase.kind !== 'open' && phase.kind !== 'lapsed') {
    throw new RefusedError(`no meeting is open; ${KIT_NAME} meeting start opens one`);
  }
  const { meeting } = phase;
  await mk.store.write({ ...meeting, endedAt: new Date(mk.now).toISOString() });
  const { own, teams } = await meetingRegisters(runtime, mk);
  const startedAt = Date.parse(meeting.startedAt);
  const decided: Decided[] = teams.map((rolled) => {
    const below = rolled.team === own.team ? undefined : rolled.team;
    const { events } = rolled.snapshot.read;
    return { rolled, below, byOwner: decisionsByOwner(events, rolled.snapshot.state.tasks, decidedByOf(rolled, own, mk.lead), startedAt) };
  });
  let told = 0;
  for (const register of decided) {
    told += await tellDecided(runtime, mk, register);
  }
  const minutes = Math.round((mk.now - startedAt) / 60_000);
  runtime.out.stdout(`MEETING ended ${mk.zone.weekdayMinute(new Date(mk.now))} after ${minutes} min: messages to ${mk.leadName} go again; told ${told} session(s) the decisions on their tasks`);
  const recorded = decided.flatMap((register) => [...register.byOwner].flatMap(([owner, lines]) => lines.map((line) => `  ${sessionLabel(register, owner)} ${line}`)));
  runtime.out.stdout(
    recorded.length === 0
      ? `RECORDED nothing on another session's task during it: a decision the register lacks reaches no one (${KIT_NAME} update <id> --decided --note "..." --session ${mk.lead})`
      : `RECORDED ${recorded.length} decision(s), each told to its task's owner`,
  );
  recorded.forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}
