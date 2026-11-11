import type { EffortLevel, TerminalChoice } from '../config/types.ts';
import type { RestoreEntry } from './entry.ts';

/** A team as the restore sees it: its sessions and names, its lead, its terminal and who last read each inbox. */
export interface RestoreTeam {
  readonly team: string;
  readonly lead: string;
  /** Each current session's id and name. */
  readonly names: ReadonlyMap<string, string>;
  readonly terminal: TerminalChoice;
  /** Its sessions' tabs open in a window of the team's own (`open.teamWindow`). */
  readonly teamWindow: boolean;
  /** The session each Claude Code session last read the inbox of, from the team's inbox marks. */
  readonly areaBySession: ReadonlyMap<string, string>;
  /** The effort the config sets for each session (`launch.<id>.effort`); a session it leaves unset is not here. */
  readonly efforts: ReadonlyMap<string, EffortLevel>;
}

/** The team session a Claude Code session ran as. */
export interface TeamSession {
  readonly team: string;
  readonly session: string;
  readonly name: string;
  readonly isLead: boolean;
  readonly terminal: TerminalChoice;
  /** Its sessions' tabs open in a window of the team's own (`open.teamWindow`). */
  readonly teamWindow: boolean;
  /**
   * It ran under its team's variables, as `teamrig launch` starts one, so the restore reopens it through
   * launch. One known only from the inbox it read was started by hand, and is resumed as it was.
   */
  readonly launched: boolean;
  /**
   * The effort its team config sets (`launch.<id>.effort`): once set it is the one source of truth, so a restore after
   * a config change reopens it on the new level, never the one it last ran at (T2440). Undefined when unset.
   */
  readonly effort: EffortLevel | undefined;
}

function sessionOf(team: RestoreTeam, session: string, launched: boolean): TeamSession | undefined {
  const name = team.names.get(session);
  return name === undefined
    ? undefined
    : { team: team.team, session, name, isLead: session === team.lead, terminal: team.terminal, teamWindow: team.teamWindow, launched, effort: team.efforts.get(session) };
}

/**
 * The team session an entry belongs to: the team and session its variables name, when that team still has
 * the session, else the session whose inbox it last read. Undefined for a Claude Code session of no team.
 */
export function teamSessionOf(entry: RestoreEntry, teams: readonly RestoreTeam[]): TeamSession | undefined {
  const { team: teamId, session } = entry;
  const named = teams.find((team) => team.team === teamId);
  const launched = named === undefined || session === undefined ? undefined : sessionOf(named, session, true);
  if (launched !== undefined) {
    return launched;
  }
  for (const team of teams) {
    const area = team.areaBySession.get(entry.claudeSession);
    const found = area === undefined ? undefined : sessionOf(team, area, false);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
