import { formatAddress } from '../../core/address.ts';
import type { AgendaTeam, DecisionAgenda } from '../../meeting/agenda.ts';
import type { RolledTeam, RollUp } from '../roll-up.ts';
import type { CliRuntime } from '../runtime.ts';
import { taskTreeOf } from './register.ts';

/**
 * The registers an owner's meeting covers, as the agenda and the meeting's agenda panel read them: the lead's own
 * and every team under it (subtreeOf), each on its own config and clock, so both list the same cards in one order.
 */

/** One register as the agenda reads its waits on the owner: its tasks, its tree and its own config's settings. */
export function agendaRegisterOf(rolled: RolledTeam, runtime: CliRuntime): Omit<AgendaTeam, 'team'> {
  return {
    tasks: [...rolled.snapshot.state.tasks.values()],
    tree: taskTreeOf(rolled, runtime),
    ownerMarker: rolled.config.register.ownerSource,
    requireGate: rolled.config.register.requireDecisionCard,
    focus: rolled.config.focus,
    dedicatedOwners: rolled.config.decisions.dedicatedOwners,
  };
}

/**
 * What the agenda asks the owner's cards from: the lead's register, each team under it, the day for the batch, and the
 * cards carried over (Meeting.carried, T2775), asked first.
 */
export function decisionAgendaOf({ own, teams }: RollUp, runtime: CliRuntime, now: number, carried: readonly string[]): DecisionAgenda {
  const below: AgendaTeam[] = [];
  const ownMeetings = new Map<string, AgendaTeam[]>();
  for (const rolled of teams.filter((team) => team.team !== own.team)) {
    const register = { team: rolled.team, ...agendaRegisterOf(rolled, runtime) };
    below.push(register);
    const meets = ownMeetingTeamOf(rolled.team, own, teams);
    if (meets !== undefined) {
      ownMeetings.set(meets, [...(ownMeetings.get(meets) ?? []), register]);
    }
  }
  return {
    ...agendaRegisterOf(own, runtime),
    below,
    now,
    improvementsDay: own.config.focus.improvementsDay,
    carried,
    ownMeetings: [...ownMeetings].map(([team, registers]) => ({ team, registers })),
  };
}

/**
 * The team of the lead's `decisions.ownMeetingTeams` (#1430) whose own meeting covers `team`: that team itself or the
 * one nearest the lead's above it; undefined when none does, so the lead's meeting asks its waits.
 */
function ownMeetingTeamOf(team: string, own: RolledTeam, teams: readonly RolledTeam[]): string | undefined {
  const parents = new Map(teams.map((rolled) => [rolled.team, rolled.above?.team]));
  const named = new Set(own.config.decisions.ownMeetingTeams);
  let meets: string | undefined;
  for (let at: string | undefined = team; at !== undefined && at !== own.team; at = parents.get(at)) {
    meets = named.has(at) ? at : meets;
  }
  return meets;
}

/** Who records the owner's decisions on a register: the lead by its id in its own team, by `<team>/<id>` in a team under it. */
export function decidedByOf(rolled: RolledTeam, own: RolledTeam, lead: string): string {
  return rolled.team === own.team ? lead : formatAddress({ team: own.team, id: lead });
}
