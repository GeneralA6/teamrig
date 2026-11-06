import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { meetCardLines } from '../../meeting/meet.ts';
import { meetAsk, meetPrompt } from '../../open/prompt.ts';
import { ownerCardsBySession, type OwnerCards } from '../../register/owner-waits.ts';
import type { TaskTree } from '../../register/tree.ts';
import { measureSessions, runningPlaces } from '../../sessions/measure.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, type FoundTeam, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRanking } from '../team-ranking.ts';
import { teamRegister } from '../team-register.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { openSession, printOpenResult, terminalFlag } from './open.ts';
import { taskTreeOf } from './register.ts';
import { sessionProjectOf } from './setup.ts';

/** The session met: its team, its kit, its id and name, its cards on the owner and the read of the register that holds them. */
interface MeetFacts {
  readonly found: FoundTeam;
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly id: string;
  readonly name: string;
  readonly cards: OwnerCards;
  readonly tree: TaskTree;
}

const NO_CARDS: OwnerCards = { due: [], later: [] };

/**
 * The session `ref` names (an id or a name) and its cards on the owner; refused when no card of it waits on the owner
 * now, naming the cards the owner put off and until when.
 */
async function meetFactsOf(runtime: CliRuntime, ref: string): Promise<MeetFacts> {
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, ref);
  const name = roster.nameOf(id) ?? id;
  const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
  const ranking = await teamRanking(runtime, kit.paths, config, snapshot.state.tasks.values());
  const tree = taskTreeOf({ snapshot, config, elsewhere, ranking }, runtime);
  const { ownerSource, requireDecisionCard } = config.register;
  const cards = ownerCardsBySession([...snapshot.state.tasks.values()], tree, ownerSource, requireDecisionCard).get(id) ?? NO_CARDS;
  if (cards.due.length === 0) {
    const later = cards.later.map((card) => `${card.task.id} until ${card.until}`);
    throw new RefusedError(`${name} (session ${id}) has no card waiting on ${ownerSource} now${later.length === 0 ? '' : `; put off: ${later.join(', ')}`}`);
  }
  return { found, kit, config, roster, id, name, cards, tree };
}

/** Whether the session's Claude Code runs now; refused when the host's processes cannot be listed. */
async function isRunning(runtime: CliRuntime, kit: Kit, roster: Roster, id: string): Promise<boolean> {
  // Every session's record: a later one on the same process (a /clear that bound the tab to it) wins it.
  const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
  const rows = await runtime.memory.processes();
  if (rows === undefined) {
    throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell whether ${id} runs`);
  }
  return runningPlaces(measureSessions(records, rows)).some((place) => place.id === id);
}

/** `meet --cards [--session <id|name>]`: the caller's cards due on the owner, and how to bring them and record each answer. */
async function meetCards(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`meet --cards prints the caller's own cards: it takes no "${extra}"`);
  }
  const { id, name, cards, tree, config } = await meetFactsOf(runtime, callerOf(args.flags, runtime.env));
  const lines = meetCardLines({ id, name, cards, tree, ownerMarker: config.register.ownerSource, command: KIT_NAME, askWith: config.decisions.askWith });
  lines.forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/**
 * `meet <id|name> [--terminal <name>] [--project <dir>]`: the owner meets one session on its cards waiting on them
 * (T1295). A running session gets an inbox line that wakes its tab; any other opens fresh in a new tab, its context
 * only the meeting. Both ask it to run `meet --cards`. Refused when no card of it waits on the owner now.
 */
export async function meet(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  if (args.switches.has('cards')) {
    return meetCards(args, runtime);
  }
  const facts = await meetFactsOf(runtime, onePositional(args, 'id|name'));
  const { found, kit, config, roster, id, name } = facts;
  const owner = config.register.ownerSource;
  if (await isRunning(runtime, kit, roster, id)) {
    const problem = await postUrgentLine(runtime, kit, config, { to: id, from: owner, text: meetAsk(id, owner) });
    if (problem !== undefined) {
      throw new RefusedError(`${name} (session ${id}) was not woken: ${problem}`);
    }
    runtime.out.stdout(`WOKE ${name} (session ${id}): ${facts.cards.due.length} card(s) waiting on ${owner}; an inbox line asks it to bring them now`);
    return EXIT.ok;
  }
  const terminal = terminalFlag(args.flags.get('terminal')) ?? config.open.terminal;
  const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
  const team = found.team;
  const opened = await openSession(runtime, kit, config, roster, { team, id, project, terminal, asked: false, fresh: true, prompt: meetPrompt(team, id, owner) });
  return printOpenResult(runtime, opened);
}
