import { KIT_NAME } from "../../core/home.js";
import { clearAdminRole, readAdminRole, setAdminRole } from "../../github/admin-store.js";
import { onePositional } from "../args.js";
import { sessionIdOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { refuseUnderClaudeCode } from "./owner.js";
import { openTeam } from "./register-team.js";
/** The word `owner github-admin` takes for "no session": a session id is never it (a roster lookup refuses it). */
export const NO_ADMIN = 'none';
/** The team's role store, over the runtime's files and credential store. */
export function adminStoreOf(runtime, team) {
    return { files: runtime.files, credentials: runtime.credentials, teamHome: team.paths.home, team: team.paths.team };
}
/** What the admin may act on, for the lines that name it. */
function reposText(team) {
    const repos = team.config.github.repos;
    return repos.length === 0 ? 'the repositories github.repos will list' : repos.join(', ');
}
/** The one line that says what a role read holds. */
export function adminLine(read, team) {
    switch (read.kind) {
        case 'admin':
            return `ADMIN ${read.role.session} is the GitHub admin of team ${team}, set ${read.role.setAt}`;
        case 'none':
            return `NONE team ${team} has no GitHub admin: each session acts only on its own issues, pull requests and branches`;
        case 'broken':
            return `BROKEN ${read.reason}; no session is admin until the owner runs ${KIT_NAME} owner github-admin <session> again`;
    }
}
/**
 * `owner github-admin <session|none>` (T2705): the owner names the one session of the team that may close, comment
 * on and delete any issue, pull request or branch of the team's repositories (github.repos); every other session acts
 * only on its own. It saves a fresh key in the credential store and writes the role file signed by it, so no session
 * can name itself by editing the file. `none` removes the role. Refused under CLAUDECODE, like every owner action:
 * the owner runs it in their own terminal or types it as /teamrig owner github-admin in a tab. Exit 1 when the key
 * could not be saved (the role stays as it was).
 */
export async function ownerGithubAdmin(args, runtime) {
    refuseUnderClaudeCode(runtime, 'github-admin');
    const named = onePositional(args, '<session|none>');
    const team = await openTeam(runtime, 'read');
    const store = adminStoreOf(runtime, team);
    const name = team.paths.team;
    if (named === NO_ADMIN) {
        const had = await clearAdminRole(store);
        runtime.out.stdout(had ? `CLEARED team ${name} has no GitHub admin now` : `NONE team ${name} had no GitHub admin; nothing changed`);
        return EXIT.ok;
    }
    const session = sessionIdOf(team.roster, named);
    const saved = await setAdminRole(store, session, new Date(runtime.clock.now()).toISOString());
    if (saved.kind === 'failed') {
        runtime.out.stdout(`FAILED the GitHub admin key was not saved: ${saved.reason}; the role is as it was`);
        return EXIT.failed;
    }
    runtime.out.stdout(`SET ${session} is the GitHub admin of team ${name}: it may close, comment on and delete any issue, pull request or branch of ${reposText(team)}; every other session only its own`);
    return EXIT.ok;
}
/** `gh admin` (T2705): prints the team's GitHub admin, none, or why the role reads broken (then no session is admin). */
export async function ghAdmin(_args, runtime) {
    const team = await openTeam(runtime, 'read');
    runtime.out.stdout(adminLine(await readAdminRole(adminStoreOf(runtime, team)), team.paths.team));
    return EXIT.ok;
}
