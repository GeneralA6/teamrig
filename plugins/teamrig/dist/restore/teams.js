function sessionOf(team, session, launched) {
    const name = team.names.get(session);
    return name === undefined
        ? undefined
        : { team: team.team, session, name, isLead: session === team.lead, terminal: team.terminal, teamWindow: team.teamWindow, launched, effort: team.efforts.get(session) };
}
/**
 * The team session an entry belongs to: the team and session its variables name, when that team still has
 * the session, else the session whose inbox it last read. Undefined for a Claude Code session of no team.
 */
export function teamSessionOf(entry, teams) {
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
