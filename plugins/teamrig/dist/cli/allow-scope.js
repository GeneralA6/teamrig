import { teamPlace } from "../coordinator/places.js";
import { claudeConfigDir } from "../core/home.js";
import { KeepList } from "../permissions/allow-rules.js";
import { settingsScope } from "../permissions/settings-scope.js";
import { planScope, wideAllowOf } from "../permissions/trim.js";
/**
 * The Claude Code settings files a team's sessions run under, for `permissions trim` and its flag in doctor and `check`
 * (which `start` shows the lead): the person's user settings, the project folder and each repository the coordinator
 * integrates (`coordinator.repos`), each with the worktrees Claude Code made in it.
 */
export async function teamSettingsScope(runtime, { paths, config, project }) {
    const repos = Object.values(config.coordinator.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
    return settingsScope(runtime.files, claudeConfigDir(runtime.env, runtime.userHome), [project, ...repos], runtime.platform);
}
/** The rules off the team's keep-list that approve a whole tool or program, in every file of its scope. */
export async function readWideAllow(runtime, input) {
    const plans = await planScope(runtime.files, await teamSettingsScope(runtime, input), new KeepList(input.config.permissions.keepAllow), 'wide');
    return wideAllowOf(plans);
}
