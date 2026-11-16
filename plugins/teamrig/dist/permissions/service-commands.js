/**
 * The teamrig commands a service role may hold (T2984), by name. A team's `serviceRoles` picks among these names and
 * adds none: each name stands for one call shape teamrig's own code reads, with typed slots instead of wildcards, so a
 * config never widens what a role lets run. A new name needs its shape and a security review in the same change.
 */
export const SERVICE_COMMANDS = ['issue close', 'issue comment'];
export function isServiceCommand(text) {
    return SERVICE_COMMANDS.some((name) => name === text);
}
/**
 * The commands whose own tool checks who calls them, so a role may give them to every session of the team
 * (`holders: "team"`). None yet: `issue close` and `issue comment` act as whoever runs them, so each needs named holders.
 */
export const TEAM_HELD_COMMANDS = new Set();
/**
 * What each command reaches on GitHub, which a grant shows the owner before and as it writes (T2984): GitHub numbers
 * issues and pull requests as one, so both commands act on any pull request of the team's repositories too, an outside
 * author's included, and a holder steered by outside text could close one with no prompt, up to the daily cap.
 */
export const SERVICE_COMMAND_REACH = {
    'issue close': "closes any issue or pull request of github.repos, an outside author's too (a pull request closes unmerged), posting its --comment first",
    'issue comment': "posts a comment on any issue or pull request of github.repos, an outside author's too",
};
