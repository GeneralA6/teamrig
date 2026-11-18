import { teamPlace } from "../delivery/places.js";
import { claudeConfigDir } from "../core/home.js";
import { SecretScanner } from "../core/secrets.js";
import { KeepList } from "../permissions/allow-rules.js";
import { ownUntracked, settingsScope } from "../permissions/settings-scope.js";
import { planScope, wideAllowOf } from "../permissions/trim.js";
/**
 * The Claude Code settings files a team's sessions run under, for `permissions trim` and its flag in doctor and `check`
 * (which `start` shows the lead): the person's user settings, the project folder and each repository teamrig
 * merges into (`delivery.repos`), each with the worktrees Claude Code made in it.
 */
export async function teamSettingsScope(runtime, { paths, config, project }) {
    const repos = Object.values(config.delivery.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
    return projectsSettingsScope(runtime, claudeConfigDir(runtime.env, runtime.userHome), [project, ...repos]);
}
/** The settings files of the user and `projects` (`settingsScope`), each project `settings.json` its repository does not track read as the person's own (#837). */
export async function projectsSettingsScope(runtime, claudeDir, projects) {
    return ownUntracked(runtime.files, await settingsScope(runtime.files, claudeDir, projects, runtime.platform), (path) => settingsInGit(runtime, path));
}
/** git's word on a settings file through the kit's git runner (the team pointer's port): only `tracked` is committed; no repository or no answer is unknown. */
function settingsInGit(runtime, path) {
    switch (runtime.pointerGit.state(path).kind) {
        case 'tracked':
            return 'tracked';
        case 'ignored':
        case 'open':
            return 'untracked';
        case 'no-git':
            return 'unknown';
    }
}
/** The rules off the team's keep-list that approve a whole tool or program or hold a credential, in every file of its scope. */
export async function readWideAllow(runtime, input) {
    const { config } = input;
    const plans = await planScope(runtime.files, await teamSettingsScope(runtime, input), new KeepList(config.permissions.keepAllow), 'wide', new SecretScanner(config.register.secretPatterns));
    return wideAllowOf(plans);
}
