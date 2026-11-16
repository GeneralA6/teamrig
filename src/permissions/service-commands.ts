/**
 * The teamrig commands a service role may hold (T2984), by name. A team's `serviceRoles` picks among these names and
 * adds none: each name stands for one call shape teamrig's own code reads, with typed slots instead of wildcards, so a
 * config never widens what a role lets run. A new name needs its shape and a security review in the same change.
 */
export const SERVICE_COMMANDS = ['issue close', 'issue comment'] as const;

/** One command a service role may hold. */
export type ServiceCommand = (typeof SERVICE_COMMANDS)[number];

export function isServiceCommand(text: string): text is ServiceCommand {
  return SERVICE_COMMANDS.some((name) => name === text);
}

/**
 * The commands whose own tool checks who calls them, so a role may give them to every session of the team
 * (`holders: "team"`). None yet: `issue close` and `issue comment` act as whoever runs them, so each needs named holders.
 */
export const TEAM_HELD_COMMANDS: ReadonlySet<ServiceCommand> = new Set<ServiceCommand>();
