import type { KitConfig } from '../config/types.ts';
import { teamPlace } from '../delivery/places.ts';
import { claudeConfigDir, type TeamPaths } from '../core/home.ts';
import { SecretScanner } from '../core/secrets.ts';
import { KeepList } from '../permissions/allow-rules.ts';
import { ownUntracked, settingsScope, type SettingsFile, type SettingsInGit } from '../permissions/settings-scope.ts';
import { planScope, wideAllowOf, type WideAllow } from '../permissions/trim.ts';
import type { CliRuntime } from './runtime.ts';

/** Where a team's sessions run: its kit home, its config and the project folder (`projectFolder`). */
export interface AllowScopeInput {
  readonly paths: Pick<TeamPaths, 'home'>;
  readonly config: KitConfig;
  readonly project: string;
}

/**
 * The Claude Code settings files a team's sessions run under, for `permissions trim` and its flag in doctor and `check`
 * (which `start` shows the lead): the person's user settings, the project folder and each repository teamrig
 * merges into (`delivery.repos`), each with the worktrees Claude Code made in it.
 */
export async function teamSettingsScope(runtime: CliRuntime, { paths, config, project }: AllowScopeInput): Promise<SettingsFile[]> {
  const repos = Object.values(config.delivery.repos).map((repo) => teamPlace(paths, repo.mainCheckout));
  return projectsSettingsScope(runtime, claudeConfigDir(runtime.env, runtime.userHome), [project, ...repos]);
}

/** The settings files of the user and `projects` (`settingsScope`), each project `settings.json` its repository does not track read as the person's own (#837). */
export async function projectsSettingsScope(runtime: CliRuntime, claudeDir: string, projects: readonly string[]): Promise<SettingsFile[]> {
  return ownUntracked(runtime.files, await settingsScope(runtime.files, claudeDir, projects, runtime.platform), (path) => settingsInGit(runtime, path));
}

/** git's word on a settings file through the kit's git runner (the team pointer's port): only `tracked` is committed; no repository or no answer is unknown. */
function settingsInGit(runtime: CliRuntime, path: string): SettingsInGit {
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
export async function readWideAllow(runtime: CliRuntime, input: AllowScopeInput): Promise<WideAllow> {
  const { config } = input;
  const plans = await planScope(runtime.files, await teamSettingsScope(runtime, input), new KeepList(config.permissions.keepAllow), 'wide', new SecretScanner(config.register.secretPatterns));
  return wideAllowOf(plans);
}
