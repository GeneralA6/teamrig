/**
 * The session that hears the GitHub news no task owner takes (an outside pull request's news, a mention scan cut
 * short): `github.watcher`; else the first holder of a service role holding `issue close`, the session the owner
 * trusted to answer on GitHub (a close posts its comment; T3169 took the bare `issue comment` off every role), so the intake work lands where it is done; else the lead. Roles are read in name order,
 * as roleHolding reads them, so the pick never hangs on the config file's key order.
 */
export function githubWatcher(config) {
    return config.github.watcher ?? intakeHolder(config.serviceRoles) ?? config.roles.lead;
}
function intakeHolder(roles) {
    for (const name of Object.keys(roles).sort()) {
        const role = roles[name];
        // `issue close` needs named holders (TEAM_HELD_COMMANDS), so `team` never holds it; skipped all the same.
        if (role !== undefined && role.holders !== 'team' && role.commands.includes('issue close')) {
            return role.holders[0];
        }
    }
    return undefined;
}
