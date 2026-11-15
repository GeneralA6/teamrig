/**
 * The teamrig commands a service role may hold (T2984), by name. A team's `serviceRoles` picks among these names and
 * adds none: each name stands for one call shape teamrig's own code reads, with typed slots instead of wildcards, so a
 * config never widens what a role lets run. A new name needs its shape and a security review in the same change.
 */

/** The commands that act on an outside service as whoever runs them; a role's daily cap counts these (C6). */
export const ISSUE_COMMANDS = ['issue close', 'issue comment'] as const;

/** The queued runs of the team's ship tool (ship-role-call.ts): a ship, and a ship that merges. */
export const SHIP_COMMANDS = ['queue ship', 'queue merge'] as const;

export const SERVICE_COMMANDS = [...ISSUE_COMMANDS, ...SHIP_COMMANDS] as const;

/** One command a service role may hold. */
export type ServiceCommand = (typeof SERVICE_COMMANDS)[number];
export type IssueCommand = (typeof ISSUE_COMMANDS)[number];
export type ShipCommand = (typeof SHIP_COMMANDS)[number];

export function isServiceCommand(text: string): text is ServiceCommand {
  return SERVICE_COMMANDS.some((name) => name === text);
}

export function isIssueCommand(text: unknown): text is IssueCommand {
  return ISSUE_COMMANDS.some((name) => name === text);
}

/**
 * The commands whose own checks hold every caller to its own work, so a role may give them to every session of the team
 * (`holders: "team"`). A ship or merge runs only on a worktree whose task branch the tab's bound session owns, with the
 * team's ship tool from a clean checkout on main (ship-role-check.ts), and the tool clears a merge for that same
 * session alone (tools/ship/approval.ts). `issue close` and `issue comment` act as whoever runs them, so each needs
 * named holders.
 */
export const TEAM_HELD_COMMANDS: ReadonlySet<ServiceCommand> = new Set<ServiceCommand>(SHIP_COMMANDS);

/**
 * What each command reaches, which a grant shows the owner before and as it writes (T2984): GitHub numbers issues
 * and pull requests as one, so both issue commands act on any pull request of the team's repositories too, an outside
 * author's included, and a holder steered by outside text could close one with no prompt, up to the daily cap.
 */
export const SERVICE_COMMAND_REACH: Readonly<Record<ServiceCommand, string>> = {
  'issue close': "closes any issue or pull request of github.repos, an outside author's too (a pull request closes unmerged), posting its --comment first",
  'issue comment': "posts a comment on any issue or pull request of github.repos, an outside author's too",
  'queue ship': "queues the team's ship tool on a worktree of the holder's own task branch: it builds, checks and commits there, and pushes nothing",
  'queue merge': "queues the ship tool's merge of the holder's own task branch: it pushes the branch and merges its pull request once the head is approved",
};
